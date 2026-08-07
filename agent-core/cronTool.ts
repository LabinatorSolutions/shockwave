// The `cron` tool — scheduling, through a door that checks its work.
//
// `cron.json` stays the source of truth: a file in the workspace repo, versioned,
// synced, hand-editable, rendered by the app's cron panel, and the thing a
// one-time run deletes itself from. This tool does not replace it; it is the
// validated way to write it, exactly as `manage_skill` is for a `SKILL.md`.
//
// That is also the honest limit: a cron run keeps `write` and `edit`, so an agent
// can still hand-edit `cron.json` and bypass every check below. This is a quality
// mechanism, not a containment one — it makes the correct path the easy one, and
// nothing here should be relied on as a guarantee.
//
// ── Why a tool at all, when the file already works ──────────────────────────
//
// Because writing it by hand fails silently, three ways, and the panel shows a
// normal-looking job in all three. See the header of `cronValidate.ts` for the
// measurements. The short version: an unparseable schedule becomes a server log
// line nobody reads, a datetime that has already passed does not even warn, and
// a job with no prompt fires on time and throws forever.
//
// And `status`: the companion has recorded every run's outcome all along
// (`cron_state`), and the agent has never been able to see any of it. It could
// not tell whether a job it created registered, or that a nightly job had failed
// six nights running. That is the half hermes gets right by returning the whole
// job record on every call.
//
// ── The description IS the instruction ──────────────────────────────────────
//
// Shaped after hermes' `cronjob` tool: one tool, an `action` verb, guidance in
// the field descriptions rather than in the system prompt, and errors written to
// teach rather than to reject. `SCHEDULED_RUNS` — the 2,608-char prompt section
// this replaces — is deleted; what a single tool is for belongs with that tool,
// and a tool description is rebuilt every session where the prompt is frozen
// when a chat is created.
//
// What is deliberately NOT copied from hermes: `deliver` (we have one channel),
// `skills`, `script`/`no_agent`, `context_from`, `enabled_toolsets`, `workdir`,
// `attach_to_session`. Those are features we do not have rather than decisions we
// made differently — if any is built, take hermes' name and semantics for it.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkSchedule, validateJob, parseJobsFile, type CronJob,
} from './cronValidate.ts';

/** Per-job run history, from whichever host can see it. */
export interface CronJobStatus {
  name: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
}

export type CronStatusReader = (workspaceId: string) => Promise<CronJobStatus[]>;

const DESCRIPTION = [
  "Manage this workspace's scheduled runs. Jobs live in `cron.json` at the workspace root — this validates and writes that file, so use it rather than editing cron.json by hand.",
  'Actions: create, update, remove, list, status.',
  '',
  'RECURRING jobs take a cron expression — "0 9 * * *" is every day at 9am.',
  'ONE-TIME jobs take an ISO datetime — "2026-03-14T18:50:00". Anything the user frames as a single future moment ("remind me tonight at 6:50", "check on this tomorrow morning", "ping me in an hour") is one-time. The job runs once and then removes itself; you do not need to mark it, that is worked out from the schedule.',
  '',
  '**Run `date` before writing a datetime.** You are told today\'s date but never the time of day, so "in an hour" and "tonight at 6:50" are unanswerable without checking — and a moment that has already passed is the single most common way a reminder is never delivered.',
  '',
  'Registration takes about a minute: the file has to reach GitHub and the scheduler re-reads on a cycle. Do not schedule anything less than ~2 minutes out — do it immediately instead, or pick a later time and say which.',
  '',
  'A RUN HAS NO USER IN IT. It starts a fresh chat that cannot see this conversation, so the prompt must stand on its own, and it cannot ask a question or wait for an answer. If the point of the job is to tell the user something, say so in the prompt itself — write "send the user a message ..." — or the run just writes into a chat nobody is looking at.',
  '',
  'Never guess a job name: call `list` first. Renaming a job orphans its run history.',
  '',
  'Use `status` to check whether a job is actually working — it returns each job\'s next run, last run, and last error. Check it before telling the user a scheduled job is fine, and when they ask why something did not happen.',
].join('\n');

