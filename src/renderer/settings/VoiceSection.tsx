import React, { useEffect, useRef, useState } from 'react';
import { useVoiceInput } from '../voice/useVoiceInput.js';
import { useCredentialField } from './useCommitField';
import { VoiceBars } from '../voice/VoiceBars.jsx';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { removeCredential } from './credentialField';
import CredentialRow from './CredentialRow';
import ErrorMessage from '../ErrorMessage.jsx';
import { listenProviders, speakProviders, voiceProvider } from '../../../agent-core/voiceProviders.js';

// Settings page for voice, in both directions.
//
// TWO GROUPS, TWO PROVIDER CHOICES, ONE KEY PER VENDOR. The matrix is not square
// — AssemblyAI transcribes and cannot synthesize — so a single "voice provider"
// dropdown would either hide a vendor people already use or quietly speak with
// somebody else's account. Listening and speaking are therefore chosen
// separately, from the table in `agent-core/voiceProviders.ts`, and BOTH read the
// same per-vendor key: pick Deepgram for both and you enter it once.
//
// WHAT "VERIFY" ACTUALLY DOES. AssemblyAI ships no key-check endpoint, so
// verifying is "make the cheapest real request and read the status code".
// `voice:getToken` already is that request — it mints the streaming token against
// the stored key — so Verify reuses it rather than adding a second HTTP surface.
// Deepgram gates transcription and streaming separately, so it gets a second
// question and a restricted key comes back `ok: true, canStream: false`, which is
// a note rather than a rejection.
//
// The mic test's first-click side effect is what matters most: the browser asks
// for microphone permission HERE, persistently grants it for the Electron origin,
// and the chat composer's mic skips the prompt forever after.

const LISTEN = listenProviders();
const SPEAK = speakProviders();

