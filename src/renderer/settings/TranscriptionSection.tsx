import React, { useEffect, useRef, useState } from 'react';
import { useVoiceInput } from '../voice/useVoiceInput.js';
import { useCommitField } from './useCommitField';
import { VoiceBars } from '../voice/VoiceBars.jsx';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { removeCredential } from './credentialField';
import CredentialRow from './CredentialRow';
import ErrorMessage from '../ErrorMessage.jsx';

// Settings page for voice transcription. Three jobs:
//   1. Capture + store the AssemblyAI API key (encrypted in main).
//   2. Verify that key — the page's primary action, as on every other
//      credential page.
//   3. Provide a "Test microphone" button that exercises the full streaming
//      pipeline. The first-click side-effect is what matters most: the browser
//      asks for mic permission HERE, persistently grants it for the Electron
//      origin, and the chat composer's mic skips the permission prompt forever
//      after.
//
// WHAT "VERIFY" ACTUALLY DOES. AssemblyAI ships no key-check endpoint, so
// verifying is "make the cheapest real request and read the status code".
// `voice:getToken` already is that request — it mints the 60s streaming token
// against the stored key — so Verify reuses it rather than adding a second HTTP
// surface. It's also the RIGHT probe: this app only ever uses the streaming
// product, so a token means "voice input will work", where a 200 from the
// transcript-list endpoint would only mean the key is live for async
// transcription. The mint was always happening (it's what un-greys the Test
// button); the only thing that was missing is that its answer was thrown away
// into a boolean and its error string swallowed.
export default function TranscriptionSection({ transcription, onTranscriptionChange }) {
  const hasApiKey = !!transcription?.hasApiKey;

  // No `apiKey` here — main strips it, so including it would send '' and delete
  // the stored key on any unrelated change.
  const update = (patch) => onTranscriptionChange?.({
    provider: 'assemblyai',
    ...patch,
  });

  // Declared ahead of the hooks that fill them — the commit handler below runs
  // long after render, so the refs are populated by the time it fires.
  const recheckRef = useRef<((...args: any[]) => Promise<any>) | null>(null);
  const runVerifyRef = useRef<(() => void) | null>(null);

  const [verifyState, setVerifyState] = useState<any>({ status: 'idle' });

  // Each verify claims a ticket. Two ways to get concurrent checks — blur then
  // click Verify, or click Verify then edit the box — and without this the LAST
  // response to land wins rather than the newest request. Same guard GitHub's
  // PAT carries, for the same reason.
  const verifyReq = useRef(0);

  // The save started by a blur, so verify can wait for it. Unlike GitHub's PAT,
  // there is no way to check a candidate value: main mints against the key it
  // resolves from the companion, not against anything we could hand it. So a
  // verify that doesn't wait for the in-flight write checks the PREVIOUS key —
  // and clicking the button is itself what blurs the field, so that ordering is
  // the normal case, not a corner.
  const savingRef = useRef<Promise<any> | null>(null);

  const runVerify = async () => {
    const req = ++verifyReq.current;
    setVerifyState({ status: 'checking' });
    await savingRef.current;
    if (verifyReq.current !== req) return;
    const res = await recheckRef.current?.();
    if (verifyReq.current !== req) return;
    setVerifyState(res?.error
      ? { status: 'error', error: res.error }
      : { status: 'ok' });
  };
  runVerifyRef.current = runVerify;

  // Commits on blur (see useCommitField). The key is a paste, and every write
  // re-triggers the token check below, so per-keystroke writes were both waste
  // and the source of the racing checks.
  //
  // AWAIT the save before re-checking: main resolves the key from the companion,
  // not from what's on screen, so asking any earlier just re-reads the old key
  // and leaves the Test button dead. That await now lives in `runVerify`, which
  // is the same re-check this always did — it just shows the answer instead of
  // dropping it.
  // Write-only: main never sends the key down, so this starts empty and a commit
  // only fires for something actually typed.
  const keyField = useCommitField('', (next) => {
    if (!next) return;
    savingRef.current = Promise.resolve(update({ apiKey: next }));
    runVerifyRef.current?.();
  });

  // A green check beside a key that has since been edited would be actively
  // misleading, so typing drops the row back to idle and invalidates whatever
  // is in flight.
  const onKeyChange = (value: string) => {
    keyField.onChange(value);
    verifyReq.current++;
    if (verifyState.status !== 'idle') setVerifyState({ status: 'idle' });
  };

  // Removing the key is a separate call from saving one — see removeCredential.
  // The `hasApiKey` flag comes back through `settings:changed`, so the field and
  // this button update themselves once main confirms. The bare `recheck` (not
  // `runVerify`) is deliberate: it flips the Test button off, but publishing its
  // result would put a red "not configured" under a key the user just chose to
  // delete. Removing something successfully is not an error state.
  const [removing, setRemoving] = useState(false);
  const onRemoveKey = async () => {
    setRemoving(true);
    try {
      const r = await removeCredential('transcription.apiKey');
      verifyReq.current++;
      if (!r?.ok) setVerifyState({ status: 'error', error: r?.error || 'Could not remove the key.' });
      else setVerifyState({ status: 'idle' });
      recheckRef.current?.();
    } finally {
      setRemoving(false);
    }
  };

  // Test-mic local state. Independent hook instance from the composer's —
  // each gets its own token cache.
  const volumeRef = useRef(0);
  const [partial, setPartial] = useState('');
  const [finalText, setFinalText] = useState('');
  const [testError, setTestError] = useState<any>(null);

  const { voiceAvailable, isConnecting, isRecording, startRecording, stopRecording, recheck } = useVoiceInput({
    getToken: () => window.api.voice.getToken(),
    onTranscript: (t) => {
      setFinalText((prev) => (prev ? prev + ' ' : '') + t);
      setPartial('');
    },
    onPartialTranscript: setPartial,
    onError: setTestError,
    onVolumeChange: (rms) => { volumeRef.current = rms; },
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

  const buttonLabel = isConnecting
    ? 'Connecting…'
    : isRecording
      ? 'Stop'
      : 'Test microphone';

  return (
    <SettingsSection
      title="Transcription"
      description={(
        <>
          Voice input uses AssemblyAI streaming transcription. Get a key from{' '}
          <a
            href="#"
            className="text-primary underline underline-offset-2 hover:opacity-80"
            onClick={(e) => { e.preventDefault(); window.api.openExternal('https://www.assemblyai.com/dashboard/signup'); }}
          >assemblyai.com</a>
          . The key is encrypted on this machine using your OS keychain.
        </>
      )}
    >
      <SettingsGroup>
        <Field>
          <FieldLabel htmlFor="transcription-key">AssemblyAI API key</FieldLabel>
          <CredentialRow
            id="transcription-key"
            saved={hasApiKey}
            value={keyField.value}
            onChange={(e) => onKeyChange(e.target.value)}
            onBlur={keyField.onBlur}
            actions={
              <>
                {/* This page's one primary, same as GitHub's: checking the key is
                    the action you come here to take, and it's the one that has to
                    work before anything else on the page means anything.
                    Enabled whenever there is something to check — typed here or
                    already stored. Gating it on the draft alone would disable it
                    forever, since the draft is empty unless you're mid-edit. */}
                <Button
                  onClick={runVerify}
                  disabled={(!keyField.value.trim() && !hasApiKey) || verifyState.status === 'checking'}
                >
                  {verifyState.status === 'checking' ? 'Verifying…' : 'Verify'}
                </Button>
                {/* The only way to remove a stored key — clearing the box can't, by
                    design (see removeCredential). */}
                {hasApiKey && (
                  <Button variant="destructive" onClick={onRemoveKey} disabled={removing}>
                    {removing ? 'Removing…' : 'Remove'}
                  </Button>
                )}
              </>
            }
          />
          {verifyState.status === 'ok' && (
            <p className="text-xs text-success">✓ Key accepted by AssemblyAI</p>
          )}
          {verifyState.status === 'error' && <ErrorMessage>{verifyState.error}</ErrorMessage>}
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Test microphone">
        <p className="text-xs text-muted-foreground">
          Verifies your key works AND grants the browser microphone permission so
          the first click in the chat composer is instant.
        </p>

        <div className="flex flex-col gap-1">
          {/* Secondary to Verify above — this page's primary is the key check.
              Still the button with the bigger side effect (it's what triggers
              Electron's one-time mic permission prompt), which is why the group
              above it says so rather than the styling. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={onTest}
            disabled={!hasApiKey || (!voiceAvailable && !isConnecting && !isRecording)}
          >
            {isRecording && <VoiceBars volumeRef={volumeRef} isRecording={isRecording} />}
            <span>{buttonLabel}</span>
          </Button>
          {!hasApiKey && (
            <p className="text-xs text-muted-foreground">Enter your AssemblyAI key first.</p>
          )}
          {/* Only while the verify row has said nothing. `voiceAvailable` is
              false both while the mount prefetch is in flight AND after it
              failed, so this line claims "checking" forever on a bad key — it
              must not sit next to the verify row's own verdict contradicting
              it. Once Verify has spoken, that row is the answer. */}
          {hasApiKey && !voiceAvailable && !isConnecting && !isRecording && verifyState.status === 'idle' && (
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
              Click and speak. We'll show what we hear.
            </div>
          )}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
