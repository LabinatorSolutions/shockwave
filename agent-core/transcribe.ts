// Speech to text, and the `transcribe` tool built on it.
//
// One seam, two halves. A PROVIDER turns audio into timestamped segments; that is
// the whole contract, and `transcriptFormat.ts` turns segments into SRT/VTT/text.
// Swapping AssemblyAI for something else means writing one function that returns
// segments — no other file changes, and the output format can't drift because the
// provider never produces it.
//
// Which engine runs is `settings.transcription.provider` — AssemblyAI or Deepgram,
// chosen on the settings page, applying to EVERYTHING (this module, Telegram voice
// notes, and the desktop microphone's streaming socket). Each engine stores its own
// key, so switching to compare them doesn't destroy the one you switched away from.
//
// TWO SHAPES OF WORK, and they want different APIs. A RECORDING (`transcribeFile`,
// the `transcribe` tool) can be an hour long with several people in it, so it goes
// to the async job API for timestamps and speaker labels and waits. A VOICE NOTE
// (`transcribeVoice`) is one person, seconds long, and its transcript is thrown
// away the moment it becomes a prompt — so it goes to the SYNC API and comes back
// in one request. See the voice-note section below for the measurements.
//
// No timeout here on purpose. Telegram and cron runs are already bounded by the
// watchdog (`codingAgent.maxRunMinutes`), and a desktop chat has the user and the
// Stop button. A second, shorter limit inside the tool would only be able to fail
// a transcription that was still going to succeed.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AssemblyAI } from 'assemblyai';
import { formatTranscript, extensionFor } from './transcriptFormat.js';

export interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  /** Present when the engine identified who was speaking. */
  speaker?: string;
}

export interface Transcript {
  text: string;
  segments: Segment[];
  durationMs: number;
}

export interface TranscriptionConfig {
  provider?: string;
  /** AssemblyAI's key. Keeps the generic name it was stored under. */
  apiKey?: string;
  deepgramApiKey?: string;
}

/** The default when nothing is stored — every provider read goes through here. */
export const DEFAULT_PROVIDER = 'assemblyai';

export function providerOf(config: TranscriptionConfig): string {
  return config.provider || DEFAULT_PROVIDER;
}

/**
 * The key for whichever engine is selected.
 *
 * Each engine has its OWN stored key, so switching between them to compare
 * quality doesn't destroy the one you switched away from. Callers pass the whole
 * `settings.transcription` slice and never have to know which field applies.
 */
export function keyFor(config: TranscriptionConfig): string | undefined {
  return providerOf(config) === 'deepgram' ? config.deepgramApiKey : config.apiKey;
}

/** Video containers we can pull an audio track out of before transcribing. */
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpeg', '.mpg', '.3gp']);

/** How often the async job is checked. See the note at its call site. */
const ASSEMBLYAI_POLL_MS = 200;

/** Deepgram's flagship model, and the one every number we compared was measured on. */
const DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

// ── Providers ────────────────────────────────────────────────────────────────

/**
 * AssemblyAI. Speaker labels are on: a recording with two people in it is far
 * more useful when you can tell who said what, and without them a transcript of a
 * conversation reads as one long run of contradictions.
 *
 * `utterances` is what makes the segments good — it comes back already grouped
 * into speaker turns, so we aren't inventing cue boundaries from word timings.
 */
async function assemblyai(filePath: string, apiKey: string): Promise<Transcript> {
  const client = new AssemblyAI({ apiKey });
  const result = await client.transcripts.transcribe({
    audio: filePath,
    speaker_labels: true,
  }, {
    // The SDK's default is 3 seconds, so a job that finished in one is still
    // discovered on the next tick. A recording takes long enough that the extra
    // requests are noise against the transcription itself.
    pollingInterval: ASSEMBLYAI_POLL_MS,
  });

  if (result.status === 'error') throw new Error(result.error || 'the transcription failed.');

  const segments: Segment[] = (result.utterances ?? []).map((u: any) => ({
    startMs: u.start ?? 0,
    endMs: u.end ?? 0,
    text: String(u.text ?? '').trim(),
    speaker: u.speaker ? `Speaker ${u.speaker}` : undefined,
  }));

  // Single-speaker audio can come back with no utterances at all; fall back to the
  // flat text as one segment so a valid recording never yields an empty file.
  if (!segments.length && result.text) {
    segments.push({ startMs: 0, endMs: result.audio_duration ? result.audio_duration * 1000 : 0, text: result.text.trim() });
  }

  return {
    text: String(result.text ?? '').trim(),
    segments,
    durationMs: (result.audio_duration ?? 0) * 1000,
  };
}

