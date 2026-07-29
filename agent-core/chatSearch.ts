// `search_chats` — the agent's memory of past conversations in this workspace.
//
// One tool, three uses, picked from which arguments arrive (no mode flag):
//
//   query            → SEARCH. Returns whole CONVERSATIONS, not a pile of
//                      matching lines: the hit, the messages either side of it,
//                      and the opening and closing of that chat. A match in the
//                      middle of a conversation means nothing on its own — the
//                      opening says what it was about, the ending how it landed.
//   chatId + around  → READ. A window of messages centred on a position. Pass
//                      the last position you were given to keep going forward,
//                      the first to go back.
//   (nothing)        → LIST. Recent chats.
//
// No model calls anywhere: every shape returns stored messages verbatim.
//
// Deliberately excluded: tool output (a directory listing is most of the bytes
// and none of the meaning) and the current chat (you can already see it).

export interface ChatSearchHost {
  /** Conversations matching `query`, each already carrying its context window. */
  searchChats(opts: {
    workspaceId: string; query: string; limit: number;
    sort?: 'newest' | 'oldest'; excludeChatId?: string;
  }): Promise<any[]>;
  /** A window of messages around `around` (or the tail when it's absent). */
  readChat(opts: { chatId: string; around?: number; window: number }): Promise<any>;
  /** Recent chats in the workspace. */
  recentChats(opts: { workspaceId: string; limit: number; excludeChatId?: string }): Promise<any[]>;
}

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const DEFAULT_WINDOW = 5;
const MAX_WINDOW = 20;

function when(ts: number | null | undefined): string {
  if (!ts) return 'unknown';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  const date = new Date(ts).toISOString().slice(0, 10);
  if (days <= 0) return `today (${date})`;
  if (days === 1) return `yesterday (${date})`;
  if (days < 30) return `${days} days ago (${date})`;
  return date;
}

function line(m: any): string {
  if (m.role === 'tool') return `    [ran ${m.toolName ?? 'a tool'}]`;
  const who = m.role === 'user' ? 'User' : 'Agent';
  const body = String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 300);
  return body ? `    ${who}: ${body}` : '';
}

function block(label: string, rows: any[]): string[] {
  const body = rows.map(line).filter(Boolean);
  return body.length ? [`  ${label}:`, ...body] : [];
}

export function makeChatSearchTool(host: ChatSearchHost, ctx: () => { workspaceId: string; chatId: string }): any {
  return {
    name: 'search_chats',
    label: 'Search Chats',
    description: [
      'Search earlier conversations in this workspace — what the user told you before, what was decided, what you already tried.',
      'Three ways to call it: pass `query` to search; pass `chatId` and `around` to read more of a chat you found; pass nothing to list recent chats.',
      'Search returns whole conversations, each with the matching passage, the messages around it, and how that chat opened and ended.',
      'Only what the user and the agent said is searched — tool output is not. The current chat is never returned; you can already see it.',
      'Every result carries its date. Prefer recent conversations when they disagree — an older one may have been superseded.',
    ].join(' '),
    promptSnippet: 'Search past chats in this workspace for context, decisions, or things already tried.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for. Words or a phrase. Omit to list recent chats.' },
        limit: { type: 'integer', description: `Conversations to return when searching. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}. Raise it when a topic likely spans several chats.` },
        sort: { type: 'string', enum: ['newest', 'oldest'], description: 'Bias the search by time. Omit for best-match order. "newest" for "where did we leave X", "oldest" for "how did X start".' },
        chatId: { type: 'string', description: 'Read inside this chat. Use an id from a previous result. Pair with `around`.' },
        around: { type: 'integer', description: 'Position to centre the window on. Pass the last position you were shown to read forward, the first to read back. Omit for the end of the chat.' },
        window: { type: 'integer', description: `Messages either side when reading. Default ${DEFAULT_WINDOW}, max ${MAX_WINDOW}.` },
      },
      additionalProperties: false,
    },
    async execute(_id: string, params: any = {}) {
      const { workspaceId, chatId: current } = ctx();
      try {
        if (params.chatId) {
          const win = Math.min(Math.max(Number(params.window) || DEFAULT_WINDOW, 1), MAX_WINDOW);
          const view = await host.readChat({
            chatId: String(params.chatId),
            around: params.around != null ? Number(params.around) : undefined,
            window: win,
          });
          if (!view?.messages?.length) {
            return { content: [{ type: 'text', text: 'Nothing there — that chat or position has no messages.' }] };
          }
          const head = [`${view.title ?? 'Untitled'} — ${when(view.updatedAt)}`,
            `positions ${view.first}–${view.last} of ${view.total}`];
          const body = view.messages.map((m: any) => `  [${m.seq}] ${line(m).trim()}`);
          return {
            content: [{ type: 'text', text: [...head, ...body].join('\n') }],
            details: { chatId: params.chatId, first: view.first, last: view.last, total: view.total },
          };
        }

        if (params.query) {
          const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
          const hits = await host.searchChats({
            workspaceId, query: String(params.query), limit,
            sort: params.sort === 'newest' || params.sort === 'oldest' ? params.sort : undefined,
            excludeChatId: current,
          });
          if (!hits.length) {
            return { content: [{ type: 'text', text: `No earlier chat mentions "${params.query}".` }], details: { count: 0 } };
          }
          const out: string[] = [];
          for (const h of hits) {
            out.push(`${h.title ?? 'Untitled'} — ${when(h.updatedAt)}  (chatId: ${h.chatId}, ${h.total} messages)`);
            out.push(...block('opened with', h.opening));
            out.push(...block(`match at position ${h.matchSeq}`, h.around));
            out.push(...block('ended with', h.closing));
            out.push('');
          }
          out.push('Read more of one with chatId + around.');
          return { content: [{ type: 'text', text: out.join('\n') }], details: { count: hits.length, chatIds: hits.map((h) => h.chatId) } };
        }

        const limit = Math.min(Math.max(Number(params.limit) || MAX_LIMIT, 1), MAX_LIMIT);
        const recent = await host.recentChats({ workspaceId, limit, excludeChatId: current });
        if (!recent.length) return { content: [{ type: 'text', text: 'No other chats in this workspace yet.' }] };
        const text = recent.map((c) => `- ${c.title ?? 'Untitled'} — ${when(c.updatedAt)} (chatId: ${c.chatId}, ${c.total} messages)`).join('\n');
        return { content: [{ type: 'text', text: `Recent chats:\n${text}` }], details: { count: recent.length } };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Chat search failed: ${e?.message ?? e}` }], isError: true };
      }
    },
  };
}