export function makeCronTool(
  workspacePath: string,
  opts: { timezone?: string; workspaceId?: string; readStatus?: CronStatusReader } = {},
): any {
  const file = path.join(workspacePath, 'cron.json');

  const read = async (): Promise<{ ok: boolean; error?: string; jobs: CronJob[] }> => {
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    return parseJobsFile(raw);
  };

  const write = (jobs: CronJob[]) => fs.writeFile(file, `${JSON.stringify(jobs, null, 2)}\n`);

  // What every action hands back, so the agent can see the result rather than
  // assume it — hermes returns the whole job record for the same reason.
  const describe = (j: CronJob) => {
    const s = checkSchedule(j.schedule, opts.timezone);
    return {
      name: j.name,
      schedule: j.schedule,
      enabled: j.enabled !== false,
      once: j.once === true,
      nextRuns: s.nextRuns.map((t) => new Date(t).toISOString()),
      ...(s.ok ? {} : { problem: s.error }),
    };
  };

  return {
    name: 'cron',
    label: 'Scheduled Runs',
    description: DESCRIPTION,
    promptSnippet: "Schedule the agent to run unattended, and check on jobs you've scheduled.",
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'remove', 'list', 'status'],
          description: 'create/update/remove change cron.json. list shows what is scheduled. status shows how those jobs have actually been running.',
        },
        name: {
          type: 'string',
          description: 'The job name. Required for create/update/remove. Unique within the file and stable — run history is filed under it.',
        },
        schedule: {
          type: 'string',
          description: 'Cron expression for something recurring ("0 9 * * *"), or an ISO datetime for a one-time run ("2026-03-14T18:50:00"). Required for create.',
        },
        prompt: {
          type: 'string',
          description: 'What the scheduled run is asked to do. Required for create. Self-contained — the run cannot see this conversation, and cannot ask questions.',
        },
        enabled: {
          type: 'boolean',
          description: 'Set false to pause a job without deleting it. Omit to leave it running.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },

    async execute(_id: string, params: any = {}) {
      const action = String(params?.action ?? '');
      const name = params?.name != null ? String(params.name).trim() : '';
      try {
        if (action === 'status') {
          if (!opts.readStatus || !opts.workspaceId) {
            return fail('Run history is not available here. `list` still shows what is scheduled.');
          }
          const rows = await opts.readStatus(opts.workspaceId);
          if (!rows.length) return ok('No scheduled jobs have run yet.');
          return ok(JSON.stringify(rows.map((r) => ({
            name: r.name,
            nextRun: r.nextRunAt ? new Date(r.nextRunAt).toISOString() : null,
            lastRun: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
            lastError: r.lastError,
          })), null, 2));
        }

        const cur = await read();
        if (!cur.ok) return fail(cur.error!);

        if (action === 'list') {
          if (!cur.jobs.length) return ok('No scheduled jobs in this workspace.');
          return ok(JSON.stringify(cur.jobs.map(describe), null, 2));
        }

        if (action === 'remove') {
          if (!name) return fail('`remove` needs the job name. Call `list` first — never guess one.');
          const kept = cur.jobs.filter((j) => j?.name !== name);
          if (kept.length === cur.jobs.length) {
            return fail(`No job named "${name}". Call \`list\` to see what is scheduled.`);
          }
          await write(kept);
          return ok(`Removed "${name}". It stops running once the change reaches the scheduler, about a minute.`);
        }

        if (action === 'create' || action === 'update') {
          if (!name) return fail(`\`${action}\` needs a job name.`);
          const existing = cur.jobs.find((j) => j?.name === name);
          if (action === 'update' && !existing) {
            return fail(`No job named "${name}" to update. Call \`list\` to see what is scheduled, or use \`create\`.`);
          }
          if (action === 'create' && existing) {
            return fail(`A job named "${name}" already exists. Use \`update\` to change it.`);
          }

          // An update carries only what is changing; the rest comes off the
          // stored entry. Without this, changing a schedule would silently drop
          // the prompt and validation would reject a job that is already fine.
          const merged: Partial<CronJob> = {
            name,
            schedule: params?.schedule != null ? String(params.schedule) : existing?.schedule,
            prompt: params?.prompt != null ? String(params.prompt) : existing?.prompt,
            enabled: params?.enabled != null ? !!params.enabled : existing?.enabled,
          };

          const v = validateJob(merged, cur.jobs, {
            timezone: opts.timezone,
            replacing: action === 'update' ? name : undefined,
          });
          if (!v.ok) return fail(v.error!);

          const next = action === 'update'
            ? cur.jobs.map((j) => (j?.name === name ? v.job! : j))
            : [...cur.jobs, v.job!];
          await write(next);

          const when = v.nextRuns.map((t) => new Date(t).toISOString());
          const lead = v.job!.once
            ? `Scheduled "${name}" to run once, at ${when[0]}.`
            : `Scheduled "${name}". Next runs: ${when.join(', ')}.`;
          return ok(`${lead}\nIt registers in about a minute — the file has to reach GitHub first.`);
        }

        return fail(`Unknown action "${action}". Use create, update, remove, list or status.`);
      } catch (e: any) {
        return fail(`cron failed: ${e?.message ?? e}`);
      }
    },
  };
}

const ok = (text: string) => ({ content: [{ type: 'text', text }] });
const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