/**
 * Deepgram's pre-recorded endpoint: audio in, JSON out, ONE request.
 *
 * There is no job to submit and nothing to poll — which is the whole reason this
 * provider has no separate fast path for voice notes the way AssemblyAI does. It
 * also sniffs the container itself, so Telegram's OGG/Opus is sent byte-for-byte
 * and **ffmpeg never runs on this path**.
 *
 * `diarize` is off for a voice note (one person, and the labels would only be
 * noise) and on for a recording, which is where knowing who spoke is the point.
 */
async function deepgramRequest(
  body: Buffer,
  apiKey: string,
  { diarize }: { diarize: boolean },
): Promise<Transcript> {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    smart_format: 'true',
    punctuate: 'true',
    ...(diarize ? { diarize: 'true', utterances: 'true' } : {}),
  });

  const res = await fetch(`${DEEPGRAM_URL}?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}` },
    body: new Uint8Array(body),
  });

  if (!res.ok) {
    // Deepgram puts the reason in a JSON `err_msg`; fall back to the status when
    // the body isn't JSON (a gateway error, say).
    const detail = await res.text().catch(() => '');
    let reason = `HTTP ${res.status}`;
    try { reason = JSON.parse(detail).err_msg || reason; } catch { /* keep the status */ }
    throw new Error(`Deepgram rejected the audio: ${reason}`);
  }

  const json: any = await res.json();
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  const text = String(alt?.transcript ?? '').trim();
  const durationMs = Math.round((json?.metadata?.duration ?? 0) * 1000);

  // Deepgram reports seconds as floats; segments are milliseconds everywhere else.
  const segments: Segment[] = (json?.results?.utterances ?? []).map((u: any) => ({
    startMs: Math.round((u.start ?? 0) * 1000),
    endMs: Math.round((u.end ?? 0) * 1000),
    text: String(u.transcript ?? '').trim(),
    // `speaker` is an integer here, where AssemblyAI gives a letter. Both end up
    // as "Speaker X" so `transcriptFormat.ts` never learns the difference.
    speaker: u.speaker === undefined || u.speaker === null ? undefined : `Speaker ${u.speaker}`,
  })).filter((s: Segment) => s.text);

  // Same fallback as AssemblyAI: undiarized or single-speaker audio yields no
  // utterances, and a valid recording must never produce an empty transcript file.
  if (!segments.length && text) segments.push({ startMs: 0, endMs: durationMs, text });

  return { text, segments, durationMs };
}

async function deepgram(filePath: string, apiKey: string): Promise<Transcript> {
  // Read rather than stream: undici's streaming bodies need `duplex: 'half'` and
  // fail obscurely without it, and the AssemblyAI SDK buffers its upload too.
  return deepgramRequest(await fs.readFile(filePath), apiKey, { diarize: true });
}

const PROVIDERS: Record<string, (filePath: string, apiKey: string) => Promise<Transcript>> = {
  assemblyai,
  deepgram,
};

/** Extract an audio track to `outPath`. Requires ffmpeg (shipped in the companion image). */
function extractAudio(input: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -vn drops video, -ac 1 mixes to mono, 16 kHz is plenty for speech and keeps
    // the upload small. Overwrites without asking (-y) since outPath is ours.
    const ff = spawn('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', outPath], { stdio: 'ignore' });
    ff.on('error', () => reject(new Error('ffmpeg is not available, so the audio could not be extracted from that video.')));
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg could not read that video.'))));
  });
}

/**
 * Transcribe a file. Video is handled by pulling its audio track out first, so a
 * caller can pass whatever the user sent without checking what it is.
 *
 * `workDir` is where the extracted audio goes when the input is video.
 */
export async function transcribeFile(
  filePath: string,
  config: TranscriptionConfig,
  workDir: string,
): Promise<Transcript> {
  const provider = providerOf(config);
  const run = PROVIDERS[provider];
  if (!run) throw new Error(`"${provider}" is not a speech-to-text provider this app knows.`);
  const apiKey = keyFor(config);
  if (!apiKey) throw new Error('no-key');

  let audioPath = filePath;
  let extracted: string | null = null;
  if (VIDEO_EXTS.has(path.extname(filePath).toLowerCase())) {
    extracted = path.join(workDir, `audio-${path.basename(filePath)}.m4a`);
    await extractAudio(filePath, extracted);
    audioPath = extracted;
  }

  try {
    return await run(audioPath, apiKey);
  } finally {
    if (extracted) await fs.rm(extracted, { force: true }).catch(() => { /* best-effort */ });
  }
}

