// Live-feed pub/sub — the SSE relay's fan-out. Ephemeral, in-memory, never
// stored: it is a low-latency mirror of what has ALREADY been written to the
// message table, not a second source of truth. A client that misses events (was
// closed, dropped the connection) loses nothing — it re-reads with `?after=`.
//
// One GLOBAL channel, not one per chat. A desktop can't subscribe per chat,
// because the whole point is to hear about turns it doesn't yet know exist — a
// Telegram message, a cron run, the same chat running on another machine. Every
// event already carries its `chatId`, so the client routes.

import type express from 'express';
import * as liveTool from './liveTool.js';

const subs = new Set<express.Response>();

// Register a spectator's SSE response; returns an unsubscribe fn.
export function subscribe(res: express.Response): () => void {
  subs.add(res);
  return () => { subs.delete(res); };
}

// Fan one event out to every watcher. Returns the subscriber count.
export function publish(event: any): number {
  // Capture in-flight tool output BEFORE the no-subscribers bail, so /btw can
  // read the running tool even when no desktop is watching the feed.
  liveTool.note(event);
  if (!subs.size) return 0;
  const payload = `data: ${JSON.stringify(event ?? {})}\n\n`;
  for (const r of subs) { try { r.write(payload); } catch { /* dropped on next close */ } }
  return subs.size;
}

/**
 * Tell every connected desktop that a setting changed HERE.
 *
 * The companion can change settings on its own — `/voice` from the bot is the
 * first, and it will not be the last — and the desktop otherwise has no way to
 * find out. Main only pushes `settings:changed` after its OWN writes, so a change
 * made through Telegram left the app showing a stale value until a reconnect or a
 * restart. That is the same "the companion isn't really the source of truth"
 * shape as the reconnect gap, one step further out.
 *
 * Deliberately carries NO payload. The desktop re-reads and pushes a full
 * snapshot; sending the value here would be a second copy of the truth travelling
 * a different route, which is the thing worth not having.
 */
export function publishSettingsChanged(): number {
  return publish({ type: 'settings_changed' });
}
