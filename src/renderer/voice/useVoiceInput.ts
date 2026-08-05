import { useState, useRef, useEffect, useCallback } from 'react';

// Registered inline as a Blob URL so we don't need a separate static file.
const WORKLET_SRC = /* js */ `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const remaining = this.buffer.length - this.offset;
      const toCopy = Math.min(remaining, input.length - i);
      this.buffer.set(input.subarray(i, i + toCopy), this.offset);
      this.offset += toCopy;
      i += toCopy;
      if (this.offset >= this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
`;

/** "The audio stopped — flush what you have." One sentence, three spellings. */
const GOODBYE: Record<string, string> = {
  assemblyai: JSON.stringify({ type: 'Terminate' }),
  deepgram: JSON.stringify({ type: 'CloseStream' }),
  elevenlabs: JSON.stringify({ message_type: 'commit' }),
};

/** The vendors this file knows how to talk to. Anything else falls back below. */
const KNOWN = new Set(['assemblyai', 'deepgram', 'elevenlabs']);

/**
 * How long the socket stays open after we say "the audio stopped".
 *
 * The goodbye above asks the vendor to flush whatever is half-transcribed, and
 * that answer arrives over the SAME socket — so closing it in the next statement
 * threw away the end of every utterance. Not a race we lost sometimes: `close()`
 * moves readyState off OPEN synchronously and the HTML spec drops incoming
 * messages from that moment, so the flush could never land. Measured against a
 * live Deepgram socket: 0 messages after the goodbye as it was written, 3 with
 * the close deferred.
 *
 * The microphone and the audio graph are already torn down by then, so nothing
 * further is sent — this is a socket lingering to hear the last words, not a
 * recording that keeps running. The vendors close it themselves once flushed
 * (Deepgram answers and hangs up with 1000); this is only the backstop for one
 * that doesn't.
 */
const FLUSH_GRACE_MS = 1500;

/**
 * How long the mic may hear nothing before it turns itself off.
 *
 * The mic used to stop for exactly three reasons: a second click, a socket
 * error, and unmount. Nothing covered the one case no explicit trigger can —
 * you forgot. A forgotten mic is a live socket, a hot microphone, and a bill:
 * all three vendors charge by the minute the socket is CONNECTED, not the
 * minute you spoke into it.
 *
 * Generous on purpose. Cutting someone off while they think mid-sentence is a
 * worse failure than 45 wasted seconds, and this is a backstop rather than an
 * utterance boundary — the vendors already decide where those are.
 */
const SILENCE_TIMEOUT_MS = 45_000;

/** How often the silence check runs. Coarse — it's measuring 45 seconds. */
const SILENCE_CHECK_MS = 2000;

/**
 * RMS below which a chunk counts as silence.
 *
 * A mic's noise floor sits around 0.005–0.02 and speech runs an order of
 * magnitude above it, so this discriminates cleanly. It is not the only
 * activity signal — a transcript message counts too (see `markActivity`), which
 * is what keeps a quiet-but-working microphone from being timed out by its own
 * gain settings.
 */
const SILENCE_RMS_FLOOR = 0.02;

/**
 * Every mounted `useVoiceInput` re-asks when the voice settings change.
 *
 * There are two instances — the chat composer's and the Settings page's — with
 * no state between them, and the token mint runs ONCE per mount. So fixing a
 * rejected key on the Settings page left the composer's copy holding the old
 * refusal for the life of the app: its mic stayed hidden, Verify went green, and
 * nothing connected the two. Restarting was the only way back.
 *
 * A module-level fan-out rather than an IPC push because **`settings:changed`
 * never fires for the renderer's own writes** (main passes `notify: false` — the
 * renderer already has what it just wrote), and saving the key here IS a
 * renderer write. The push is still subscribed to below for changes that come
 * from elsewhere; this covers the ones that don't.
 */
const configListeners = new Set<() => void>();

/** Tell every mounted hook the voice config moved — call after saving a key,
 *  switching provider, or removing one. */
export function notifyVoiceConfigChanged(): void {
  for (const fn of configListeners) fn();
}

