// Server-side voice transcription for Telegram voice notes, via AssemblyAI —
// the same `transcription.apiKey` setting the desktop uses for its microphone.
// The caller reads it (it reads the neighbouring `echoTelegramTranscript` from
// the same settings object) and hands it in, so one voice note costs one
// settings read, not one per consumer.
//
// Telegram sends voice notes as OGG/Opus, which AssemblyAI accepts as-is, so the
// audio is uploaded byte-for-byte with no conversion.

const BASE = 'https://api.assemblyai.com/v2';
const POLL_MS = 1500;
const MAX_POLLS = 60; // ~90s ceiling — a Telegram voice note is far shorter

/**
 * Transcribe audio. Returns the text, `null` when no API key is configured (the
 * caller should say so rather than ignore the user), or `''` when the audio held
 * no speech. Throws if AssemblyAI reports a failure.
 */
export async function transcribeAudio(apiKey: string | undefined, audio: Buffer): Promise<string | null> {
  if (!apiKey) return null;
  const headers = { authorization: apiKey };

  const up = await fetch(`${BASE}/upload`, { method: 'POST', headers, body: audio });
  if (!up.ok) throw new Error(`uploading the audio failed (HTTP ${up.status}).`);
  const { upload_url: uploadUrl } = await up.json() as any;

  const started = await fetch(`${BASE}/transcript`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: uploadUrl }),
  });
  if (!started.ok) throw new Error(`starting the transcription failed (HTTP ${started.status}).`);
  const { id } = await started.json() as any;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await fetch(`${BASE}/transcript/${id}`, { headers });
    const job = await res.json() as any;
    if (job.status === 'completed') return (job.text ?? '').trim();
    if (job.status === 'error') throw new Error(job.error || 'transcription failed.');
  }
  throw new Error('the transcription timed out.');
}
