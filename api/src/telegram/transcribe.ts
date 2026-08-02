// Transcribing an inbound Telegram voice note.
//
// A thin adapter over the shared speech-to-text in `agent-core/transcribe.ts`, so
// there is ONE implementation of "audio in, words out" — the same one the agent's
// `transcribe` tool uses, and the same one a future provider swap replaces. This
// file only bridges the shapes: Telegram hands us bytes and a duration, and this
// path wants plain text rather than timestamped segments.
//
// The caller reads the settings (it reads the neighbouring `echoTelegramTranscript`
// from the same object) and hands the key in, so one voice note costs one settings
// read, not one per consumer.
//
// A voice note goes down the SYNC path — one request, no polling, ~0.3s against
// the job API's ~3.5s. Everything about that (why raw PCM, why ffmpeg, what the
// fallback covers) lives in `agent-core/transcribe.ts`, because it is a fact
// about the provider rather than about Telegram.

import { transcribeVoice, keyFor, type TranscriptionConfig } from '../../../agent-core/transcribe.js';

export { warmTranscription, providerOf } from '../../../agent-core/transcribe.js';

/**
 * Transcribe a voice note. Returns the text, `null` when no API key is configured
 * (the caller should say so rather than ignore the user), or `''` when the audio
 * held no speech. Throws if the provider reports a failure.
 *
 * Takes the whole `settings.transcription` slice rather than a key, because which
 * key applies depends on which engine is selected and that is `keyFor`'s job, not
 * every caller's.
 *
 * `durationSeconds` is Telegram's own `voice.duration` — it decides whether the
 * clip fits AssemblyAI's sync ceiling, and it costs nothing to pass. Deepgram has
 * no such ceiling and ignores it.
 *
 * Nothing is written to disk on the fast path. A voice note IS the message, not
 * an attachment to it, so there was never anything to keep once it had been read.
 */
export async function transcribeAudio(
  config: TranscriptionConfig | undefined,
  audio: Buffer,
  durationSeconds?: number,
): Promise<string | null> {
  const cfg = config ?? {};
  if (!keyFor(cfg)) return null;

  try {
    return await transcribeVoice(audio, cfg, durationSeconds);
  } catch (e: any) {
    // The shared layer signals a missing key this way. We already checked, so
    // anything arriving here is a real failure and belongs to the caller's catch.
    if (e?.message === 'no-key') return null;
    throw e;
  }
}
