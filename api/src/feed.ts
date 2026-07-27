// Live-feed pub/sub — the SSE relay's fan-out. Ephemeral, in-memory. Used by the
// HTTP routes (a spectator subscribes on /stream; the desktop producer POSTs to
// /events) AND, in-process, by the server's own cron runs (their emit publishes
// straight here). One place, so a server run and a relayed desktop run reach
// watchers identically.

import type express from 'express';

const subs = new Map<string, Set<express.Response>>();

// Register a spectator's SSE response; returns an unsubscribe fn.
export function subscribe(sessionId: string, res: express.Response): () => void {
  let set = subs.get(sessionId);
  if (!set) { set = new Set(); subs.set(sessionId, set); }
  set.add(res);
  return () => {
    const s = subs.get(sessionId);
    if (s) { s.delete(res); if (!s.size) subs.delete(sessionId); }
  };
}

// Fan one event out to a session's spectators. Returns the subscriber count.
export function publish(sessionId: string, event: any): number {
  const set = subs.get(sessionId);
  if (!set || !set.size) return 0;
  const payload = `data: ${JSON.stringify(event ?? {})}\n\n`;
  for (const r of set) { try { r.write(payload); } catch { /* dropped on next close */ } }
  return set.size;
}
