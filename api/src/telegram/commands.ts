// Telegram slash commands. Each one answers in-chat and runs NO agent turn — the
// exception is /btw, which asks a throwaway question about the chat (see below).
//
// Numbers in /chat and /workspace refer to positions in the list the matching
// plural command printed, so the two always have to agree on ordering and limit.

import * as store from '../store.js';
import type { Db } from '../db.js';
import type { TelegramClient } from './client.js';
import { askAboutChat } from './btw.js';

export const BOT_COMMANDS = [
  { command: 'new', description: 'Start a fresh chat in the same workspace' },
  { command: 'chats', description: 'List recent chats' },
  { command: 'chat', description: 'Switch chat: /chat 2' },
  { command: 'workspaces', description: 'List workspaces' },
  { command: 'workspace', description: 'Switch workspace (starts a fresh chat): /workspace 2' },
  { command: 'btw', description: 'Ask about this chat without interrupting it' },
  { command: 'status', description: 'Workspace, chat, and whether the agent is busy' },
  { command: 'help', description: 'What this bot can do' },
];

const LIST_LIMIT = 20;

const HELP = [
  'I run a coding agent on your workspace — a GitHub repo checked out on the server.',
  'Send me anything and the agent works on it: reading and editing your files, running commands, answering questions. Its changes are committed and pushed when it finishes.',
  'You can also send a voice note instead of typing.',
  '',
  'Commands:',
  '/new — start a fresh chat in the same workspace',
  '/chats — list recent chats',
  '/chat 2 — switch to chat 2 and carry on where it left off',
  '/workspaces — list workspaces',
  '/workspace 2 — switch workspace (starts a fresh chat there)',
  '/btw <question> — ask about this chat itself; works while the agent is busy and does not interrupt it',
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
  return `${Math.floor(hrs / 24)}d ago`;
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
      const lines = all.map((w, i) => `${i + 1}. ${w.name}${w.id === current?.id ? '  ← current' : ''}`);
      await reply(['Workspaces:', ...lines, '', 'Switch with /workspace 2'].join('\n'));
      return true;
    }

    case 'workspace': {
      const all = await store.listWorkspaces(db);
      const idx = parseIndex(rest[0], all.length);
      if (idx == null) { await reply('Usage: /workspace 2 — see /workspaces for the list.'); return true; }
      const target = all[idx];
      await store.setTelegramActiveWorkspace(db, target.id);
      await reply(`Switched to ${target.name}. Fresh chat started — send a message to begin.`);
      return true;
    }

    case 'chats': {
      const ws = await activeWorkspace(db);
      if (!ws) { await reply('No workspace is set. Try /workspaces.'); return true; }
      const chats = await store.listChats(db, ws.id, { limit: LIST_LIMIT });
      if (!chats.length) { await reply('No chats yet in this workspace. Send a message to start one.'); return true; }
      const lines = chats.map((c, i) =>
        `${i + 1}. ${c.title ?? 'Untitled'}${c.id === acc?.activeChatId ? '  ← current' : ''}  (${ago(c.updatedAt)})`);
      await reply([`Chats in ${ws.name}:`, ...lines, '', 'Switch with /chat 2'].join('\n'));
      return true;
    }

    case 'chat': {
      const ws = await activeWorkspace(db);
      if (!ws) { await reply('No workspace is set. Try /workspaces.'); return true; }
      const chats = await store.listChats(db, ws.id, { limit: LIST_LIMIT });
      const idx = parseIndex(rest[0], chats.length);
      if (idx == null) { await reply('Usage: /chat 2 — see /chats for the list.'); return true; }
      const target = chats[idx];
      await store.setTelegramActiveChat(db, target.id);
      await reply(`Switched to: ${target.title ?? 'Untitled'}  (${ws.name})\nCarry on — I have the whole conversation.`);
      return true;
    }

    case 'status': {
      const ws = await activeWorkspace(db);
      const chat = acc?.activeChatId ? await store.getChat(db, acc.activeChatId) : null;
      const busy = chat && isBusy(chat.id);
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
