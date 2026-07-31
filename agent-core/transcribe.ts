// Speech to text, and the `transcribe` tool built on it.
//
// One seam, two halves. A PROVIDER turns audio into timestamped segments; that is
// the whole contract, and `transcriptFormat.js` turns segments into SRT/VTT/text.
// Swapping AssemblyAI for something else means writing one function that returns
// segments — no other file changes, and the output format can't drift because the
// provider never produces it.
//
// Which engine runs is `settings.transcription.provider`, a field that already
// existed for the desktop microphone. There is no new setting and no new key.
//
// No timeout here on purpose. Telegram and cron runs are already bounded by the
// watchdog (`codingAgent.maxRunMinutes`), and a desktop chat has the user and the
// Stop button. A second, shorter limit inside the tool would only be able to fail
// a transcription that was still going to succeed.

import fs from 'node:fs/promises';
import path from 'node:path';
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
  apiKey?: string;
}

/** Video containers we can pull an audio track out of before transcribing. */
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpeg', '.mpg', '.3gp']);

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

const PROVIDERS: Record<string, (filePath: string, apiKey: string) => Promise<Transcript>> = {
  assemblyai,
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
  const provider = config.provider || 'assemblyai';
  const run = PROVIDERS[provider];
  if (!run) throw new Error(`"${provider}" is not a speech-to-text provider this app knows.`);
  if (!config.apiKey) throw new Error('no-key');

  let audioPath = filePath;
  let extracted: string | null = null;
  if (VIDEO_EXTS.has(path.extname(filePath).toLowerCase())) {
    extracted = path.join(workDir, `audio-${path.basename(filePath)}.m4a`);
    await extractAudio(filePath, extracted);
    audioPath = extracted;
  }

  try {
    return await run(audioPath, config.apiKey);
  } finally {
    if (extracted) await fs.rm(extracted, { force: true }).catch(() => { /* best-effort */ });
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

      let result: Transcript;
      try {
        result = await transcribeFile(filePath, await getConfig(), scratchDir);
      } catch (e: any) {
        if (e?.message === 'no-key') {
          return fail(
            'Speech-to-text is not set up, so I can\'t transcribe that. '
            + 'Tell the user to add an AssemblyAI key in the desktop app under Settings → Transcription.',
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
