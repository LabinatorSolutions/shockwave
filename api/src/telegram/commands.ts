// Telegram slash commands. Each one answers in-chat and runs NO agent turn — the
// exception is /btw, which asks a throwaway question about the chat (see below).
//
// Numbers in /chat and /workspace refer to positions in the list the matching
// plural command printed, so the two always have to agree on ordering and limit.

import * as store from '../store.js';
import type { Db } from '../db.js';
import type { TelegramClient } from './client.js';
import { askAboutChat } from './btw.js';
import {
  isVoiceReply, VOICE_REPLY_LABELS, VOICE_REPLY_MODES, type VoiceReply,
} from '../../../agent-core/voiceReply.js';
import { resolveChatNotice, type ChatNotice } from '../../../agent-core/chatNotice.js';

// The popup menu is a picker, not documentation — every description is verb-first,
// never repeats its own command name, and never cross-references another one. The
// syntax for the two that take an argument lives in /help and in their usage reply.
export const BOT_COMMANDS = [
  { command: 'new', description: 'Start a fresh chat' },
  { command: 'btw', description: 'Ask about this chat' },
  { command: 'status', description: 'Show workspace, chat, agent' },
  { command: 'help', description: 'Show what I can do' },
  { command: 'chats', description: 'List recent chats' },
  { command: 'chat', description: 'Switch chat by number' },
  { command: 'workspaces', description: 'List all workspaces' },
  { command: 'workspace', description: 'Switch workspace by number' },
  { command: 'voice', description: 'Reply with text, voice, or both' },
];

const LIST_LIMIT = 20;

const HELP = [
  'I run a coding agent on your workspace — a GitHub repo checked out on the server.',
  'Send me anything and the agent works on it: reading and editing your files, running commands, answering questions. Its changes are committed and pushed when it finishes.',
  'You can also send a voice note instead of typing.',
  '',
  'Reply to any message of mine to carry on in the chat it came from — I switch to it, and to its workspace, before answering.',
  '',
  'Commands:',
  '/new — start a fresh chat in the same workspace',
  '/chats — list recent chats',
  '"/chat <number>" — switch to that chat from /chats and carry on where it left off',
  '/workspaces — list workspaces',
  '"/workspace <number>" — switch to that workspace from /workspaces (starts a fresh chat there)',
  '/btw <question> — ask about this chat itself; works while the agent is busy and does not interrupt it',
  '"/voice <text|voice|both>" — how I reply in this workspace; on its own it shows the current setting',
  '/status — which workspace and chat, and whether the agent is working',
  '/help — this',
].join('\n');

/** Which workspace Telegram runs against: the switchable one, else the first
 * workspace by sort_order — i.e. the top of the desktop's workspace list, so
 * the default is chosen from the desktop by reordering, not by env var. */
export async function activeWorkspace(db: Db) {
  const acc = await store.getTelegramAccount(db);
  const all = await store.listWorkspaces(db);
  return all.find((w) => w.id === acc?.activeWorkspaceId) ?? all[0] ?? null;
}

/** 1-based index from a command argument; null when absent or out of range. */
function parseIndex(arg: string | undefined, length: number): number | null {
  const n = Number.parseInt(arg ?? '', 10);
  if (!Number.isInteger(n) || n < 1 || n > length) return null;
  return n - 1;
}

