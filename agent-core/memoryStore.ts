// Bounded, curated memory: two files in the workspace that the agent maintains
// about the user and about working here.
//
//   <workspace>/MEMORY.md   what the agent has learned about this workspace
//   <workspace>/USER.md     who the user is — preferences, style, expectations
//
// Ported from hermes-agent `tools/memory_tool.py` (its `MemoryStore`). The
// format, the char budget, the substring matching and every string the model
// reads are hermes'. What changed is where the files live and what the failure
// modes are, and each departure is named below.
//
// ── The shape, and why it is a budget rather than a log ─────────────────────
//
// Entries are joined by `\n§\n` and the WHOLE store is capped in characters.
// The cap is the mechanism: a write that would exceed it fails with the current
// entries attached and an instruction to consolidate, so memory stays curated
// instead of growing into a transcript nobody reads. Characters and not tokens
// because a char count is the same on every model.
//
// A bare `§` inside an entry is safe — only a `§` alone on its own line
// separates, which is what `\n§\n` means. Entries may be multiline.
//
// ── Departures from hermes ───────────────────────────────────────────────────
//
//  1. PER-WORKSPACE, IN THE REPO. hermes keeps one global pair under
//     `~/.hermes/memories/`. Ours are ordinary files at the workspace root,
//     beside SOUL.md and AGENTS.md — committed, synced, diffable, and editable
//     by the user in the app like anything else.
//
//  2. NO DRIFT REFUSAL, NO `.bak`. hermes refuses to write when the file does
//     not round-trip through its parser, because a human editing that file is an
//     anomaly there. Here it is the point: this is a markdown workspace and the
//     user opens these files. Anything that parses as entries is entries.
//
//  3. AN IN-PROCESS LOCK RATHER THAN `flock`. The desktop runs several chats
//     against ONE workspace folder, so two turns can write the same file at
//     once; measured, a naive read-modify-write loses an entry outright. A
//     promise chain per absolute path serializes them. The companion gives every
//     chat its own checkout, so there it costs nothing. Cross-process is git's
//     problem, not this file's.
//
//  4. NO THREAT SCAN. hermes scans entries for injection before they enter the
//     system prompt. We inject SOUL.md and AGENTS.md unscanned from the same
//     folder, so scanning one and not the others is a guard that reads as
//     protection without being any.
//
//  5. A SYMLINK IS REFUSED. hermes has no equivalent because it owns its
//     directory. Here the path is inside a repo whose contents can arrive by
//     clone or by pull, and a background run holds no `write` or `bash` — so a
//     symlink planted at MEMORY.md would be the one way such a run could write
//     outside the workspace. Cheap to close, so it is closed.
//
// What is NOT ported, deliberately: the write-approval staging queue
// (`/memory pending|approve|reject`) — the file is in the tree, editable and in
// git, which is a better review surface than a queue; and the external memory
// providers.

import fs from 'node:fs/promises';
import path from 'node:path';

/** A `§` alone on its own line. A `§` inside a line is content. */
export const ENTRY_DELIMITER = '\n§\n';

export type MemoryTarget = 'memory' | 'user';

/** Which file each target is. The ONLY place a target becomes a path — the tool
 *  never builds one from its arguments, so there is nothing to traverse with. */
export const MEMORY_FILES: Record<MemoryTarget, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
};

/** hermes' defaults: ~800 tokens of workspace notes, ~500 of user profile. */
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_USER_CHAR_LIMIT = 1375;

/** Headers for the system-prompt blocks. hermes' text, verbatim. */
export const MEMORY_BLOCK_HEADERS: Record<MemoryTarget, string> = {
  memory: 'MEMORY (your personal notes)',
  user: 'USER PROFILE (who the user is)',
};

export interface MemoryOp {
  action?: string;
  content?: string | null;
  old_text?: string | null;
}

