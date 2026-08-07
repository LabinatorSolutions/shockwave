// Desktop cron VIEW — the client has no cron engine anymore; this just composes
// what the UI shows: job DEFINITIONS from the active workspace's local cron.json
// (a git-synced file the desktop already has) + run STATUS (last run / next run)
// from the companion, which owns execution. "Run now" calls the companion.

import fs from 'node:fs/promises';
import path from 'node:path';
import { api } from './client.js';
import { readLocalSettings, getWorkspaceLocal } from './localSettings.js';
// `scheduleLabel` is the SAME check the `cron` tool writes through
// (`agent-core/cronValidate.ts`), not a second opinion — the panel calling a job
// fine while the tool refuses to write it would be worse than either answer
// alone. It lives there rather than here because this file imports the companion
// client, which imports electron, so nothing in it is loadable by `node --test`.
import { scheduleLabel } from '../../../agent-core/cronValidate.js';

const EMPTY = {
  activeWorkspace: null as string | null, exists: false, fileError: null as string | null,
  jobs: [] as any[], inFlight: false, runningJobName: null as string | null,
};

export async function cronRead(): Promise<any> {
  const local = readLocalSettings();
  const activeId = local.activeWorkspaceId;
  const wsPath = activeId ? getWorkspaceLocal(activeId).path : null;
  if (!activeId || !wsPath) return { ...EMPTY };

  // Job definitions from the local cron.json.
  let jobs: any[] = [];
  let exists = false;
  let fileError: string | null = null;
  try {
    const raw = await fs.readFile(path.join(wsPath, 'cron.json'), 'utf8');
    exists = true;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) jobs = parsed;
      else fileError = 'cron.json must be a JSON array of jobs.';
    } catch { fileError = 'cron.json is not valid JSON.'; }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') fileError = `Could not read cron.json — ${e?.message ?? e}`;
  }

  // Run status from the companion (best-effort — degrade to no status if offline).
  const history: Record<string, any> = {};
  let next: Record<string, number | null> = {};
  try {
    const state = await api.get(`/workspace/${encodeURIComponent(activeId)}/cron/state`);
    for (const h of state?.history ?? []) history[h.jobName] = h;
    next = state?.next ?? {};
  } catch { /* offline / unconfigured → jobs still show, without status */ }

  const jobViews = jobs.map((j: any) => ({
    name: j?.name ?? '',
    schedule: j?.schedule ?? '',
    enabled: j?.enabled !== false,
    // Only an explicit `true` is one-time — same shape as `enabled` above. A
    // truthy-but-wrong value in a hand-edited file shouldn't label a recurring
    // job as something that disposes of itself after one run.
    once: j?.once === true,
    // Was hardcoded `null`, so the one place a broken job could reach a human
    // was wired to a constant: `CronModal.tsx` renders this as a red pill and
    // never had anything to render. A job that can never fire looked exactly
    // like one that runs nightly, and the only other trace was a `log.warn` on
    // the companion.
    invalid: scheduleLabel(j),
    nextRunAt: next[j?.name] ?? null,
    lastRunAt: history[j?.name]?.lastRunAt ?? null,
    lastError: history[j?.name]?.lastError ?? null,
    lastChatId: history[j?.name]?.lastChatId ?? null,
  }));

  return { ...EMPTY, activeWorkspace: wsPath, exists, fileError, jobs: jobViews };
}

export async function cronRunNow(name: string): Promise<{ ok?: boolean; chatId?: string; error?: string }> {
  const local = readLocalSettings();
  const activeId = local.activeWorkspaceId;
  if (!activeId) return { error: 'No active workspace.' };
  if (!name) return { error: 'No job name.' };
  try {
    const res = await api.post(`/workspace/${encodeURIComponent(activeId)}/cron/${encodeURIComponent(name)}/run`);
    return { ok: true, chatId: res?.chatId };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}
