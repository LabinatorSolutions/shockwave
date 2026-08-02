// `/btw <question>` — ask ABOUT the chat rather than continuing it.
//
// This is deliberately NOT a turn. It's one short model call over the chat's
// stored messages, so it:
//   - works while the agent is mid-job (the whole point — "what are you doing?")
//   - never steers or interrupts that job
//   - never joins the conversation, so it can't pollute the agent's context
//   - touches no files and commits nothing
//
// It can see an in-flight job because messages are stored the moment pi finishes
// each one, rather than in a lump at the end of the turn.

import * as store from '../store.js';
import * as liveTool from '../liveTool.js';
import { chatWorkDir, chatFilesDir } from '../dataDirs.js';
import type { Db } from '../db.js';
import { resolveModel } from '../../../agent-core/agent.js';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { ModelRegistry, AuthStorage } from '@earendil-works/pi-coding-agent';

// Enough recent conversation to answer "what are you doing / what did we decide".
// A working turn spends two rows per tool call, so 40 covered about twenty
// commands — one busy turn, with the request that started it already pushed out
// of view. The character budget below is the real bound now, so the row count can
// be generous without risking the request size.
const MAX_MESSAGES = 120;
const MAX_CHARS_PER_MESSAGE = 1500;

// What the agent DID, not just what it said. A tool call's arguments and its
// output are both stored (`message.tool_calls` / `message.content`) and both used
// to be discarded here — every call rendered as a bare `[ran bash]`. That left
// the model a transcript of the conversation with the work removed, so "which
// directory / what command / what did it find" was unanswerable from data this
// function already had in hand.
//
// Tool output is bulky, so it gets its own smaller per-row cap, and the whole
// transcript gets a budget spent NEWEST-FIRST: when a working turn is long
// enough to overflow, the trimming falls on the oldest rows and the most recent
// work — which is what "what are you doing" is asking about — keeps its detail.
const MAX_CHARS_PER_TOOL = 500;
const MAX_TRANSCRIPT_CHARS = 24_000;

// Tools whose RESULT is a usable credential. Showing the work is the point of
// everything above, but this one returns the token itself (`agentTokens.ts`),
// and `/btw`'s answer goes straight out as a Telegram message — so its output is
// named and never quoted. The CALL is still shown: `get_agent_secret({"name":
// "github"})` says what the agent reached for, which is the useful half, and the
// name was never the secret. `list_agent_secrets` returns metadata only and is
// deliberately not on this list.
const SECRET_OUTPUT_TOOLS = new Set(['get_agent_secret']);

// The running tool can spew a large log; keep the TAIL, not the head — the newest
// lines (e.g. the latest count) are what "what's it doing now" needs.
const MAX_LIVE_TAIL_CHARS = 2000;

const PROMPT = [
  'You are answering a question ABOUT an ongoing conversation between a user and a coding agent.',
  'You are not the coding agent and you are not part of that conversation — you are looking at it from outside.',
  'The transcript shows the tools the agent ran, with the arguments it passed and the output it got back.',
  'Use those to answer concretely — the commands, paths, files and results are there.',
  'Answer only from the information below. If it does not say, say so plainly.',
  'Be brief and concrete: two or three sentences, plain text, no markdown.',
].join('\n');

function tail(s: string, max = MAX_LIVE_TAIL_CHARS): string {
  return s.length <= max ? s : `…${s.slice(-max)}`;
}

// Head, not tail: a command's output is identified by how it starts (the listing,
// the file, the error), where a STREAMING tool is identified by how it ends —
// which is why `tail` above is the opposite and stays that way.
function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function render(rows: any[]): string {
  const out: string[] = [];
  let budget = MAX_TRANSCRIPT_CHARS;
  for (let i = rows.length - 1; i >= 0 && budget > 0; i--) {
    const line = renderRow(rows[i]);
    if (!line) continue;
    const kept = clip(line, budget);
    out.push(kept);
    budget -= kept.length;
  }
  return out.reverse().join('\n');
}

