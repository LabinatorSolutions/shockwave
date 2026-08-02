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

// Enough recent conversation to answer "what are you doing / what did we decide",
// bounded so a long chat can't blow up the request.
const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 1500;

// Tools whose RESULT is a usable credential — `get_agent_secret` returns the
// token itself (`agentTokens.ts`), and this answer goes straight out as a
// Telegram message. A NAME MATCH, not a judgement: the output is never read into
// the prompt, so there is nothing for the model to decide. `list_agent_secrets`
// returns metadata only and is deliberately not on this list.
const SECRET_OUTPUT_TOOLS = new Set(['get_agent_secret']);

// The running tool can spew a large log; keep the TAIL, not the head — the newest
// lines (e.g. the latest count) are what "what's it doing now" needs.
const MAX_LIVE_TAIL_CHARS = 2000;

// The role, stated as what this IS. The next message is the question, so this
// says so — it sets up a reader who has been handed a conversation and is about
// to be asked about it, rather than an assistant wondering what the wall of text
// in front of it is for.
const ROLE = [
  'You are an observer of an ongoing conversation between a user and a coding agent.',
  'You have been given that conversation, and the message after this one is the user asking you about it — what the agent is doing, what was decided, where things stand.',
  'Answer from what you were given. If it does not say, say so plainly.',
  'Be brief and concrete: two or three sentences, plain text, no markdown.',
].join('\n');

function tail(s: string, max = MAX_LIVE_TAIL_CHARS): string {
  return s.length <= max ? s : `…${s.slice(-max)}`;
}

function render(rows: any[]): string {
  return rows.map((r) => {
    if (r.role === 'tool') return `[ran ${r.toolName ?? 'a tool'}]`;
    const who = r.role === 'user' ? 'User' : 'Agent';
    const body = (r.content ?? '').slice(0, MAX_CHARS_PER_MESSAGE);
    const calls = r.toolCalls ? ` [calling ${summariseCalls(r.toolCalls)}]` : '';
    return body || calls ? `${who}: ${body}${calls}` : '';
  }).filter(Boolean).join('\n');
}

function summariseCalls(json: string): string {
  try { return (JSON.parse(json) || []).map((c: any) => c.name).join(', ') || 'a tool'; }
  catch { return 'a tool'; }
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

    // The role and the conversation are the SETUP, so they go in the system
    // prompt; the user message is the question and nothing else. Both used to be
    // one user turn, which left the instructions competing for attention with the
    // transcript they were meant to be read against.
    const res = await completeSimple(
      model,
      {
        systemPrompt: `${ROLE}\n\n--- FACTS ---\n${facts}\n\n--- THE CONVERSATION ---\n${render(recent)}${liveBlock}`,
        messages: [{ role: 'user', content: `Here is the question: ${question}`, timestamp: Date.now() }],
      },
      { apiKey: creds.apiKey, headers: creds.headers, env: creds.env, maxTokens: 400 },
    );
    const text = (res?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('').trim();
    return text || "I couldn't answer that.";
  } catch (e: any) {
    return `Couldn't answer that: ${e?.message ?? e}`;
  }
}