function ago(ts: number | null | undefined): string {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

// How many of each kind `/chat <number>` can reach. Pinned sit BELOW recent so
// the recent ones keep 1..10 — the catching-up notice only ever lists recent
// chats, and numbering it from 1 is worth more than numbering pinned from 1.
const RECENT_LIMIT = 10;
const PINNED_LIMIT = 3;

/**
 * The one numbered list. `index + 1` IS the `/chat <number>` argument, so
 * `/chats`, `/chat n` and the catching-up notice all read positions off this
 * and cannot disagree about them.
 *
 * The active chat is excluded: it is printed above the list as "Current chat",
 * and a number that switches you to where you already are is a broken row, not
 * a harmless one. `listChats` already filters pinned out, so the two halves
 * never contain the same chat twice.
 */
export async function switchableChats(db: Db, workspaceId: string, activeChatId: string | null | undefined) {
  const [recent, pinned] = await Promise.all([
    store.listChats(db, workspaceId, { limit: LIST_LIMIT }),
    store.listPinned(db, workspaceId),
  ]);
  const notActive = (c: { chatId: string }) => c.chatId !== activeChatId;
  return [
    ...recent.filter(notActive).slice(0, RECENT_LIMIT).map((c) => ({ ...c, isPinned: false })),
    ...pinned.filter(notActive).slice(0, PINNED_LIMIT).map((c) => ({ ...c, isPinned: true })),
  ];
}

/**
 * "3 new chats since we last talked" — sent before the turn when a chat is
 * picked back up after a gap.
 *
 * The bot answers in whichever chat it was last left in, and that chat is sticky
 * forever, so a message sent after a week away lands in a week-old conversation
 * with nothing on screen to say so. This is the only thing that says so.
 *
 * Null whenever there is nothing worth interrupting for — switched off, the chat
 * isn't actually stale, or nothing moved while you were away. Every number in it
 * is a real `/chat` argument (see `switchableChats`), and the count is the count
 * of rows printed, so there is nothing for the reader to reconcile.
 */
export async function chatNotice(
  db: Db, activeChatId: string, cfg: ChatNotice | undefined,
): Promise<string | null> {
  const { enabled, afterHours, limit } = resolveChatNotice(cfg);
  if (!enabled) return null;

  const chat = await store.getChat(db, activeChatId);
  if (!chat?.updatedAt) return null;
  if (Date.now() - chat.updatedAt < afterHours * 3_600_000) return null;

  // The chat's OWN workspace, not the active one: they are the same in the
  // ordinary case, and where they differ the numbers have to match the /chats
  // this chat would print, not some other repo's.
  //
  // Pinned chats are deliberate and long-lived — they are not what you drifted
  // away from — so they never appear here, even though they hold numbers.
  // **Created** since, not updated since. A chat is "new" when it came into
  // existence — an old conversation someone replied to is recent, not new, and
  // listing it as one sends you looking for something you have already seen.
  // What is worth interrupting for is a thread you started somewhere else and
  // haven't laid eyes on from here.
  //
  // The anchor stays `updatedAt` on both sides of the comparison: "since we last
  // talked" is when THIS chat was last active, not when it was opened.
  const list = await switchableChats(db, chat.workspaceId, activeChatId);
  const newer = list.filter((c) => !c.isPinned && (c.createdAt ?? 0) > chat.updatedAt!);
  if (!newer.length) return null;

  // The age shown is LAST ACTIVITY, not age since creation — these are the same
  // rows, with the same numbers, that /chats prints, and a timestamp meaning one
  // thing there and another here is the confusion this whole message exists to
  // avoid. It is also the more useful of the two: it says which of them is live.
  const shown = newer.slice(0, limit);
  return [
    `${shown.length} new chat${shown.length === 1 ? '' : 's'} since we last talked:`,
    ...shown.map((c) => `${list.indexOf(c) + 1}. ${c.title ?? 'Untitled'} (${ago(c.updatedAt)})`),
    '',
    '/chat <number> if you want to switch',
  ].join('\n');
}

/**
 * Handle a slash command. Returns true when `text` was a command (and has been
 * answered), false when it's an ordinary prompt the caller should run as a turn.
 */
export async function handleCommand(
  db: Db, key: Buffer, client: TelegramClient, dm: number, text: string, isBusy: (chatId: string) => boolean,
): Promise<boolean> {
  if (!text.startsWith('/')) return false;
  const [raw, ...rest] = text.slice(1).trim().split(/\s+/);
  const cmd = raw.toLowerCase().split('@')[0]; // strip @botname
  const reply = (m: string) => client.sendMessage(dm, m);
  const acc = await store.getTelegramAccount(db);

  switch (cmd) {
    case 'start':
    case 'help': {
      const ws = await activeWorkspace(db);
      await reply(ws ? `🗂 Workspace: ${ws.name}\n\n${HELP}` : HELP);
      return true;
    }

    case 'new': {
      await store.setTelegramActiveChat(db, null);
      const ws = await activeWorkspace(db);
      await reply(`🆕 Fresh chat${ws ? ` in ${ws.name}` : ''}. Send your next message to begin.`);
      return true;
    }

    case 'workspaces': {
      const all = await store.listWorkspaces(db);
      if (!all.length) { await reply('No workspaces yet. Add one in the desktop app.'); return true; }
      const current = await activeWorkspace(db);
      const others = all.filter((w) => w.id !== current?.id).slice(0, 10);
      const lines = others.map((w, i) => `${i + 1}. ${w.name}`);
      await reply(['Current workspace:', `${current?.name ?? '(none)'}`, '', 'Other workspaces:', ...lines, '', 'Switch with "/workspace <number>"'].join('\n'));
      return true;
    }

    case 'workspace': {
      const all = await store.listWorkspaces(db);
      const current = await activeWorkspace(db);
      const others = all.filter((w) => w.id !== current?.id).slice(0, 10);
      const idx = parseIndex(rest[0], others.length);
      if (idx == null) { await reply('Usage: /workspace <number> — see /workspaces for the list.'); return true; }
      const target = others[idx];
      await store.setTelegramActiveWorkspace(db, target.id);
      await reply(`Switched to ${target.name}. Fresh chat started — send a message to begin.`);
      return true;
    }

    case 'voice': {
      // Answered from the database like every other command — no checkout, no
      // turn, no agent. That is the whole reason the mode lives on the workspace
      // row rather than in the workspace's own files.
      const ws = await activeWorkspace(db);
      if (!ws) { await reply('No workspace is set. Try /workspaces.'); return true; }

      const arg = (rest[0] ?? '').toLowerCase();
      if (!arg) {
        await reply([
          `I reply with ${VOICE_REPLY_LABELS[ws.voiceReply]} in ${ws.name}.`,
          '',
          `Change it with ${VOICE_REPLY_MODES.map((m) => `/voice ${m}`).join(', ')}.`,
        ].join('\n'));
        return true;
      }
      // Name what IS allowed rather than only what wasn't — a bare "unknown
      // option" makes the user go and find /help for a three-item list.
      if (!isVoiceReply(arg)) {
        await reply(`"${arg}" isn't one of them. Try ${VOICE_REPLY_MODES.map((m) => `/voice ${m}`).join(', ')}.`);
        return true;
      }

      // `setVoiceReply` announces on the feed itself, so the desktop learns about
      // this without having asked — see `announce` in store.ts.
      await store.setVoiceReply(db, ws.id, arg as VoiceReply);
      await reply(`Replying with ${VOICE_REPLY_LABELS[arg as VoiceReply]} in ${ws.name} from now on.`);
      return true;
    }

    case 'chats': {
      const ws = await activeWorkspace(db);
      if (!ws) { await reply('No workspace is set. Try /workspaces.'); return true; }
      const list = await switchableChats(db, ws.id, acc?.activeChatId);
      // Read the current chat directly rather than looking it up in the list —
      // it was filtered out of it, and a pinned one was never in it to begin with.
      const current = acc?.activeChatId ? await store.getChat(db, acc.activeChatId) : null;
      if (!list.length && !current) { await reply('No chats yet in this workspace. Send a message to start one.'); return true; }
      // Numbers run continuously across both sections, so a section is only a
      // heading — dropping an empty one changes nothing about the numbering.
      const row = (c: (typeof list)[number]) => `${list.indexOf(c) + 1}. ${c.title ?? 'Untitled'}  (${ago(c.updatedAt)})`;
      const recent = list.filter((c) => !c.isPinned);
      const pinned = list.filter((c) => c.isPinned);
      await reply([
        'Current chat:', `${current?.title ?? '(none)'}`,
        ...(recent.length ? ['', 'Recent:', ...recent.map(row)] : []),
        ...(pinned.length ? ['', '📌 Pinned:', ...pinned.map(row)] : []),
        ...(list.length ? ['', 'Switch with "/chat <number>"'] : []),
      ].join('\n'));
      return true;
    }

    case 'chat': {
      const ws = await activeWorkspace(db);
      if (!ws) { await reply('No workspace is set. Try /workspaces.'); return true; }
      const list = await switchableChats(db, ws.id, acc?.activeChatId);
      const idx = parseIndex(rest[0], list.length);
      if (idx == null) { await reply('Usage: /chat <number> — see /chats for the list.'); return true; }
      const target = list[idx];
      await store.setTelegramActiveChat(db, target.chatId);
      await reply(`Switched to: ${target.title ?? 'Untitled'}  (${ws.name})\nCarry on — I have the whole conversation.`);
      return true;
    }

    case 'status': {
      const ws = await activeWorkspace(db);
      const chat = acc?.activeChatId ? await store.getChat(db, acc.activeChatId) : null;
      const busy = chat && isBusy(chat.chatId);
      await reply([
        `Workspace: ${ws ? ws.name : '(none set — try /workspaces)'}`,
        `Chat: ${chat ? (chat.title ?? 'Untitled') : 'new on your next message'}`,
        `Agent: ${busy ? 'working right now' : 'idle'}`,
        `Model: ${chat?.model ?? '(set in the desktop app)'}`,
      ].join('\n'));
      return true;
    }

    case 'btw': {
      const question = rest.join(' ').trim();
      if (!question) { await reply('Usage: /btw what are you working on?'); return true; }
      if (!acc?.activeChatId) { await reply('No chat yet — send a message first.'); return true; }
      await client.sendChatAction(dm).catch(() => {});
      const answer = await askAboutChat(db, key, acc.activeChatId, question, !!isBusy(acc.activeChatId));
      await reply(answer);
      return true;
    }

    default:
      await reply(`I don't know /${cmd}.\n\n${HELP}`);
      return true;
  }
}