export default function VoiceSection({
  transcription,
  onTranscriptionChange,
  speech,
  hasVoiceKey,
  onSpeechChange,
  onVoiceKeyChange,
  voiceReply,
  onVoiceReplyChange,
  hasWorkspace,
}: any) {
  const listenSlug = voiceProvider(transcription?.provider) ? transcription.provider : 'assemblyai';
  const listen = voiceProvider(listenSlug)!;
  const speakSlug = speech?.provider && voiceProvider(speech.provider)?.speak ? speech.provider : '';
  const speak = speakSlug ? voiceProvider(speakSlug)! : null;

  // Whether a vendor has a key stored. A MAP, not a boolean — the flag for a
  // wildcard credential is one entry per vendor (see stripCredentials).
  const keyStored = (slug: string) => !!hasVoiceKey?.[slug];

  // Spread the whole slice: these setters REPLACE the renderer's copy, so a bare
  // patch would drop sibling fields until main's next `settings:changed` push.
  // The diff in settingsDiff.ts is what stops unchanged fields being written.
  const updateListen = (patch: any) => onTranscriptionChange?.({ ...transcription, provider: listenSlug, ...patch });
  const updateSpeak = (patch: any) => onSpeechChange?.({ ...speech, ...patch });

  const recheckRef = useRef<((...args: any[]) => Promise<any>) | null>(null);
  const runVerifyRef = useRef<(() => void) | null>(null);

  const [verifyState, setVerifyState] = useState<any>({ status: 'idle' });

  // Each verify claims a ticket. Two ways to get concurrent checks — blur then
  // click Verify, or click Verify then edit the box — and without this the LAST
  // response to land wins rather than the newest request.
  const verifyReq = useRef(0);
  // The save started by a blur, so verify can wait for it: main mints against the
  // key it resolves from the companion, not against anything on screen, so a
  // verify that doesn't wait checks the PREVIOUS key.
  const savingRef = useRef<Promise<any> | null>(null);

  const runVerify = async () => {
    const req = ++verifyReq.current;
    setVerifyState({ status: 'checking' });
    await savingRef.current;
    if (verifyReq.current !== req) return;
    const [res] = await Promise.all([
      window.api.voice.verifyKey(),
      recheckRef.current?.(),
    ]);
    if (verifyReq.current !== req) return;
    if (!res?.ok) setVerifyState({ status: 'error', error: res?.error || 'Could not check that key.' });
    else if (res.canStream === false) setVerifyState({ status: 'partial', detail: res.streamError });
    else setVerifyState({ status: 'ok' });
  };
  runVerifyRef.current = runVerify;

  // ── Keys ───────────────────────────────────────────────────────────────────
  //
  // One box per vendor SLOT (listening's and speaking's), but they write to the
  // same per-vendor map — so when both halves point at one vendor, only one box
  // is drawn and it is the same key. Write-only: main never sends a key down, so
  // the draft starts empty and only something typed is ever committed.

  const listenKeyField = useCredentialField((next) => {
    savingRef.current = Promise.resolve(onVoiceKeyChange?.(listenSlug, next));
    runVerifyRef.current?.();
  });
  const speakKeyField = useCredentialField((next) => {
    if (!speakSlug) return;
    onVoiceKeyChange?.(speakSlug, next);
  });

  const onListenProviderChange = (next: string) => {
    if (next === listenSlug) return;
    // Switching engines changes what every control below refers to, so the verify
    // row drops — a green "key accepted" from one vendor sitting under another's
    // empty field would be a straight lie. The draft goes for the same reason.
    verifyReq.current++;
    setVerifyState({ status: 'idle' });
    listenKeyField.onChange('');
    updateListen({ provider: next });
    // Re-ask with the new vendor's key so Test microphone enables or greys to
    // match. Bare `recheck`, not `runVerify` — a red error just for changing a
    // dropdown is noise, not a verdict.
    recheckRef.current?.();
  };

  const onListenKeyChange = (value: string) => {
    listenKeyField.onChange(value);
    verifyReq.current++;
    if (verifyState.status !== 'idle') setVerifyState({ status: 'idle' });
  };

  const [removing, setRemoving] = useState('');
  const removeKey = async (slug: string) => {
    setRemoving(slug);
    try {
      const r = await removeCredential(`voiceKeys.${slug}`);
      verifyReq.current++;
      if (!r?.ok) setVerifyState({ status: 'error', error: r?.error || 'Could not remove the key.' });
      else setVerifyState({ status: 'idle' });
      // Bare `recheck`, not `runVerify`: publishing a red "not configured" under a
      // key the user just chose to delete would report a success as an error.
      recheckRef.current?.();
    } finally {
      setRemoving('');
    }
  };

  // ── Voices ─────────────────────────────────────────────────────────────────
  //
  // Fetched from the vendor rather than hardcoded, so a voice added upstream (or
  // one the user cloned themselves, which only they have) shows up without a
  // release. Listing needs the API key, so it happens in main.
  const [voices, setVoices] = useState<any[]>([]);
  const [voicesError, setVoicesError] = useState('');
  const [loadingVoices, setLoadingVoices] = useState(false);
  const voicesReq = useRef(0);

  const loadVoices = async () => {
    const req = ++voicesReq.current;
    setLoadingVoices(true);
    setVoicesError('');
    try {
      const res = await window.api.voice.listVoices();
      if (voicesReq.current !== req) return;
      if (res?.error) { setVoices([]); setVoicesError(res.error); }
      else setVoices(res?.voices ?? []);
    } catch (e: any) {
      if (voicesReq.current === req) setVoicesError(e?.message ?? 'Could not load the voice list.');
    } finally {
      if (voicesReq.current === req) setLoadingVoices(false);
    }
  };

  // Re-fetch whenever the vendor or its key changes — both change what the list
  // IS, and a list left over from the other vendor is worse than none.
  useEffect(() => {
    if (!speakSlug || !keyStored(speakSlug)) { setVoices([]); setVoicesError(''); return; }
    loadVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakSlug, hasVoiceKey?.[speakSlug]]);

  const previewRef = useRef<HTMLAudioElement | null>(null);
  const selectedVoice = voices.find((v) => v.id === speech?.voiceId);
  const playPreview = () => {
    if (!selectedVoice?.preview) return;
    previewRef.current?.pause();
    const audio = new Audio(selectedVoice.preview);
    previewRef.current = audio;
    audio.play().catch(() => { /* a preview that won't play is not worth an error */ });
  };
  useEffect(() => () => previewRef.current?.pause(), []);

  // ── Mic test ───────────────────────────────────────────────────────────────

  const volumeRef = useRef(0);
  const [partial, setPartial] = useState('');
  const [finalText, setFinalText] = useState('');
  const [testError, setTestError] = useState<any>(null);

  const { voiceAvailable, isConnecting, isRecording, startRecording, stopRecording, recheck } = useVoiceInput({
    getToken: () => window.api.voice.getToken(),
    onTranscript: (t: string) => {
      setFinalText((prev) => (prev ? prev + ' ' : '') + t);
      setPartial('');
    },
    onPartialTranscript: setPartial,
    onError: setTestError,
    onVolumeChange: (rms: number) => { volumeRef.current = rms; },
  });
  recheckRef.current = recheck;

  const onTest = () => {
    setTestError(null);
    if (isRecording || isConnecting) {
      stopRecording();
    } else {
      setFinalText('');
      setPartial('');
      startRecording();
    }
  };

  const buttonLabel = isConnecting ? 'Connecting…' : isRecording ? 'Stop' : 'Test microphone';
  const listenKeyStored = keyStored(listenSlug);
  const speakKeyStored = !!speakSlug && keyStored(speakSlug);
  // One vendor doing both jobs is one account and one key, so the speaking group
  // shows the stored state instead of a second box asking for the same string.
  const sharesKey = !!speakSlug && speakSlug === listenSlug;

  const signupLink = (p: any) => (
    <a
      href="#"
      className="text-primary underline underline-offset-2 hover:opacity-80"
      onClick={(e) => { e.preventDefault(); window.api.openExternal(p.signupUrl); }}
    >{p.signupHost}</a>
  );

  return (
    <SettingsSection
      title="Agent Voice"
      description="Speech in and out. One key per provider, shared by both directions, encrypted at rest on your companion server."
    >
      <SettingsGroup
        title="Listen"
        description="Speech to text — the microphone, Telegram voice notes, and the agent's transcribe tool."
      >
        <Field>
          <FieldLabel htmlFor="voice-listen-provider">Provider</FieldLabel>
          <Select value={listenSlug} onValueChange={onListenProviderChange}>
            <SelectTrigger id="voice-listen-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LISTEN.map((p) => <SelectItem key={p.slug} value={p.slug}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <FieldDescription>Get a key from {signupLink(listen)}.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="voice-listen-key">{listen.label} API key</FieldLabel>
          <CredentialRow
            id="voice-listen-key"
            saved={listenKeyStored}
            value={listenKeyField.value}
            onChange={(e: any) => onListenKeyChange(e.target.value)}
            onBlur={listenKeyField.onBlur}
            actions={
              <>
                {/* This page's one primary: nothing else here means anything until
                    the key is known good. Enabled whenever there is something to
                    check — typed here or already stored. */}
                <Button
                  onClick={runVerify}
                  disabled={(!listenKeyField.value.trim() && !listenKeyStored) || verifyState.status === 'checking'}
                >
                  {verifyState.status === 'checking' ? 'Verifying…' : 'Verify'}
                </Button>
                {listenKeyStored && (
                  <Button variant="destructive" onClick={() => removeKey(listenSlug)} disabled={removing === listenSlug}>
                    {removing === listenSlug ? 'Removing…' : 'Remove'}
                  </Button>
                )}
              </>
            }
          />
          {verifyState.status === 'ok' && (
            <p className="text-xs text-success">✓ Key accepted by {listen.label}</p>
          )}
          {/* Deliberately NOT an ErrorMessage. The key works — voice notes and the
              transcribe tool are fine — and only the microphone is out. Painting
              that red is what made a good key look broken. */}
          {verifyState.status === 'partial' && (
            <div className="flex flex-col gap-0.5">
              <p className="text-xs text-success">✓ Key accepted — voice notes and the transcribe tool will work</p>
              <p className="text-xs text-muted-foreground">The microphone won&apos;t start: {verifyState.detail}</p>
            </div>
          )}
          {verifyState.status === 'error' && <ErrorMessage>{verifyState.error}</ErrorMessage>}
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup
        title="Test microphone"
        description="Checks the key and grants microphone permission, so the composer's mic works first time."
      >
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={onTest}
            disabled={!listenKeyStored || (!voiceAvailable && !isConnecting && !isRecording)}
          >
            {isRecording && <VoiceBars volumeRef={volumeRef} isRecording={isRecording} />}
            <span>{buttonLabel}</span>
          </Button>
          {!listenKeyStored && (
            <p className="text-xs text-muted-foreground">Enter your {listen.label} key first.</p>
          )}
          {/* Only while the verify row has said nothing. `voiceAvailable` is false
              both while the mount prefetch is in flight AND after it failed, so
              this line would claim "checking" forever on a bad key — it must not
              sit next to the verify row's verdict contradicting it. */}
          {listenKeyStored && !voiceAvailable && !isConnecting && !isRecording && verifyState.status === 'idle' && (
            <p className="text-xs text-muted-foreground">Checking key…</p>
          )}
          {testError && <p className="text-xs text-destructive">{testError}</p>}
        </div>

        <div className="min-h-[60px] rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[13px] leading-normal">
          {(finalText || partial) ? (
            <div className="text-foreground">
              <span>{finalText}</span>
              {finalText && partial ? ' ' : ''}
              <span className="italic text-muted-foreground">{partial}</span>
            </div>
          ) : (
            <div className="italic text-muted-foreground">
              Click and speak. We&apos;ll show what we hear.
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup
        title="Speak"
        description="Text to speech for Telegram replies. Off until you pick a provider."
      >
        <Field>
          <FieldLabel htmlFor="voice-speak-provider">Provider</FieldLabel>
          <Select
            value={speakSlug || '__off__'}
            onValueChange={(next) => updateSpeak({ provider: next === '__off__' ? '' : next, voiceId: '', modelId: '' })}
          >
            <SelectTrigger id="voice-speak-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Radix forbids an empty item value, so "off" travels through a
                  sentinel and is stored as ''. */}
              <SelectItem value="__off__">Don&apos;t speak</SelectItem>
              {SPEAK.map((p) => <SelectItem key={p.slug} value={p.slug}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* Naming the absence is the point — otherwise the obvious question is
              why the provider you already pay for isn't in the list. */}
          <FieldDescription>AssemblyAI can&apos;t do text to speech, so it isn&apos;t listed.</FieldDescription>
        </Field>

        {speak && !sharesKey && (
          <Field>
            <FieldLabel htmlFor="voice-speak-key">{speak.label} API key</FieldLabel>
            <CredentialRow
              id="voice-speak-key"
              saved={speakKeyStored}
              value={speakKeyField.value}
              onChange={(e: any) => speakKeyField.onChange(e.target.value)}
              onBlur={speakKeyField.onBlur}
              actions={speakKeyStored ? (
                <Button variant="destructive" onClick={() => removeKey(speakSlug)} disabled={removing === speakSlug}>
                  {removing === speakSlug ? 'Removing…' : 'Remove'}
                </Button>
              ) : null}
            />
            <FieldDescription>Get a key from {signupLink(speak)}.</FieldDescription>
          </Field>
        )}

        {speak && sharesKey && (
          <p className="text-xs text-muted-foreground">Same {speak.label} key as above.</p>
        )}

        {speak && (
          <Field>
            <FieldLabel htmlFor="voice-speak-voice">Voice</FieldLabel>
            <div className="flex gap-2">
              <Select
                value={speech?.voiceId || ''}
                onValueChange={(next) => updateSpeak({ voiceId: next })}
                disabled={!voices.length}
              >
                <SelectTrigger id="voice-speak-voice" className="w-full">
                  <SelectValue placeholder={
                    loadingVoices ? 'Loading voices…'
                      : !speakKeyStored ? 'Add a key to load voices'
                        : voices.length ? 'Provider default' : 'No voices'
                  } />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {/* Only ElevenLabs ships a sample per voice; Deepgram's voices are
                  models with nothing to play, so the button simply isn't there. */}
              {selectedVoice?.preview && (
                <Button type="button" variant="outline" size="sm" onClick={playPreview}>Play</Button>
              )}
            </div>
            <FieldDescription>
              From {speak.label}, including voices you&apos;ve cloned.
              {speakKeyStored && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="text-primary underline underline-offset-2 hover:opacity-80"
                    onClick={loadVoices}
                  >Refresh</button>
                </>
              )}
            </FieldDescription>
            {voicesError && <p className="text-xs text-destructive">{voicesError}</p>}
          </Field>
        )}
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup
        title="Telegram replies"
        description="Per workspace. Voice alone can't be skimmed or searched, so pick it knowingly."
      >
        <Field>
          <FieldLabel htmlFor="voice-reply-mode">Reply with</FieldLabel>
          <Select
            value={['text', 'voice', 'both'].includes(voiceReply) ? voiceReply : 'text'}
            onValueChange={(next) => onVoiceReplyChange?.(next)}
            disabled={!hasWorkspace}
          >
            <SelectTrigger id="voice-reply-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="voice">Voice</SelectItem>
              <SelectItem value="both">Voice and text</SelectItem>
            </SelectContent>
          </Select>
          <FieldDescription>
            {!hasWorkspace
              ? 'Open a workspace to set this.'
              : 'You can also just ask the agent to talk to you.'}
          </FieldDescription>
        </Field>
        {voiceReply !== 'text' && !speakKeyStored && (
          <p className="text-xs text-muted-foreground">Pick a speaking provider above, or replies stay text.</p>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
