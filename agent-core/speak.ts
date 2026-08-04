// Text to speech. The mirror of `transcribe.ts`, and deliberately the same shape.
//
// One seam, two halves. A PROVIDER turns a script into audio BYTES and says what
// container they arrived in; that is the whole contract. Adding a vendor means
// writing one function — nothing else in this file changes, and no caller learns
// which one ran.
//
// Which vendor speaks is `settings.speech.provider`, chosen separately from the
// one that listens, because the matrix is not square: AssemblyAI transcribes and
// cannot synthesize. See `voiceProviders.ts` for the table.
//
// **The output target is Ogg/Opus**, because that is what a Telegram voice bubble
// requires and a voice bubble is the whole point of this module. Both vendors can
// emit it directly, so the happy path never runs a converter — but they are asked
// for a format rather than commanded into one, so `ensureOgg` checks the bytes and
// repairs them when a vendor ignores the request. hermes carries the same repair
// (`tools/audio_container.py`) after backends silently returned MP3 for Opus, and
// the failure without it is a file Telegram rejects with no explanation.
//
// No timeout here, for the same reason `transcribe.ts` has none: unattended runs
// are already bounded by `codingAgent.maxRunMinutes`, and a second shorter limit
// could only fail a request that was going to succeed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  type VoiceConfig, speakProviderOf, speakKey, voiceProvider, voiceLabel, canSpeak,
} from './voiceProviders.ts';
import { prepareSpokenText } from './spokenText.ts';

export interface Speech {
  /** The audio, in whatever container the vendor actually produced. */
  bytes: Buffer;
  /** Container id from the bytes themselves — never from what we asked for. */
  container: string | null;
}

/**
 * How many characters of script each vendor will take in one request.
 *
 * These are input limits, not opinions about length: over them the request is
 * rejected outright. What to do about a longer reply is the caller's call —
 * `speakToFile` cuts, because the full text is always delivered alongside the
 * audio, so a cut script costs the listener the tail of a long answer and costs
 * the reader nothing.
 */
const MAX_CHARS: Record<string, number> = {
  // Aura's documented per-request ceiling.
  deepgram: 2000,
  // Varies by model; the flash model this uses is far higher. Conservative, since
  // exceeding it fails the whole reply rather than truncating it.
  elevenlabs: 10_000,
};

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/speak';
/** Aura's default voice, used when the settings page has not picked one. */
const DEEPGRAM_DEFAULT_VOICE = 'aura-2-thalia-en';

const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
/** Rachel — ElevenLabs' own default, so an unset voice still speaks. */
const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
/**
 * The fast model, on purpose. This is a chat reply, not an audiobook: latency is
 * paid by someone watching a typing indicator, and it also carries the largest
 * character limit of the family.
 */
const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';
/** 48 kHz Opus at 64 kbps — plenty for speech, and small enough to send fast. */
const ELEVENLABS_FORMAT = 'opus_48000_64';

// ── Container sniffing ───────────────────────────────────────────────────────

/**
 * The container these bytes are actually in, from the magic bytes.
 *
 * Ported from hermes' `tools/audio_container.py`. Only the containers a speech
 * vendor might hand back are claimed; anything else is `null` and the caller
 * converts rather than guessing.
 */
