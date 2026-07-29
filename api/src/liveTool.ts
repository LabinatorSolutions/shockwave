// What a tool is printing RIGHT NOW, held per chat in memory only.
//
// A running tool's output isn't in the database until it finishes — it's written
// as one row at message_end (see agent-core's syncEntries). While it streams it
// exists only as `tool_execution_update` events passing through the live feed.
// This folds those events into a per-chat snapshot so `/btw` can answer "what is
// it doing" mid-run, when there is no row to read yet.
//
// Ephemeral by design: the snapshot is REPLACED on each update (pi hands the
// whole accumulated output every time, not a delta — so this is a pointer swap,
// not an append) and DROPPED when the tool or turn ends.

type Snapshot = { toolName: string; output: string };

const live = new Map<string, Snapshot>();

// Mirror of the renderer's formatToolResult (chatStore.ts): pi's partialResult
// arrives in one of a few shapes.
function formatPartial(result: any): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    if (Array.isArray(result.content)) {
      return result.content
        .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('');
    }
    if (typeof result.output === 'string') return result.output;
    if (typeof result.text === 'string') return result.text;
    try { return JSON.stringify(result, null, 2); } catch { return String(result); }
  }
  return String(result);
}

// Fold one feed event into the map. Called for EVERY published event (before the
// feed's no-subscribers early-return, so it captures even when no desktop is
// watching). Cheap: a set or a delete keyed by chatId.
export function note(event: any): void {
  const chatId = event?.chatId;
  if (!chatId) return;
  switch (event.type) {
    case 'tool_execution_update':
      live.set(chatId, { toolName: event.toolName ?? 'a tool', output: formatPartial(event.partialResult) });
      break;
    case 'tool_execution_end':
    case 'agent_end':
    case 'agent_settled':
      live.delete(chatId);
      break;
  }
}

// The tool currently streaming in this chat, or null when nothing is mid-stream.
export function current(chatId: string): Snapshot | null {
  return live.get(chatId) ?? null;
}
