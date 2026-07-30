import React, { useEffect, useRef, useState } from 'react';
import { useVoiceInput } from '../voice/useVoiceInput.js';
import { useCommitField } from './useCommitField';
import { VoiceBars } from '../voice/VoiceBars.jsx';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { credentialPlaceholder, removeCredential } from './credentialField';

// Settings page for voice transcription. Two jobs:
//   1. Capture + store the AssemblyAI API key (encrypted in main).
//   2. Provide a "Test microphone" button that exercises the full streaming
//      pipeline. The first-click side-effect is what matters most: the browser
//      asks for mic permission HERE, persistently grants it for the Electron
//      origin, and the chat composer's mic skips the permission prompt forever
//      after.
export default function TranscriptionSection({ transcription, onTranscriptionChange }) {
  const hasApiKey = !!transcription?.hasApiKey;

  // No `apiKey` here — main strips it, so including it would send '' and delete
  // the stored key on any unrelated change.
  const update = (patch) => onTranscriptionChange?.({
    provider: 'assemblyai',
    ...patch,
  });

  // Declared ahead of the hook that fills it — the commit handler below runs
  // long after render, so the ref is populated by the time it fires.
  const recheckRef = useRef<(() => void) | null>(null);

  // Commits on blur (see useCommitField). The key is a paste, and every write
  // re-triggers the token check below, so per-keystroke writes were both waste
  // and the source of the racing checks.
  //
  // AWAIT the save before re-checking: main resolves the key from the companion,
  // not from what's on screen, so asking any earlier just re-reads the old key
  // and leaves the Test button dead.
  // Write-only: main never sends the key down, so this starts empty and a commit
  // only fires for something actually typed.
  const keyField = useCommitField('', async (next) => {
    if (!next) return;
    await update({ apiKey: next });
    recheckRef.current?.();
  });

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
          <div className="flex gap-2">
            <Input
              id="transcription-key"
              type="password"
              className="flex-1 font-mono"
              placeholder={credentialPlaceholder(hasApiKey)}
              value={keyField.value}
              onChange={(e) => keyField.onChange(e.target.value)}
              onBlur={keyField.onBlur}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
            {/* The only way to remove a stored key — clearing the box can't, by
                design (see removeCredential). Re-checks afterwards so the Test
                button below reflects the key actually being gone. */}
            {hasApiKey && (
              <Button
                variant="destructive"
                onClick={async () => { await removeCredential('transcription.apiKey'); recheckRef.current?.(); }}
              >
                Remove
              </Button>
            )}
          </div>
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Test microphone">
        <p className="text-xs text-muted-foreground">
          Verifies your key works AND grants the browser microphone permission so
          the first click in the chat composer is instant.
        </p>

        <div className="flex flex-col gap-1">
          <Button
            type="button"
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
          {hasApiKey && !voiceAvailable && !isConnecting && !isRecording && (
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
