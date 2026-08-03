// How the agent's Telegram replies come back for a workspace: text, or a voice
// note plus the text.
//
// Stored in `<workspace>/.shockwave/workspace.json` beside the daily-note config
// and the built-in skill toggles, for the same reason those live there — it is
// scoped to one workspace and it should travel with it. That placement is what
// makes the whole feature work without a new sync path: the companion reads it
// out of the checkout it is already working in, the agent can change it mid-turn,
// and the run's own commit carries the change back to the desktop.
//
// It reads the file per call rather than caching, exactly like `dailyNoteTool.ts`
// — a setting changed from the desktop, or by the agent's previous turn, lands on
// the next reply instead of on the next restart.
//
// Dependency-free apart from `node:fs`, so both builds import it plainly.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * How a reply is delivered.
 *
 * - `'text'`  — text only. The default.
 * - `'voice'` — a voice note only. Nothing to skim, so it is opt-in twice over.
 * - `'both'`  — a voice note AND the text.
 */
export type VoiceReply = 'text' | 'voice' | 'both';

/** Text unless asked otherwise. Speaking costs money on every reply, so it is
 *  never what you get by doing nothing. */
export const DEFAULT_VOICE_REPLY: VoiceReply = 'text';

export const VOICE_REPLY_MODES: VoiceReply[] = ['text', 'voice', 'both'];

function workspaceFile(workspacePath: string): string {
  return path.join(workspacePath, '.shockwave', 'workspace.json');
}

/** Anything that isn't one of the three reads as the default — the agent writes
 *  this key itself, so a typo must not become a mode nothing renders. */
export function normalizeVoiceReply(value: unknown): VoiceReply {
  return value === 'voice' || value === 'both' ? value : DEFAULT_VOICE_REPLY;
}

/** Does this mode send the written text? False only for voice-only. */
export const sendsText = (mode: VoiceReply): boolean => mode !== 'voice';
/** Does this mode speak? */
export const speaks = (mode: VoiceReply): boolean => mode !== 'text';

/**
 * Read the mode. Never throws: a workspace with no `.shockwave/workspace.json`
 * (or an unreadable one) is simply a workspace on the default, and failing a
 * reply over it would be absurd.
 */
export async function readVoiceReply(workspacePath: string | null | undefined): Promise<VoiceReply> {
  if (!workspacePath) return DEFAULT_VOICE_REPLY;
  try {
    const raw = JSON.parse(await fs.readFile(workspaceFile(workspacePath), 'utf8'));
    return normalizeVoiceReply(raw?.voiceReply);
  } catch {
    return DEFAULT_VOICE_REPLY;
  }
}

/**
 * Set the mode, preserving everything else in the file.
 *
 * Read-modify-write, because this file holds bookmarks and skill toggles the
 * agent has no business rewriting. Written atomically (temp + rename) so a
 * crashed write can't leave the workspace with an unparseable settings file —
 * which would silently reset the daily-note config and every skill toggle.
 *
 * Returns false if it could not be written, so the caller can tell the user the
 * mode changed for this message only rather than claiming it stuck.
 */
export async function writeVoiceReply(
  workspacePath: string | null | undefined,
  mode: VoiceReply,
): Promise<boolean> {
  if (!workspacePath) return false;
  const file = workspaceFile(workspacePath);
  try {
    let data: any = {};
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch { /* absent or corrupt — write a fresh one below */ }

    data.voiceReply = normalizeVoiceReply(mode);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}