export function sniffContainer(data: Buffer): string | null {
  if (data.length >= 4 && data.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (data.length >= 4 && data.subarray(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (data.length >= 12
    && data.subarray(0, 4).toString('latin1') === 'RIFF'
    && data.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (data.length >= 3 && data.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (data.length >= 8 && data.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (data.length >= 4 && data.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm';
  // `FF Fx` is shared by MP3 and ADTS AAC; bits 3-1 of the second byte separate
  // them (ADTS has ID=0 and layer=00).
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
    return (data[1] & 0xf6) === 0xf0 ? 'aac' : 'mp3';
  }
  return null;
}

/**
 * Transcode to Ogg/Opus with ffmpeg. Only ever called when a vendor ignored the
 * format we asked for — the happy path never reaches it.
 *
 * ffmpeg is present in the companion image (`api/Dockerfile` installs it), which
 * is the only host that speaks today. A missing one throws with a reason the
 * caller can show rather than failing as a mystery.
 */
function transcodeToOgg(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '64k', '-ac', '1',
      '-f', 'ogg', 'pipe:1',
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => err.push(c));
    ff.on('error', () => reject(new Error('ffmpeg is not available, so the audio could not be converted.')));
    ff.on('close', (code) => (code === 0
      ? resolve(Buffer.concat(out))
      : reject(new Error(Buffer.concat(err).toString().trim() || 'ffmpeg could not convert that audio.'))));
    ff.stdin.on('error', () => { /* the close handler reports the real reason */ });
    ff.stdin.end(input);
  });
}

/**
 * Ogg/Opus bytes, whatever the vendor actually sent.
 *
 * Already Ogg is the normal case and costs nothing. Anything else is converted,
 * because a `.ogg` file that is secretly MP3 is refused by Telegram as a voice
 * message with an error that names neither the format nor the file.
 */
export async function ensureOgg(speech: Speech): Promise<Buffer> {
  if (speech.container === 'ogg') return speech.bytes;
  return transcodeToOgg(speech.bytes);
}

// ── Providers ────────────────────────────────────────────────────────────────

/** Read a vendor's refusal out of whatever shape it puts it in. */
async function failureOf(res: Response, label: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  let reason = `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(body);
    const nested = typeof parsed?.detail === 'string' ? parsed.detail : parsed?.detail?.message;
    reason = parsed?.err_msg || parsed?.error || nested || reason;
  } catch { /* keep the status */ }
  return new Error(`${label} refused to speak that: ${reason}`);
}

/**
 * Deepgram Aura. The voice IS the model — `aura-2-thalia-en` names both — which
 * is why the settings shape keeps one field for it and ElevenLabs keeps two.
 *
 * `encoding=opus` + `container=ogg` is exactly Telegram's voice-bubble format, so
 * this path is a direct pipe with nothing to convert.
 */
async function deepgram(text: string, apiKey: string, config: VoiceConfig): Promise<Speech> {
  const params = new URLSearchParams({
    model: config.speech?.voiceId || DEEPGRAM_DEFAULT_VOICE,
    encoding: 'opus',
    container: 'ogg',
  });
  const res = await fetch(`${DEEPGRAM_URL}?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw await failureOf(res, 'Deepgram');
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, container: sniffContainer(bytes) };
}

/**
 * ElevenLabs. The voice is in the PATH and the model is a separate field, so both
 * are configurable independently — unlike Deepgram, where they are one string.
 */
async function elevenlabs(text: string, apiKey: string, config: VoiceConfig): Promise<Speech> {
  const voice = config.speech?.voiceId || ELEVENLABS_DEFAULT_VOICE;
  const model = config.speech?.modelId || ELEVENLABS_DEFAULT_MODEL;
  const res = await fetch(`${ELEVENLABS_URL}/${encodeURIComponent(voice)}?output_format=${ELEVENLABS_FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) throw await failureOf(res, 'ElevenLabs');
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, container: sniffContainer(bytes) };
}

const PROVIDERS: Record<string, (text: string, apiKey: string, config: VoiceConfig) => Promise<Speech>> = {
  deepgram,
  elevenlabs,
};

// ── The one call a host makes ────────────────────────────────────────────────

export { canSpeak };

/** The shortest thing worth saying. Two characters, so the probe below costs
 *  about as little as a synthesis request can. */
const PROBE_SCRIPT = 'ok';

/**
 * Can this key actually synthesize? Runs the REAL provider on a two-character
 * script and throws the bytes away.
 *
 * A probe and not a lookup, because neither vendor will answer the question any
 * other way: an API key can be valid, list voices happily, and still lack
 * permission to synthesize (ElevenLabs scopes per endpoint) or have no credit
 * left. Reading a permissions endpoint would report a capability the actual call
 * refuses — the same mistake Deepgram's `scopes` field invites on the listening
 * side, where the only trustworthy answer also turned out to be making the call.
 *
 * It goes through `PROVIDERS`, so it exercises the configured voice and model
 * rather than a second copy of the vendor's URL — a bad voice id fails here for
 * the same reason it would fail on a real reply. Adding a vendor still means
 * writing one function.
 *
 * **Never throws.** Verifying a key must not be able to fail louder than using
 * one; the reason comes back as text for the settings page to print.
 */
export async function probeSpeak(
  provider: string,
  apiKey: string,
  config: VoiceConfig,
): Promise<{ ok: boolean; detail?: string }> {
  const run = PROVIDERS[provider];
  if (!run) return { ok: false, detail: `${voiceLabel(provider)} does not do text to speech.` };
  try {
    const speech = await run(PROBE_SCRIPT, apiKey, config);
    // An empty body is a refusal the status code didn't admit to.
    if (!speech?.bytes?.length) return { ok: false, detail: `${voiceLabel(provider)} returned no audio.` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

/**
 * Speak `text` into an Ogg/Opus file at `outPath`. Returns the path, or `null`
 * when speech isn't configured or the script cleaned down to nothing.
 *
 * **This never throws.** Every caller is a reply that has already been written,
 * and there is no version of "the audio failed" that should cost the user their
 * answer — the text goes out either way. A failure is logged and reported through
 * `onError` so a permanently broken setup is visible rather than merely quiet.
 *
 * The script is cleaned by `prepareSpokenText` and cut to the vendor's input
 * limit. Cutting is safe precisely because the full text is delivered alongside.
 */
export async function speakToFile(
  text: string,
  config: VoiceConfig,
  outPath: string,
  onError?: (message: string) => void,
): Promise<string | null> {
  if (!canSpeak(config)) return null;

  const provider = speakProviderOf(config);
  const run = PROVIDERS[provider];
  const apiKey = speakKey(config);
  if (!run || !apiKey) {
    onError?.(`${voiceLabel(provider)} is not a text-to-speech provider this app knows.`);
    return null;
  }

  const script = prepareSpokenText(text, MAX_CHARS[provider] ?? null);
  // A reply that was only a file tag, or only a code block, has nothing to say
  // aloud. Silence is the right answer, not an empty voice note.
  if (!script) return null;

  try {
    const speech = await run(script, apiKey, config);
    const ogg = await ensureOgg(speech);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, ogg);
    return outPath;
  } catch (e: any) {
    onError?.(e?.message ?? String(e));
    return null;
  }
}

/** The vendor's input limit, for a caller that wants to say how much was cut. */
export function speakLimitFor(config: VoiceConfig): number | null {
  return MAX_CHARS[speakProviderOf(config)] ?? null;
}

/** Whether a vendor slug is one this module can actually run. */
export function isSpeakProvider(slug: string): boolean {
  return !!PROVIDERS[slug] && !!voiceProvider(slug)?.speak;
}
