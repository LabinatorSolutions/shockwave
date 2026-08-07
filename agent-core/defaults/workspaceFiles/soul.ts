// SOUL.md — the per-workspace "who you are / why", and the FIRST thing in the
// assembled system prompt, above every section of the helper.
//
// One rule for this folder: a file's name is `<X>_FILENAME`, its default content
// is `DEFAULT_<X>`, and both live in the module named after the file.
//
// ── This is the one default that is also a RUNTIME FALLBACK ─────────────────
//
// Every other default here is only ever seeded onto disk. `DEFAULT_SOUL` is
// different: `readSoul` returns it IN MEMORY when a workspace has no `SOUL.md`,
// and nothing is written. A cloned workspace can run on it forever without the
// file ever existing — scaffolding deliberately does not run on clone or adopt.
//
// That is why `readSoul` lives here beside the constant rather than in the
// manifest: the constant has a consumer of its own.
//
// EDITING: `DEFAULT_SOUL` is a plain literal — edit freely. Keep it to the
// "who / why / tone"; operating mechanics belong in the helper, and anything
// specific to one workspace belongs in that workspace's AGENTS.md.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const SOUL_FILENAME = 'SOUL.md';

export const DEFAULT_SOUL = `You are the agent inside Shockwave — a markdown-based "second brain" editor. Your job is to help the user think: read and connect their files, capture what matters, and keep their workspace coherent as it grows.

You work directly in the user's workspace folder (your cwd) — reading files, running commands, editing, and writing new files on their behalf.

# Style

Direct. Skip filler, recaps, and "I'll now…" preambles. Match the user's tone. When you change files, say what changed and where, in one line.`;

/**
 * A workspace's own SOUL.md, or `DEFAULT_SOUL` when it has none.
 *
 * REPLACES rather than merges — a workspace with a SOUL.md gets exactly that and
 * none of the default. Never throws: an unreadable or empty file falls back, so
 * a permissions problem degrades to the built-in identity rather than an agent
 * with no identity at all.
 *
 * Root only. Unlike AGENTS.md — which pi discovers by walking every ancestor of
 * the working directory — this is read from the workspace root and nowhere else.
 */
export async function readSoul(workspacePath: string | null | undefined): Promise<string> {
  if (!workspacePath) return DEFAULT_SOUL;
  try {
    const text = await fs.readFile(join(workspacePath, SOUL_FILENAME), 'utf8');
    return text.trim() || DEFAULT_SOUL;
  } catch {
    return DEFAULT_SOUL;
  }
}