// ── Voice notes ──────────────────────────────────────────────────────────────
//
// A voice note is not a recording to be archived — it is the user talking, and
// every millisecond spent on it is the user watching a ✍ and waiting. The async
// job API is the wrong tool: it uploads, queues, and is then POLLED, and the
// SDK's polling interval is 3 seconds, so a clip whose transcript was ready in
// under a second is still discovered on the next tick.
//
// Measured end to end on a six-second clip, three runs, same audio, identical
// transcripts: the async path took 3.46–3.55s, the sync path 0.21–0.37s. The
// saving is roughly constant rather than proportional, because what it removes
// is the poll tick.

/** The sync API's ceiling: 2 minutes of audio, 40 MB per request. */
const SYNC_MAX_SECONDS = 120;

/** 16 kHz mono is all a speech model wants, and it keeps the upload small. */
const PCM_SAMPLE_RATE = 16_000;
const PCM_CHANNELS = 1;

/**
 * Decode audio to the raw PCM the sync API takes — in memory, touching no disk.
 *
 * It has to be PCM. The sync API does NOT accept Telegram's OGG/Opus: the SDK
 * labels every non-PCM part `audio/wav` and the server trusts that label rather
 * than sniffing the bytes, so an Ogg page arrives and comes back "malformed WAV:
 * file does not start with RIFF id". Raw PCM has no container header at all, so
 * there is nothing left to mislabel, and the SDK sends it as `audio/pcm` as soon
 * as `sample_rate`/`channels` are set.
 *
 * Piped in BOTH directions on purpose. WAV written to a pipe carries a
 * placeholder RIFF length, because ffmpeg cannot seek back to correct it — which
 * is the same class of malformed header the server just rejected. Headerless PCM
 * cannot have that problem. Measured at ~18ms for a six-second clip, so the
 * transcode is noise next to the request it feeds.
 */
function decodeToPcm(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', String(PCM_CHANNELS), '-ar', String(PCM_SAMPLE_RATE),
      '-f', 's16le', 'pipe:1',
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => err.push(c));
    ff.on('error', () => reject(new Error('ffmpeg is not available, so the audio could not be decoded.')));
    ff.on('close', (code) => (code === 0
      ? resolve(Buffer.concat(out))
      : reject(new Error(Buffer.concat(err).toString().trim() || 'ffmpeg could not read that audio.'))));
    // A pipe the child closed early (bad input) surfaces here, not as a throw.
    ff.stdin.on('error', () => { /* the close handler reports the real reason */ });
    ff.stdin.end(input);
  });
}

/**
 * Open the connection to the speech-to-text service before the audio is ready.
 *
 * The sync API is one request/response, so a cold call pays the full DNS + TCP +
 * TLS handshake on the critical path — measured at ~150ms of the ~370ms total.
 * Call this as soon as you know a voice note is coming and it overlaps with
 * fetching the audio, which is a round trip of its own. Best-effort by
 * definition: a failure here just means the next call opens its own connection.
 *
 * Safe to call with an unset key or a different provider — it does nothing. The
 * pooled connection is process-global (the SDK uses the global `fetch`, so Node
 * pools per origin), which is why warming here helps a call made anywhere else.
 */
export async function warmTranscription(config: TranscriptionConfig): Promise<void> {
  const apiKey = keyFor(config);
  if (!apiKey) return;
  // Deepgram needs none of this: its request goes to the same origin Node has
  // already pooled a connection to if anything else has called it, and there is
  // no SDK-level session to open. Nothing to warm, so nothing to do.
  if (providerOf(config) !== 'assemblyai') return;
  await new AssemblyAI({ apiKey }).sync.warm().catch(() => false);
}

/** The sync endpoint: audio in, text out, one HTTP request, nothing to poll. */
async function assemblyaiSync(audio: Buffer, apiKey: string): Promise<string> {
  const result = await new AssemblyAI({ apiKey }).sync.transcribe(await decodeToPcm(audio), {
    sample_rate: PCM_SAMPLE_RATE,
    channels: PCM_CHANNELS,
  });
  return String(result.text ?? '').trim();
}

/**
 * Transcribe a voice note. Bytes in, words out — `''` when there was no speech.
 * Throws `no-key` when speech-to-text isn't configured, like `transcribeFile`.
 *
 * `durationSeconds` is Telegram's own `voice.duration`, which is exact and free.
 * Without it we assume the clip is short and let the request decide, since the
 * fallback below covers being wrong.
 *
 * **The async path stays as the fallback, and that is the point.** Anything the
 * fast path can't take — a clip over two minutes, a provider that isn't
 * AssemblyAI, ffmpeg missing, the sync API erroring — goes back through the
 * route that has always worked rather than failing the user's message. A voice
 * note is the message, so losing one loses what the user said.
 */