function renderRow(r: any): string {
  if (r.role === 'tool') {
    const name = r.toolName ?? 'a tool';
    if (SECRET_OUTPUT_TOOLS.has(name)) return `[${name} returned a credential — not shown]`;
    const output = clip((r.content ?? '').trim(), MAX_CHARS_PER_TOOL);
    return output ? `[${name} returned]\n${output}` : `[ran ${name}]`;
  }
  const who = r.role === 'user' ? 'User' : 'Agent';
  const body = clip(r.content ?? '', MAX_CHARS_PER_MESSAGE);
  const calls = r.toolCalls ? ` [calling ${summariseCalls(r.toolCalls)}]` : '';
  return body || calls ? `${who}: ${body}${calls}` : '';
}

// `name(args)`. The arguments are the half that carries the path, the command and
// the pattern — the name alone says a tool ran and nothing about what it did.
function summariseCalls(json: string): string {
  try {
    const calls = JSON.parse(json) || [];
    const parts = calls.map((c: any) => `${c?.name ?? 'a tool'}(${clip(argsOf(c?.arguments), MAX_CHARS_PER_TOOL)})`);
    return parts.join(', ') || 'a tool';
  } catch { return 'a tool'; }
}

// pi hands arguments as an object; tolerate a pre-stringified one either way.
function argsOf(args: any): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args); } catch { return ''; }
}

/** Answer a question about a chat. Never throws — returns a readable message. */
export async function askAboutChat(
  db: Db, key: Buffer, chatId: string, question: string, busy: boolean,
): Promise<string> {
  try {
    const chat = await store.getChat(db, chatId);
    if (!chat) return "I can't find that chat.";

    const all = await store.getMessages(db, chatId);
    const recent = all.slice(-MAX_MESSAGES);
    const ws = (await store.listWorkspaces(db)).find((w) => w.id === chat.workspaceId);

    const settings = await store.readSettings(db, key);
    const ca = settings.codingAgent ?? {};
    const apiKey = (ca.providerKeys ?? {})[ca.provider] ?? '';
    if (!ca.provider || !ca.model) return 'No model is configured — set one in the desktop app.';

    const model = await resolveModel(ca.provider, ca.model);
    if (!model) return `The configured model (${ca.model}) is not available.`;

    // The two paths are pure path math (`dataDirs.ts`), so naming them costs no
    // I/O — and "where are you working" has no answer anywhere in the transcript.
    const facts = [
      `Chat title: ${chat.title ?? 'untitled'}`,
      `Workspace: ${ws?.name ?? 'unknown'}`,
      `The agent's working directory for this chat (the git checkout): ${chatWorkDir(chatId)}`,
      `The agent's scratch folder for this chat (not committed): ${chatFilesDir(chatId)}`,
      `Messages so far: ${all.length}`,
      `Right now the agent is: ${busy ? 'working on a job' : 'idle'}`,
    ].join('\n');

    // A tool that is CURRENTLY streaming has no stored row yet — the transcript
    // above can't show it. Splice in its live output so "what's it doing / what
    // number is it on" is answerable mid-run.
    const running = busy ? liveTool.current(chatId) : null;
    const liveBlock = !running || !running.output.trim()
      ? ''
      : SECRET_OUTPUT_TOOLS.has(running.toolName)
        ? `\n\n--- TOOL RUNNING RIGHT NOW: ${running.toolName} (its output is a credential — not shown) ---`
        : `\n\n--- TOOL RUNNING RIGHT NOW (${running.toolName}) — its output so far ---\n${tail(running.output)}`;

    const auth = AuthStorage.inMemory();
    auth.setRuntimeApiKey(ca.provider, apiKey);
    const registry = ModelRegistry.create(auth);
    const creds = await registry.getApiKeyAndHeaders(model);
    if (!creds?.ok) return 'I could not reach the model.';

    const res = await completeSimple(
      model,
      { messages: [{ role: 'user', content: `${PROMPT}\n\n--- FACTS ---\n${facts}\n\n--- TRANSCRIPT ---\n${render(recent)}${liveBlock}\n\n--- QUESTION ---\n${question}`, timestamp: Date.now() }] },
      { apiKey: creds.apiKey, headers: creds.headers, env: creds.env, maxTokens: 400 },
    );
    const text = (res?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('').trim();
    return text || "I couldn't answer that.";
  } catch (e: any) {
    return `Couldn't answer that: ${e?.message ?? e}`;
  }
}