export interface MemoryResult {
  success: boolean;
  /** Terminal: the model should stop calling the tool about this. */
  done?: boolean;
  target?: string;
  usage?: string;
  entry_count?: number;
  message?: string;
  note?: string;
  error?: string;
  current_entries?: string[];
  matches?: string[];
}

// ── Format ───────────────────────────────────────────────────────────────────

export function parseEntries(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

export function serializeEntries(entries: string[]): string {
  return entries.join(ENTRY_DELIMITER);
}

/** The budget is measured on the SERIALIZED form, delimiters included — the
 *  same number hermes reports, and the same one the prompt block costs. */
export function charCount(entries: string[]): number {
  return entries.length ? serializeEntries(entries).length : 0;
}

/** Thousands separators, because every number the model is shown has them in
 *  hermes and the instruction text reads as one voice. */
const n = (v: number) => v.toLocaleString('en-US');

/**
 * The system-prompt block for one target, or '' when there is nothing to say.
 *
 * The usage line is load-bearing: it is how the agent knows it is near the cap
 * before it tries to write, which is what makes it consolidate on its own rather
 * than discovering the wall mid-turn.
 */
export function renderBlock(target: MemoryTarget, entries: string[], limit: number): string {
  if (!entries.length) return '';
  const content = serializeEntries(entries);
  const current = content.length;
  const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
  const header = `${MEMORY_BLOCK_HEADERS[target]} [${pct}% — ${n(current)}/${n(limit)} chars]`;
  const separator = '═'.repeat(46);
  return `${separator}\n${header}\n${separator}\n${content}`;
}

// ── Disk ─────────────────────────────────────────────────────────────────────

export function memoryPath(workspacePath: string, target: MemoryTarget): string {
  return path.join(workspacePath, MEMORY_FILES[target]);
}

/** Sentinel for "the file exists but could not be read". Distinct from empty:
 *  reading an unreadable file as `[]` and then saving would rewrite the whole
 *  file from an empty view and wipe it. Every mutation aborts on this. */
const READ_FAILED = Symbol('read-failed');

async function readRaw(file: string): Promise<string | typeof READ_FAILED> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return '';   // absent is a clean empty store
    return READ_FAILED;
  }
}

/**
 * Write via a temp file in the same directory and a rename.
 *
 * Rename is atomic within a filesystem, so a reader — the next session boot
 * assembling a prompt, or the user with the file open in the editor — sees
 * either the whole previous file or the whole new one, never a truncated one.
 *
 * Refuses a symlink. See departure 5 in the header.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  try {
    const st = await fs.lstat(file);
    if (st.isSymbolicLink()) throw new Error(`${path.basename(file)} is a symlink — refusing to write through it.`);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;    // absent is fine; anything else is not
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

// One promise chain per absolute path. Departure 3 — without it, two chats
// writing the same file in the same tick lose one entry silently.
const chains = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);          // a failed predecessor must not stall the queue
  chains.set(file, next.catch(() => {}));
  return next;
}

// ── Messages the model reads ─────────────────────────────────────────────────
//
// hermes' strings, kept word for word. They are instructions, not diagnostics:
// each one tells the model what to do next, and the consolidate-in-this-turn
// wording is why an at-capacity store gets tidied instead of giving up.

const readFailedError = (file: string): MemoryResult => ({
  success: false,
  error:
    `Refusing to write ${path.basename(file)}: the file exists on disk but could `
    + 'not be read right now (temporarily locked by another program, a permission '
    + 'change, invalid/corrupt text encoding, or a filesystem error). Treating an '
    + 'unreadable file as empty and saving would wipe existing memory, so the write '
    + 'is refused. Nothing was changed — retry in a moment.',
});

/** Truncated one-line previews, for the ambiguous-match error. */
const previews = (entries: string[], width = 80): string[] =>
  entries.map((e) => (e.length > width ? `${e.slice(0, width)}...` : e));

export class MemoryStore {
  readonly workspacePath: string;
  readonly limits: Record<MemoryTarget, number>;

