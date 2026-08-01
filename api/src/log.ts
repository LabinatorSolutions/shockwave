// The one logger for the companion. Everything logs through a child of this
// root with a `sub` field naming the subsystem (git, fixer, cron, telegram,
// agent, sweeper, http), so `docker compose logs api` is the single place to
// look and one grep can follow a run across subsystems by chatId.
//
// Rule for what gets a line: every BOUNDARY RESULT — a turn started/finished, a
// check-in's outcome, a fixer attempt's verdict, a git call that failed and
// why (stderr). Not per-step chatter. A failure that is caught and converted
// into a status ('error', 'conflict', a silent retry) MUST log before the
// conversion — the catch blocks in git.ts/gitFixer.ts used to swallow the only
// evidence of why a run failed, which made a transient outage indistinguishable
// from a wiped credential.
//
// Never log payloads that can carry secrets whole (settings objects, agent run
// payloads — they hold API keys). Pick fields.
import pino from 'pino';

export const log = pino({ base: undefined });

export const logger = (sub: string) => log.child({ sub });

/** Error → loggable string, preferring git's stderr (the part that says why). */
export const errStr = (e: any): string =>
  String(e?.stderr || e?.message || e).trim().slice(0, 2000);