/** Base64 without a FileReader round trip — the worklet fires every ~256ms. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a buffer
  // this size and throws rather than degrading.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Reusable voice input hook for real-time transcription, over AssemblyAI or
// Deepgram — whichever `transcription.provider` names. Main resolves that and
// returns it alongside the token, so this file never reads settings.
//
// THE AUDIO IS IDENTICAL for both: 16 kHz mono PCM s16le, which is what the
// worklet below already produces. Only the socket URL, the shape of what comes
// back, and the goodbye message differ — everything between the microphone and
// `ws.send` is shared, and that is why supporting two engines costs so little.
//
// Performance: prefetches a token on mount and caches it for 50s (both engines
// mint 60s tokens). On click, consumes the cached token instantly and kicks off
// a background refresh so the next click is also instant. Without this, every
// click would pay the renderer→main→provider round-trip.
export function useVoiceInput({ getToken, onTranscript, onPartialTranscript, onError, onVolumeChange }) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  // WHY the mint refused, kept rather than reduced to `voiceAvailable: false`.
  // The reason is the whole difference between a control that looks unbuilt and
  // one that can be fixed: "Deepgram rejected the key for streaming (HTTP 403) —
  // it needs Member permissions" is one click from solved, and it was being
  // thrown away here while Settings → Verify printed the same sentence.
  const [voiceError, setVoiceError] = useState<string>('');
  const wsRef = useRef<any>(null);
  const streamRef = useRef<any>(null);
  const audioCtxRef = useRef<any>(null);
  const workletRef = useRef<any>(null);
  const sourceRef = useRef<any>(null);
  const cleaningUpRef = useRef(false);
  const connectingRef = useRef(false);

  /**
   * Drop everything the socket still has to say.
   *
   * Set by `stopRecording({ discardPending: true })`, which is what the
   * composer's SEND does. The goodbye in `cleanup` asks the vendor to flush,
   * and that flush lands up to FLUSH_GRACE_MS later — *after* the draft has
   * been cleared for the message that was just sent. Without this, the tail of
   * the sentence you sent opens your NEXT message.
   *
   * On AssemblyAI it is worse than a stray tail: its final `transcript` is the
   * whole turn rather than the remainder, and the composer commits the partial
   * itself at send, so the late final re-appends every word a second time.
   *
   * Losing that tail is the correct trade, not a compromise: hitting send is a
   * statement that the utterance is over, and what the composer showed at that
   * moment is what got sent.
   */
  const discardRef = useRef(false);
  /** Last moment the mic heard anything — speech OR a transcript message. */
  const lastActivityRef = useRef(0);
  const silenceTimerRef = useRef<any>(null);

  const tokenRef = useRef<any>(null);
  const tokenTimeRef = useRef(0);
  // How long a cached token stays usable, as a FRACTION of the lifetime the mint
  // reported — never a constant. It was 50s, tuned to the 60s tokens the first two
  // engines issue, and a constant is wrong the moment a vendor issues anything
  // else. ElevenLabs issues 15 minutes; caching that for 50s would just throw away
  // a good token, and caching it for its full life would hand back a spent one.
  const CACHE_FRACTION = 0.8;

  // Which engine the live socket belongs to. Read by cleanup (the two want
  // different goodbye messages) and by the message handler.
  const providerRef = useRef<string>('assemblyai');
  // Deepgram only: finalized segments since the last end-of-utterance. Its
  // `Results` messages each cover a SEGMENT rather than the turn so far, so a
  // full utterance is the finalized ones concatenated — see the handler below.
  const dgCommittedRef = useRef('');

  // Callers pass `getToken` as an inline arrow, so it's a new function every
  // render. Held in a ref instead of a dep: as a dep it made fetchVoiceToken new
  // every render too, which turned the mount-only prefetch below into a
  // fetch-on-every-render — one AssemblyAI token request per keystroke while
  // typing the key, all racing each other.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  // Only the newest request may publish. Without this the LAST response to land
  // won, not the newest one: on Settings → Agent Voice the request fired before
  // the key was stored (which fails) could resolve after the one fired after it
  // (which succeeds), pinning voiceAvailable false. That's why "Test microphone"
  // stayed greyed out until you left the page and came back.
  const tokenReqRef = useRef(0);

  const fetchVoiceToken = useCallback(async () => {
    const req = ++tokenReqRef.current;
    let result;
    try {
      result = await getTokenRef.current();
    } catch (err) {
      // The IPC REJECTS (rather than returning {error}) when the companion is
      // unreachable, so this has to catch as well as read the result.
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    const stale = req !== tokenReqRef.current;
    if (!result.error) {
      // Cache the token even when stale — it's still valid, and dropping it
      // would just cost the next click a round-trip.
      //
      // The PROVIDER is cached WITH it, never re-derived. A token is minted
      // against one engine and is meaningless to the other, so the two have to
      // travel together — caching the token alone let the mount prefetch hand a
      // Deepgram token to the AssemblyAI branch on the very first click.
      // The PROVIDER and the token's own RULES are cached with it, never
      // re-derived. A token is minted against one engine and is meaningless to
      // the other, so those have to travel together — caching the token alone let
      // the mount prefetch hand a Deepgram token to the AssemblyAI branch on the
      // very first click. `singleUse` rides along for the same reason: it is a
      // fact about this token, not about the engine the settings happen to name
      // by the time somebody clicks.
      tokenRef.current = {
        token: result.token,
        provider: result.provider,
        tokenTtlMs: result.tokenTtlMs,
        singleUse: result.singleUse,
      };
      tokenTimeRef.current = Date.now();
      if (!stale) { setVoiceAvailable(true); setVoiceError(''); }
    } else if (!stale) {
      setVoiceAvailable(false);
      setVoiceError(result.error);
    }
    return result;
  }, []);

  useEffect(() => {
    fetchVoiceToken();
  }, [fetchVoiceToken]);

  // Re-ask when the voice settings move. Two sources, because neither covers the
  // other: the module fan-out above carries THIS window's own saves (which the
  // IPC push deliberately skips), and `settings:changed` carries everything that
  // happened elsewhere — another machine, the companion, a `/voice` command.
  //
  // The push fires for every settings write in the app, so it is filtered rather
  // than minting a token each time. Two triggers, and the first is the one that
  // matters: **re-ask whenever we have no working token**, because a key being
  // replaced with a good one leaves `hasVoiceKey` true→true and changes no
  // fingerprint we can see (the renderer never receives key VALUES). The
  // fingerprint catches the rest — provider switched, a key added or removed.
  const availableRef = useRef(voiceAvailable);
  availableRef.current = voiceAvailable;
  useEffect(() => {
    const refetch = () => { fetchVoiceToken(); };
    configListeners.add(refetch);
    let fingerprint = '';
    const off = window.api.settings.onChanged?.(({ settings }: any) => {
      // BOTH provider fields. The microphone has its own assignment, and it is
      // the one this hook actually mints against — watching only `provider`
      // would miss the whole point of pointing the mic somewhere else.
      const next = JSON.stringify([
        settings?.transcription?.provider,
        settings?.transcription?.micProvider,
        settings?.hasVoiceKey,
      ]);
      const moved = fingerprint !== '' && next !== fingerprint;
      fingerprint = next;
      if (moved || !availableRef.current) refetch();
    });
    return () => { configListeners.delete(refetch); off?.(); };
  }, [fetchVoiceToken]);

  const getReadyToken = useCallback(async () => {
    const cached = tokenRef.current;
    // A cached token is consumed either way — `tokenRef.current = null` below is
    // what makes this safe for a SINGLE-USE token: the prefetch that follows
    // replaces it, so the next click gets a fresh one rather than a spent one.
    // (ElevenLabs' is consumed by connecting. Reusing it fails at connect time
    // with a bare onerror, which surfaces as "Voice connection error" and says
    // nothing about why the first click worked and the second didn't.)
    const ttl = typeof cached?.tokenTtlMs === 'number' ? cached.tokenTtlMs : 60_000;
    if (cached && Date.now() - tokenTimeRef.current < ttl * CACHE_FRACTION) {
      tokenRef.current = null;
      fetchVoiceToken();
      return cached;
    }
    return fetchVoiceToken();
  }, [fetchVoiceToken]);

  const cleanup = useCallback(() => {
    if (cleaningUpRef.current) return;
    cleaningUpRef.current = true;

    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (workletRef.current) {
      workletRef.current.disconnect();
      workletRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws.readyState === WebSocket.OPEN) {
        // All three want to be told the audio has stopped so they can flush
        // whatever is half-transcribed; they just spell it differently. The
        // answer comes back on this socket, so it is left open long enough to
        // arrive — see FLUSH_GRACE_MS. `onmessage` is still attached, so those
        // last words commit through the same path as every other one.
        ws.send(GOODBYE[providerRef.current] ?? GOODBYE.assemblyai);
        setTimeout(() => { try { ws.close(); } catch { /* already gone */ } }, FLUSH_GRACE_MS);
      } else {
        ws.close();
      }
    }

    connectingRef.current = false;
    setIsConnecting(false);
    setIsRecording(false);
    cleaningUpRef.current = false;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startRecording = useCallback(async () => {
    if (connectingRef.current || cleaningUpRef.current) return;
    connectingRef.current = true;
    setIsConnecting(true);
    // A previous stop may have left this set; a new recording is never a
    // continuation of the one that was discarded.
    discardRef.current = false;

    try {
      const result = await getReadyToken();
      if (result.error) {
        onError?.(result.error);
        cleanup();
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const provider = KNOWN.has(result.provider) ? result.provider : 'assemblyai';
      providerRef.current = provider;
      dgCommittedRef.current = '';

      // The two engines authenticate the socket DIFFERENTLY, and Deepgram's is
      // not what its docs suggest. A browser WebSocket can't set an
      // Authorization header, so the credential has to ride in the URL or in the
      // subprotocol — tested against a live grant token, all four ways:
      //
      //   ?access_token=<jwt>            401 INVALID_AUTH   (the documented one)
      //   ?token=<jwt>                   401 INVALID_AUTH
      //   Sec-WebSocket-Protocol: token  401 INVALID_AUTH   (that's for raw keys)
      //   Sec-WebSocket-Protocol: bearer OPEN ✅
      //
      // So a grant JWT is only accepted as the `bearer` subprotocol. Don't
      // "simplify" this back to a query param — it fails at connect time with a
      // bare onerror, which surfaces as "Voice connection error" and says nothing.
      //
      // ElevenLabs takes its single-use token as a plain `?token=` query param and
      // `commit_strategy=vad` so it decides where an utterance ends, matching what
      // the other two do on their own.
      const url = provider === 'deepgram'
        ? 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16'
          + '&sample_rate=16000&channels=1&interim_results=true&smart_format=true&punctuate=true'
        : provider === 'elevenlabs'
          ? `wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=${result.token}`
            + '&model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad'
          : `wss://streaming.assemblyai.com/v3/ws?token=${result.token}&sample_rate=16000&encoding=pcm_s16le`;

      const ws = provider === 'deepgram'
        ? new WebSocket(url, ['bearer', result.token])
        : new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
        workletRef.current = workletNode;

        workletNode.port.onmessage = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.data;
          const int16 = new Int16Array(float32.length);
          let sum = 0;
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            sum += s * s;
          }
          // Two engines take the PCM frames raw; ElevenLabs takes them base64 in a
          // JSON envelope. Same 16 kHz mono s16le bytes either way — the encoding
          // is the only thing that differs, which is what keeps a third engine
          // cheap. Sending raw frames to ElevenLabs is silently accepted by the
          // socket and transcribes nothing.
          if (provider === 'elevenlabs') {
            ws.send(JSON.stringify({
              message_type: 'input_audio_chunk',
              audio_base_64: toBase64(new Uint8Array(int16.buffer)),
              sample_rate: 16000,
            }));
          } else {
            ws.send(int16.buffer);
          }
          const rms = Math.sqrt(sum / float32.length);
          if (rms > SILENCE_RMS_FLOOR) lastActivityRef.current = Date.now();
          if (onVolumeChange) onVolumeChange(rms);
        };

        source.connect(workletNode);
        workletNode.connect(audioCtx.destination);
        setIsConnecting(false);
        setIsRecording(true);

        // The silence backstop starts when the audio does, not when the user
        // clicked — connecting can take a moment and that time isn't silence.
        lastActivityRef.current = Date.now();
        silenceTimerRef.current = setInterval(() => {
          if (Date.now() - lastActivityRef.current < SILENCE_TIMEOUT_MS) return;
          // Stop quietly. The meter vanishing IS the message, and a toast for
          // "you stopped talking" would fire in exactly the moment the user has
          // already walked away from the screen. The pending flush is kept —
          // after this long there is nothing in it, and discarding on a timeout
          // would be throwing away words nobody asked us to throw away.
          cleanup();
        }, SILENCE_CHECK_MS);
      };

      ws.onmessage = (event) => {
        // The socket outlives the recording by FLUSH_GRACE_MS. When the stop
        // was a SEND, everything arriving in that window belongs to a message
        // that has already gone — see discardRef.
        if (discardRef.current) return;
        try {
          const data = JSON.parse(event.data);

          // Words are activity even when the meter says otherwise: a quiet
          // microphone that the vendor is still transcribing is being used.
          lastActivityRef.current = Date.now();

          // AssemblyAI: `transcript` is the whole turn so far, so each message
          // REPLACES what came before and end_of_turn is simply the last one.
          if (data.type === 'Turn') {
            const text = data.transcript?.trim();
            if (data.end_of_turn) {
              if (text) onTranscript(text);
              onPartialTranscript?.('');
            } else {
              onPartialTranscript?.(text || '');
            }
            return;
          }

          // Deepgram: each `Results` covers a SEGMENT, so the pieces ACCUMULATE.
          // `is_final` freezes a segment, `speech_final` says the utterance ended
          // — so a full utterance is every finalized segment since the last one.
          // Treating each message as the whole turn (the AssemblyAI reading)
          // would commit only the last few words of anything you said.
          // ElevenLabs names the kind on `message_type` and, unlike Deepgram,
          // hands back the WHOLE committed utterance rather than a segment — so
          // this reads like AssemblyAI's branch, not Deepgram's, and nothing
          // accumulates. `final_transcript` and `committed_transcript` both mean
          // "these words are settled"; the partial is the live one.
          if (data.message_type) {
            const text = String(data.text ?? '').trim();
            if (data.message_type === 'partial_transcript') {
              onPartialTranscript?.(text);
            } else if (data.message_type === 'committed_transcript' || data.message_type === 'final_transcript') {
              if (text) onTranscript(text);
              onPartialTranscript?.('');
            } else if (String(data.message_type).endsWith('_error')) {
              // Auth, quota and rate-limit all arrive here rather than as a socket
              // error, so without this they close the mic with no explanation.
              onError?.(String(data.message ?? data.message_type));
            }
            return;
          }

          if (data.type === 'Results') {
            const text = String(data.channel?.alternatives?.[0]?.transcript ?? '').trim();
            if (data.is_final) {
              if (text) {
                dgCommittedRef.current = dgCommittedRef.current ? `${dgCommittedRef.current} ${text}` : text;
              }
              if (data.speech_final) {
                const whole = dgCommittedRef.current.trim();
                dgCommittedRef.current = '';
                if (whole) onTranscript(whole);
                onPartialTranscript?.('');
              } else {
                // Frozen but the utterance is still going — show it as partial so
                // the words stay on screen until speech_final commits them.
                onPartialTranscript?.(dgCommittedRef.current);
              }
            } else {
              const live = dgCommittedRef.current ? `${dgCommittedRef.current} ${text}` : text;
              onPartialTranscript?.(live);
            }
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        onError?.('Voice connection error');
        cleanup();
      };

      ws.onclose = () => {
        cleanup();
      };
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        onError?.('Microphone permission denied');
      } else {
        onError?.('Failed to start voice input');
      }
      cleanup();
    }
  }, [getReadyToken, onTranscript, onPartialTranscript, onError, onVolumeChange, cleanup]);

  /**
   * Stop the mic. `discardPending` throws away whatever the vendor still owes
   * us — pass it when the words already went somewhere (the composer's send).
   * Everything else (the button, Escape, a new chat) wants the flush.
   */
  const stopRecording = useCallback((opts?: { discardPending?: boolean }) => {
    // Read defensively: this is wired straight to onClick in places, so the
    // argument can be a MouseEvent rather than an options object.
    if (opts?.discardPending === true) discardRef.current = true;
    cleanup();
  }, [cleanup]);

  // No `recheck` here any more. Re-asking used to be the caller's job, which
  // meant only the caller that remembered got a fresh answer — the Settings page
  // did, the composer did not, and a fixed key left the mic hidden until
  // restart. `notifyVoiceConfigChanged()` reaches every instance instead, so
  // there is one mechanism rather than one per call site.
  return { voiceAvailable, voiceError, isConnecting, isRecording, startRecording, stopRecording };
}