  /**
   * Consecutive at-capacity failures this turn.
   *
   * hermes caps these because a fragile replace can otherwise loop a turn to
   * budget exhaustion and suppress the user's reply entirely — a failed memory
   * side effect must never cost the answer. Reset by `resetTurn()` at the start
   * of every turn, and by any successful write (progress was made).
   */
  private consolidationFailures = 0;
  private static readonly MAX_CONSOLIDATION_FAILURES_PER_TURN = 3;

  constructor(workspacePath: string, limits?: Partial<Record<MemoryTarget, number>>) {
    this.workspacePath = workspacePath;
    this.limits = {
      memory: clampLimit(limits?.memory, DEFAULT_MEMORY_CHAR_LIMIT),
      user: clampLimit(limits?.user, DEFAULT_USER_CHAR_LIMIT),
    };
  }

  resetTurn(): void {
    this.consolidationFailures = 0;
  }

  fileFor(target: MemoryTarget): string {
    return memoryPath(this.workspacePath, target);
  }

  /** Entries as they are on disk right now. Never throws — a read failure reads
   *  as empty here because nothing is written back from it. */
  async read(target: MemoryTarget): Promise<string[]> {
    const raw = await readRaw(this.fileFor(target));
    if (raw === READ_FAILED) return [];
    // Deduplicate, keeping the first occurrence — hermes does this on load, and
    // a hand-edited file is exactly where a duplicate comes from.
    return [...new Set(parseEntries(raw))];
  }

  /** Both blocks for the system prompt, in hermes' order (notes, then profile). */
  async renderForPrompt(): Promise<string> {
    const blocks: string[] = [];
    for (const target of ['memory', 'user'] as MemoryTarget[]) {
      const block = renderBlock(target, await this.read(target), this.limits[target]);
      if (block) blocks.push(block);
    }
    return blocks.join('\n\n');
  }

  async add(target: MemoryTarget, content: string): Promise<MemoryResult> {
    const text = (content ?? '').trim();
    if (!text) return { success: false, error: 'Content cannot be empty.' };
    return this.mutate(target, (entries) => {
      if (entries.includes(text)) return { entries, message: 'Entry already exists (no duplicate added).' };
      const next = [...entries, text];
      const limit = this.limits[target];
      const total = charCount(next);
      if (total > limit) {
        const current = charCount(entries);
        return {
          fail: this.consolidationFailure({
            success: false,
            error:
              `Memory at ${n(current)}/${n(limit)} chars. `
              + `Adding this entry (${text.length} chars) would exceed the limit. `
              + "Consolidate now: use 'replace' to merge overlapping entries into "
              + "shorter ones or 'remove' stale or less important entries (see "
              + 'current_entries below), then retry this add — all in this turn.',
            current_entries: entries,
            usage: `${n(current)}/${n(limit)}`,
          }),
        };
      }
      return { entries: next, message: 'Entry added.' };
    });
  }

  async replace(target: MemoryTarget, oldText: string, content: string): Promise<MemoryResult> {
    const needle = (oldText ?? '').trim();
    const text = (content ?? '').trim();
    if (!needle) return { success: false, error: 'old_text cannot be empty.' };
    if (!text) return { success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };
    return this.mutate(target, (entries) => {
      const found = this.match(entries, needle, 'replace');
      if ('fail' in found) return found;
      const next = [...entries];
      next[found.index] = text;
      const limit = this.limits[target];
      const total = charCount(next);
      if (total > limit) {
        const current = charCount(entries);
        return {
          fail: this.consolidationFailure({
            success: false,
            error:
              `Replacement would put memory at ${n(total)}/${n(limit)} chars. `
              + "Shorten the new content, or 'remove' other stale or less important "
              + 'entries to make room (see current_entries below), then retry — all '
              + 'in this turn.',
            current_entries: entries,
            usage: `${n(current)}/${n(limit)}`,
          }),
        };
      }
      return { entries: next, message: 'Entry replaced.' };
    });
  }

