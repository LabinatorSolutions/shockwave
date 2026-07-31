// Transcribing an inbound Telegram voice note.
//
// A thin adapter over the shared speech-to-text in `agent-core/transcribe.ts`, so
// there is ONE implementation of "audio in, words out" — the same one the agent's
// `transcribe` tool uses, and the same one a future provider swap replaces. This
// file only bridges the shapes: Telegram hands us bytes, the provider wants a
// file, and this path wants plain text rather than timestamped segments.
//
// The caller reads the settings (it reads the neighbouring `echoTelegramTranscript`
// from the same object) and hands the key in, so one voice note costs one settings
// read, not one per consumer.
//
// Telegram sends voice notes as OGG/Opus, which AssemblyAI accepts as-is, so the
// audio is written byte-for-byte with no conversion.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { transcribeFile } from '../../../agent-core/transcribe.js';

/**
 * Transcribe a voice note. Returns the text, `null` when no API key is configured
 * (the caller should say so rather than ignore the user), or `''` when the audio
 * held no speech. Throws if the provider reports a failure.
 *
 * The file is temporary and deleted afterwards: a voice note IS the message, not
 * an attachment to it, so there is nothing to keep once it has been read.
 */
export async function transcribeAudio(
  apiKey: string | undefined,
  audio: Buffer,
  provider?: string,
): Promise<string | null> {
  if (!apiKey) return null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shockwave-voice-'));
  const file = path.join(dir, `voice-${crypto.randomBytes(4).toString('hex')}.ogg`);
  try {
    await fs.writeFile(file, audio);
    return (await transcribeFile(file, { provider, apiKey }, dir)).text;
  } catch (e: any) {
    // The shared layer signals a missing key this way. We already checked, so
    // anything arriving here is a real failure and belongs to the caller's catch.
    if (e?.message === 'no-key') return null;
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
  }
}
