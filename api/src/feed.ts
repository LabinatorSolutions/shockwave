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