  async remove(target: MemoryTarget, oldText: string): Promise<MemoryResult> {
    const needle = (oldText ?? '').trim();
    if (!needle) return { success: false, error: 'old_text cannot be empty.' };
    return this.mutate(target, (entries) => {
      const found = this.match(entries, needle, 'remove');
      if ('fail' in found) return found;
      const next = [...entries];
      next.splice(found.index, 1);
      return { entries: next, message: 'Entry removed.' };
    });
  }

  /**
   * Apply a sequence of ops to one target, all or nothing.
   *
   * The budget is checked ONCE, on the final result — intermediate overflow is
   * irrelevant. That is what lets one call free space and add in the same
   * breath, instead of the consolidate-then-retry dance that re-sends the whole
   * conversation several times. It is the shape the tool description tells the
   * model to prefer, so it is the shape most calls take.
   */
  async applyBatch(target: MemoryTarget, operations: MemoryOp[]): Promise<MemoryResult> {
    if (!Array.isArray(operations) || !operations.length) {
      return { success: false, error: 'operations list is empty.' };
    }
    return this.mutate(target, (entries) => {
      const working = [...entries];
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i] ?? {};
        const action = op.action;
        const content = (op.content ?? '').trim();
        const needle = (op.old_text ?? '').trim();
        const pos = `Operation ${i + 1} (${action || 'unknown'})`;

        if (action === 'add') {
          if (!content) return { fail: this.batchError(entries, target, `${pos}: content is required.`) };
          if (working.includes(content)) continue;   // idempotent — a duplicate must not fail the batch
          working.push(content);
        } else if (action === 'replace' || action === 'remove') {
          if (!needle) return { fail: this.batchError(entries, target, `${pos}: old_text is required.`) };
          if (action === 'replace' && !content) {
            return { fail: this.batchError(entries, target, `${pos}: content is required (use action='remove' to delete).`) };
          }
          const hits = working.map((e, j) => [j, e] as const).filter(([, e]) => e.includes(needle));
          if (!hits.length) return { fail: this.batchError(entries, target, `${pos}: no entry matched '${needle}'.`) };
          if (new Set(hits.map(([j]) => working[j])).size > 1) {
            return { fail: this.batchError(entries, target, `${pos}: '${needle}' matched multiple distinct entries -- be more specific.`) };
          }
          if (action === 'replace') working[hits[0][0]] = content;
          else working.splice(hits[0][0], 1);
        } else {
          return { fail: this.batchError(entries, target, `${pos}: unknown action. Use add, replace, or remove.`) };
        }
      }

      const limit = this.limits[target];
      const total = charCount(working);
      if (total > limit) {
        const current = charCount(entries);
        return {
          fail: this.consolidationFailure({
            success: false,
            error:
              `After applying all ${operations.length} operations, memory would be at `
              + `${n(total)}/${n(limit)} chars -- over the limit. Remove or shorten more `
              + 'entries in the same batch (see current_entries below), then retry.',
            current_entries: entries,
            usage: `${n(current)}/${n(limit)}`,
          }),
        };
      }
      return { entries: working, message: `Applied ${operations.length} operation(s).` };
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Read under the lock, let `apply` decide, write only if it produced entries.
   *
   * Every mutation goes through here so the read-modify-write is serialized and
   * an unreadable file aborts in exactly one place.
   */
  private mutate(
    target: MemoryTarget,
    apply: (entries: string[]) => { entries: string[]; message: string } | { fail: MemoryResult },
  ): Promise<MemoryResult> {
    const file = this.fileFor(target);
    return withLock(file, async () => {
      const raw = await readRaw(file);
      if (raw === READ_FAILED) return readFailedError(file);
      const entries = [...new Set(parseEntries(raw))];
      const outcome = apply(entries);
      if ('fail' in outcome) return outcome.fail;
      // Written with a trailing newline — these are files in a git repo whose
      // diffs the user reads, and without one every change also reports
      // "\ No newline at end of file". It is NOT part of the budget: `charCount`
      // measures the entries, which is the number the agent is shown and the one
      // hermes defines. `parseEntries` trims, so it round-trips either way.
      const text = outcome.entries.length ? `${serializeEntries(outcome.entries)}\n` : '';
      // An unchanged list still reports success — the duplicate case, where the
      // fact IS already saved and the model must stop, not retry. Comparing the
      // bytes also means a hand-edited file gets normalized on the next write
      // rather than being rewritten identically every time.
      if (text !== raw) {
        try {
          await writeAtomic(file, text);
        } catch (e: any) {
          return { success: false, error: `Could not save ${path.basename(file)}: ${e?.message ?? e}` };
        }
      }
      return this.success(target, outcome.entries, outcome.message);
    });
  }

  /** Locate the one entry containing `needle`, or explain why we can't. */
  private match(entries: string[], needle: string, action: 'replace' | 'remove'):
  { index: number } | { fail: MemoryResult } {
    const hits = entries.map((e, i) => [i, e] as const).filter(([, e]) => e.includes(needle));
    if (!hits.length) {
      return {
        fail: this.consolidationFailure({
          success: false,
          error: `No entry matched '${needle}'. Check current_entries below and retry with the exact text of the entry you want to ${action}.`,
          current_entries: entries,
        }),
      };
    }
    // Identical duplicates are not ambiguous — act on the first. Only distinct
    // entries sharing the substring need the model to be more specific.
    if (hits.length > 1 && new Set(hits.map(([, e]) => e)).size > 1) {
      return {
        fail: {
          success: false,
          error: `Multiple entries matched '${needle}'. Be more specific.`,
          matches: previews(hits.map(([, e]) => e)),
        },
      };
    }
    return { index: hits[0][0] };
  }

  /**
   * A successful write is TERMINAL and deliberately does not echo the entries.
   *
   * hermes learned this the hard way: dumping the list invites the model to find
   * more to fix and reissue the same operations — observed as the correct batch
   * on call one, then five redundant repeats. Entries appear only on the error
   * paths, where they are needed to decide what to consolidate.
   */
  private success(target: MemoryTarget, entries: string[], message: string): MemoryResult {
    this.consolidationFailures = 0;
    const limit = this.limits[target];
    const current = charCount(entries);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    return {
      success: true,
      done: true,
      target,
      usage: `${pct}% — ${n(current)}/${n(limit)} chars`,
      entry_count: entries.length,
      message,
      note: 'Write saved. This update is complete — do not repeat it.',
    };
  }

  private batchError(entries: string[], target: MemoryTarget, message: string): MemoryResult {
    const limit = this.limits[target];
    const current = charCount(entries);
    return this.consolidationFailure({
      success: false,
      error: `${message} No operations were applied (batch is all-or-nothing).`,
      current_entries: entries,
      usage: `${n(current)}/${n(limit)}`,
    });
  }

  /** Count a failed attempt and, past the cap, stop asking for a retry. */
  private consolidationFailure(result: MemoryResult): MemoryResult {
    this.consolidationFailures += 1;
    if (this.consolidationFailures <= MemoryStore.MAX_CONSOLIDATION_FAILURES_PER_TURN) return result;
    return {
      success: false,
      done: true,
      error:
        `Memory consolidation failed ${this.consolidationFailures} times this turn. `
        + 'Stop retrying memory calls — leave memory unchanged for now and continue '
        + 'with your reply to the user. The fact can be saved in a later turn.',
    };
  }
}

/**
 * A configured limit, or the default.
 *
 * Clamped because the number comes from a settings field a person types into.
 * Zero or negative would make every write fail forever with no way to read why
 * from the error; absurdly large would put an unbounded file into every prompt.
 */
export function clampLimit(value: unknown, fallback: number): number {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), 100_000);
}