export async function transcribeVoice(
  audio: Buffer,
  config: TranscriptionConfig,
  durationSeconds?: number,
): Promise<string> {
  const apiKey = keyFor(config);
  if (!apiKey) throw new Error('no-key');

  const provider = providerOf(config);
  const shortEnough = durationSeconds === undefined || durationSeconds <= SYNC_MAX_SECONDS;

  // Deepgram has ONE endpoint for everything, so there is no fast path to choose
  // and no ceiling to check — and it takes the OGG/Opus Telegram sent as-is, so
  // this path never touches ffmpeg. A failure here falls through to the job route
  // below like any other, which for Deepgram is the same endpoint via a temp file.
  if (provider === 'deepgram') {
    try {
      return (await deepgramRequest(audio, apiKey, { diarize: false })).text;
    } catch (e: any) {
      console.warn(`[transcribe] deepgram voice request failed, falling back: ${e?.message ?? e}`);
    }
  }

  if (provider === 'assemblyai' && shortEnough) {
    try {
      return await assemblyaiSync(audio, apiKey);
    } catch (e: any) {
      // Loud, because the fallback is 3s slower and silence here would make a
      // permanently broken fast path indistinguishable from a working one.
      console.warn(`[transcribe] sync path failed, falling back to the job API: ${e?.message ?? e}`);
    }
  }

  // The job API wants a path, so this branch — and only this branch — needs a
  // file on disk. The fast path above never writes one.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shockwave-voice-'));
  try {
    const file = path.join(dir, `voice-${crypto.randomBytes(4).toString('hex')}.ogg`);
    await fs.writeFile(file, audio);
    return (await transcribeFile(file, config, dir)).text;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
  }
}

// ── The tool ─────────────────────────────────────────────────────────────────

/** How much of the transcript comes back in the reply before we only hand over a path. */
const INLINE_LIMIT = 4000;

/**
 * `transcribe` — audio or video in, a transcript file out.
 *
 * The result is WRITTEN rather than returned. An hour of speech is tens of
 * thousands of characters, and returning that inline spends the context window on
 * something the agent can read back a line at a time if it actually needs to.
 * Short recordings still come back in full, because making the agent re-read a
 * ten-second voice note would be silly.
 *
 * `getConfig` and `scratchDir` are injected per session — same factory-closed-
 * over-host-I/O shape as `makeSendMessageTool`.
 */
export function makeTranscribeTool(
  getConfig: () => Promise<TranscriptionConfig>,
  scratchDir: string,
): any {
  return {
    name: 'transcribe',
    label: 'Transcribe',
    description:
      'Transcribe an audio or video file into text with timestamps and speaker labels. '
      + 'Writes the transcript to a file and returns its path; short transcripts are also returned in full. '
      + 'Use this whenever you need to know what was SAID in a recording.',
    promptSnippet: 'Turn a recording into a timestamped transcript.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the audio or video file.' },
        format: {
          type: 'string',
          enum: ['srt', 'vtt', 'text'],
          description: 'srt (default) and vtt carry timestamps; text is readable prose with no times.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const filePath = String(params?.path ?? '');
      const format = ['srt', 'vtt', 'text'].includes(params?.format) ? params.format : 'srt';
      const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

      if (!filePath) return fail('Give me the path of the file to transcribe.');

      try {
        if (!(await fs.stat(filePath)).isFile()) return fail(`${filePath} is not a file.`);
      } catch {
        return fail(`There is no file at ${filePath}.`);
      }

      const config = await getConfig();
      let result: Transcript;
      try {
        result = await transcribeFile(filePath, config, scratchDir);
      } catch (e: any) {
        if (e?.message === 'no-key') {
          // Name the engine that's actually selected — sending someone to add an
          // AssemblyAI key when Settings is set to Deepgram is worse than silence.
          const name = providerOf(config) === 'deepgram' ? 'Deepgram' : 'AssemblyAI';
          return fail(
            'Speech-to-text is not set up, so I can\'t transcribe that. '
            + `Tell the user to add a ${name} key in the desktop app under Settings → Transcription.`,
          );
        }
        return fail(`I couldn't transcribe that: ${e?.message ?? e}`);
      }

      if (!result.segments.length) {
        return { content: [{ type: 'text', text: 'That recording contains no speech I could make out.' }] };
      }

      const body = formatTranscript(result.segments, format);
      const out = path.join(scratchDir, `${path.basename(filePath)}${extensionFor(format)}`);
      await fs.mkdir(scratchDir, { recursive: true });
      await fs.writeFile(out, body, 'utf8');

      const minutes = Math.round(result.durationMs / 60_000);
      const head = `Transcribed ${minutes >= 1 ? `${minutes} min` : 'under a minute'} of audio `
        + `into ${result.segments.length} segments. Saved to ${out}`;

      return {
        content: [{
          type: 'text',
          text: body.length <= INLINE_LIMIT ? `${head}\n\n${body}` : `${head}\n\nIt is too long to include here — read the file.`,
        }],
      };
    },
  };
}
