// Desktop cron VIEW — the client has no cron engine anymore; this just composes
// what the UI shows: job DEFINITIONS from the active workspace's local cron.json
// (a git-synced file the desktop already has) + run STATUS (last run / next run)
// from the companion, which owns execution. "Run now" calls the companion.

import fs from 'node:fs/promises';
import path from 'node:path';
import { api } from './client.js';
import { readLocalSettings, getWorkspaceLocal } from './localSettings.js';

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
    description: j?.schedule ?? '',
    enabled: j?.enabled !== false,
    invalid: null,
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
