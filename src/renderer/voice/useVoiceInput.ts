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
  const wsRef = useRef<any>(null);
  const streamRef = useRef<any>(null);
  const audioCtxRef = useRef<any>(null);
  const workletRef = useRef<any>(null);
  const sourceRef = useRef<any>(null);
  const cleaningUpRef = useRef(false);
  const connectingRef = useRef(false);

  const tokenRef = useRef<any>(null);
  const tokenTimeRef = useRef(0);
  const TOKEN_MAX_AGE = 50_000;

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
  // won, not the newest one: on Settings → Transcription the request fired before
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
      tokenRef.current = { token: result.token, provider: result.provider };
      tokenTimeRef.current = Date.now();
      if (!stale) setVoiceAvailable(true);
    } else if (!stale) {
      setVoiceAvailable(false);
    }
    return result;
  }, []);

  useEffect(() => {
    fetchVoiceToken();
  }, [fetchVoiceToken]);

  const getReadyToken = useCallback(async () => {
    if (tokenRef.current && Date.now() - tokenTimeRef.current < TOKEN_MAX_AGE) {
      const cached = tokenRef.current;
      tokenRef.current = null;
      fetchVoiceToken();
      return cached;
    }
    return fetchVoiceToken();
  }, [fetchVoiceToken]);

  const cleanup = useCallback(() => {
    if (cleaningUpRef.current) return;
    cleaningUpRef.current = true;

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
      if (wsRef.current.readyState === WebSocket.OPEN) {
        // Both engines want to be told the audio has stopped so they can flush
        // whatever is half-transcribed; they just spell it differently.
        wsRef.current.send(JSON.stringify({
          type: providerRef.current === 'deepgram' ? 'CloseStream' : 'Terminate',
        }));
      }
      wsRef.current.close();
      wsRef.current = null;
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

      const provider = result.provider === 'deepgram' ? 'deepgram' : 'assemblyai';
      providerRef.current = provider;
      dgCommittedRef.current = '';

      // Deepgram takes the token as a query param on purpose: a browser
      // WebSocket cannot set an Authorization header, and the documented
      // alternative (Sec-WebSocket-Protocol) is the fallback for environments
      // that can't do even this.
      const url = provider === 'deepgram'
        ? 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16'
          + '&sample_rate=16000&channels=1&interim_results=true&smart_format=true'
          + `&punctuate=true&access_token=${result.token}`
        : `wss://streaming.assemblyai.com/v3/ws?token=${result.token}&sample_rate=16000&encoding=pcm_s16le`;

      const ws = new WebSocket(url);
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
          ws.send(int16.buffer);
          if (onVolumeChange) onVolumeChange(Math.sqrt(sum / float32.length));
        };

        source.connect(workletNode);
        workletNode.connect(audioCtx.destination);
        setIsConnecting(false);
        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

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

  const stopRecording = useCallback(() => {
    cleanup();
  }, [cleanup]);

  // `recheck` is for the settings page: the prefetch above is mount-only, and
  // the key is read server-side, so saving a new key needs an explicit re-ask.
  return { voiceAvailable, isConnecting, isRecording, startRecording, stopRecording, recheck: fetchVoiceToken };
}
