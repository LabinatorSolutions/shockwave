import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceInput, notifyVoiceConfigChanged } from '../voice/useVoiceInput.js';
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
import {
  VOICE_PROVIDERS, voiceProvider, voiceConfigOf, providersFor, canDo,
  providerForJob, type VoiceJob, type VoiceProvider,
} from '../../../agent-core/voiceProviders.js';
import { normalizeVoiceReply } from '../../../agent-core/voiceReply.js';

// Settings page for voice, in both directions.
//
// PROVIDERS ARE THE OBJECT; JOBS ARE ASSIGNED TO THEM. The page used to be
// organised the other way — a "Listen" group and a "Speak" group, each with a key
// box inside — and the key is a property of the VENDOR, not of the direction. So
// one Deepgram key rendered three different ways depending on unrelated dropdown
// state (a box under Listen, a box under Speak, or the sentence "same key as
// above"), and switching a dropdown appeared to delete a key that was still
// stored. Worse, a vendor you were not currently using was invisible: `voiceKeys`
// holds three, the old page drew at most two, and a stored key you had stopped
// using could be neither seen nor removed. Listing every vendor unconditionally is
// what fixes both — nothing moves, and what is stored is what is on screen.
//
// THREE JOBS, NOT TWO. Speaking and transcribing were always separate because the
// matrix is not square (AssemblyAI cannot synthesize). The microphone is separate
// for a different reason: a key can be permitted to transcribe and not to stream,
// and on Deepgram that is the DEFAULT key rather than an unusual one. Before this
// there was nowhere for that user to go — the mic was simply dead. See
// `micProviderOf` in `agent-core/voiceProviders.ts`.
//
// VERIFY IS ABOUT THE KEY; TEST MICROPHONE IS ABOUT THE MICROPHONE. They were one
// button doing both jobs badly. Verify now asks one vendor what its key is
// permitted to do and answers per job — including whether it can SPEAK, which
// nothing checked at all, so a broken speech key stayed invisible until a Telegram
// reply failed to come back as audio. Test microphone opens the actual microphone;
// its first-click side effect is the point, since the browser asks for permission
// HERE and the chat composer's mic never has to prompt mid-conversation.

/** What each job is called on screen, and what it actually covers. One place, so
 *  the assignment label and the capability chip can't drift apart. */
const JOBS: Array<{ job: VoiceJob; label: string; chip: string; blurb: string }> = [
  {
    job: 'mic',
    label: 'Microphone',
    chip: 'microphone',
    blurb: 'The mic in the chat sidebar.',
  },
  {
    job: 'listen',
    label: 'Transcription',
    chip: 'transcribe',
    blurb: "Telegram voice notes, and the agent's transcribe tool.",
  },
  {
    job: 'speak',
    label: 'Speech',
    chip: 'speak',
    blurb: 'Text to speech, for anything the bot says on Telegram.',
  },
];

const chipFor = (job: VoiceJob) => JOBS.find((j) => j.job === job)?.chip ?? job;

type VerifyState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'error'; error: string }
  | { status: 'done'; checks: Array<{ job: VoiceJob; ok: boolean; detail?: string }> };

function keysLink(p: VoiceProvider) {
  return (
    <a
      href="#"
      className="text-primary underline underline-offset-2 hover:opacity-80"
      onClick={(e) => { e.preventDefault(); window.api.openExternal(p.keysUrl); }}
    >{p.keysHost}</a>
  );
}

/**
 * One vendor: its key, what that key is permitted to do, and how to remove it.
 *
 * A component per row rather than a loop in the parent, because `useCredentialField`
 * is a hook and each row needs its own draft. It also keeps the write-only rule
 * local: the draft starts empty, main never sends a value down, and only something
 * actually typed is ever committed.
 */
function ProviderRow({
  provider, saved, verifyState, removing, onSave, onVerify, onRemove, onEdited,
}: {
  provider: VoiceProvider;
  saved: boolean;
  verifyState: VerifyState;
  removing: boolean;
  onSave: (key: string) => Promise<any> | any;
  onVerify: () => void;
  onRemove: () => void;
  onEdited: () => void;
}) {
  const field = useCredentialField((next) => onSave(next));
  const capabilities = JOBS.filter((j) => canDo(provider, j.job)).map((j) => j.chip);

  return (
    <Field>
      <div className="flex items-baseline justify-between gap-3">
        <FieldLabel htmlFor={`voice-key-${provider.slug}`}>{provider.label}</FieldLabel>
        <span className="text-xs text-muted-foreground">{capabilities.join(' · ')}</span>
      </div>
      <CredentialRow
        id={`voice-key-${provider.slug}`}
        saved={saved}
        value={field.value}
        onChange={(e: any) => { field.onChange(e.target.value); onEdited(); }}
        onBlur={field.onBlur}
        actions={(field.value.trim() || saved) ? (
          <>
            {/* Primary, and one per row — the deliberate exception to "exactly
                one primary per page". Nothing else here means anything until a
                key is known good, and with three vendors there is no non-arbitrary
                way to promote one of them. Test microphone is secondary: it
                answers a different question (the hardware), not a better one. */}
            <Button onClick={onVerify} disabled={verifyState.status === 'checking'}>
              {verifyState.status === 'checking' ? 'Verifying…' : 'Verify'}
            </Button>
            {saved && (
              <Button variant="destructive" onClick={onRemove} disabled={removing}>
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            )}
          </>
        ) : null}
      />
      {!saved && <FieldDescription>Get a key from {keysLink(provider)}.</FieldDescription>}

      {verifyState.status === 'error' && <ErrorMessage>{verifyState.error}</ErrorMessage>}

      {/* Per job, because a key really can be good for one and not another —
          and saying "rejected" to that sends someone to replace a key that
          works. A failed job is muted rather than red for the same reason: the
          key is fine, one permission on it isn't. */}
      {verifyState.status === 'done' && (
        <div className="flex flex-col gap-0.5">
          {verifyState.checks.map((c) => (
            <p key={c.job} className={c.ok ? 'text-xs text-success' : 'text-xs text-muted-foreground'}>
              {c.ok ? '✓' : '✗'} {chipFor(c.job)}
              {!c.ok && c.detail ? ` — ${c.detail}` : ''}
            </p>
          ))}
        </div>
      )}
    </Field>
  );
}

export default function VoiceSection({
  transcription,
  onTranscriptionChange,
  speech,
  hasVoiceKey,
  onSpeechChange,
  onVoiceKeyChange,
}: any) {
  // Resolved through the SAME functions the microphone, Telegram and the agent
  // use — `voiceConfigOf` folds `hasVoiceKey` in for us, so the page cannot show
  // one answer while the app uses another.
  const config = voiceConfigOf({ transcription, speech, hasVoiceKey });
  const assigned = (job: VoiceJob) => providerForJob(config, job);
  const keyStored = (slug: string) => !!hasVoiceKey?.[slug];

  // Unset ⇒ text, through the same normalizer the delivery end uses — the bot
  // writes this row too, so what the page shows must be what a turn would read.
  const replyMode = normalizeVoiceReply(speech?.telegramReply);

  const speakSlug = assigned('speak');
  const speak = speakSlug ? voiceProvider(speakSlug)! : null;
  const micSlug = assigned('mic');

  // Just the leaves being changed — the setters merge the siblings back in
  // (see `useSettings`). The diff in settingsDiff.ts is what stops the untouched
  // ones being written.
  const updateListen = (patch: any) => onTranscriptionChange?.(patch);
  const updateSpeak = (patch: any) => onSpeechChange?.(patch);

  // ── Verify ─────────────────────────────────────────────────────────────────
  //
  // Per vendor, so two rows can be checked without one answer landing under the
  // other's key. Each claims a ticket: blur-then-click and click-then-edit both
  // produce concurrent checks, and without this the LAST response to land wins
  // rather than the newest request.
  const [verifyStates, setVerifyStates] = useState<Record<string, VerifyState>>({});
  const verifyReq = useRef<Record<string, number>>({});
  // The save started by a blur, so verify can wait for it: main resolves the key
  // from the companion, not from anything on screen, so a verify that doesn't
  // wait checks the PREVIOUS key. Clicking Verify is itself what blurs the field.
  const savingRef = useRef<Record<string, Promise<any> | null>>({});

  const setVerify = (slug: string, state: VerifyState) => setVerifyStates((prev) => ({ ...prev, [slug]: state }));

  const runVerify = async (slug: string) => {
    const req = (verifyReq.current[slug] ?? 0) + 1;
    verifyReq.current[slug] = req;
    setVerify(slug, { status: 'checking' });
    await savingRef.current[slug];
    if (verifyReq.current[slug] !== req) return;
    const res = await window.api.voice.verifyKey(slug);
    // Every mic in the app re-asks, not just this page's test button. Verify is
    // the moment a key stops being rejected, and the composer's mic is a separate
    // hook instance that would otherwise sit on the old refusal until restart.
    notifyVoiceConfigChanged();
    if (verifyReq.current[slug] !== req) return;
    if (!res?.ok) setVerify(slug, { status: 'error', error: res?.error || 'Could not check that key.' });
    else setVerify(slug, { status: 'done', checks: (res.checks ?? []) as any });
  };

  const saveKey = (slug: string, next: string) => {
    const p = Promise.resolve(onVoiceKeyChange?.(slug, next));
    savingRef.current[slug] = p;
    runVerify(slug);
    return p;
  };

  // A green verdict beside a key that has since been typed over is a lie.
  const invalidateVerify = (slug: string) => {
    verifyReq.current[slug] = (verifyReq.current[slug] ?? 0) + 1;
    setVerifyStates((prev) => (prev[slug] && prev[slug].status !== 'idle' ? { ...prev, [slug]: { status: 'idle' } } : prev));
  };

  const [removing, setRemoving] = useState('');
  const removeKey = async (slug: string) => {
    setRemoving(slug);
    try {
      const r = await removeCredential(`voiceKeys.${slug}`);
      verifyReq.current[slug] = (verifyReq.current[slug] ?? 0) + 1;
      // Removing is not failing. Publishing a red "not configured" under a key
      // the user just chose to delete reports a success as an error.
      setVerify(slug, r?.ok ? { status: 'idle' } : { status: 'error', error: r?.error || 'Could not remove the key.' });
      notifyVoiceConfigChanged();
    } finally {
      setRemoving('');
    }
  };

  // ── Voices ─────────────────────────────────────────────────────────────────
  //
  // Fetched from the vendor rather than hardcoded, so a voice added upstream (or
  // one you cloned yourself, which only your account has) shows up without a
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

  // A STORED VOICE MUST DESCRIBE ITSELF WHILE THE VENDOR'S LIST IS STILL IN
  // FLIGHT. Radix renders the matching ITEM's label, never the value — so with
  // no items fetched yet, a configured voice had nothing to match and fell
  // through to the placeholder. The field read as unset, and then changed under
  // the user a second or two later when the fetch landed, which is a far worse
  // thing for a settings page to do than simply take a moment: nothing had
  // changed, and the page said otherwise twice.
  //
  // Carrying the id as its own option means the trigger always shows what is
  // stored; the friendly name replaces it when the list arrives. The list is a
  // live call to the vendor (`voice:listVoices`), so this window is every open
  // of the page, not an edge case.
  const voiceOptions = useMemo(() => {
    const id = speech?.voiceId;
    if (!id || voices.some((v) => v.id === id)) return voices;
    return [{ id, name: id }, ...voices];
  }, [voices, speech?.voiceId]);

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

  const { voiceAvailable, isConnecting, isRecording, startRecording, stopRecording } = useVoiceInput({
    getToken: () => window.api.voice.getToken(),
    onTranscript: (t: string) => {
      setFinalText((prev) => (prev ? prev + ' ' : '') + t);
      setPartial('');
    },
    onPartialTranscript: setPartial,
    onError: setTestError,
    onVolumeChange: (rms: number) => { volumeRef.current = rms; },
  });

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
  const micReady = !!micSlug && keyStored(micSlug);

  /**
   * One assignment dropdown.
   *
   * Every capable vendor is listed, including ones with no key — marked, not
   * hidden. Filtering makes the list mysteriously short and gives no clue what
   * would lengthen it; naming the gap is what turns the dropdown into an
   * instruction. `Not set` is a real state and says so rather than showing a
   * vendor nobody chose.
   */
  const assignment = (job: VoiceJob, value: string, onChange: (next: string) => void, offLabel?: string) => (
    <Select value={value || '__none__'} onValueChange={(next) => onChange(next === '__none__' ? '' : next)}>
      <SelectTrigger id={`voice-job-${job}`} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {/* Radix forbids an empty item value, so "unset" travels as a sentinel. */}
        <SelectItem value="__none__">{offLabel ?? 'Not set'}</SelectItem>
        {providersFor(job).map((p) => (
          <SelectItem key={p.slug} value={p.slug}>
            {p.label}{keyStored(p.slug) ? '' : ' (no key)'}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const jobBlurb = (job: VoiceJob) => JOBS.find((j) => j.job === job)!.blurb;

  // Deliberately NOT `wide`, though the provider list looks like an entity list:
  // its rows are credential fields, and every credential box in Settings shares
  // the 360px measure. That is what keeps them one width from page to page.
  return (
    <SettingsSection
      title="Agent Voice"
      description="Speech in and out. Keys are per provider; assign each job below."
    >
      <SettingsGroup
        title="Providers"
        description="Your accounts. A key is stored once and can do any job that provider supports."
      >
        {/* A hairline between vendors: each row is a label, a box, a pair of
            buttons and up to three result lines, so on a page where every row
            looks alike the gap alone doesn't say where one key ends. */}
        {VOICE_PROVIDERS.map((p, i) => (
          <React.Fragment key={p.slug}>
            {i > 0 && <SettingsDivider />}
            <ProviderRow
              provider={p}
              saved={keyStored(p.slug)}
              verifyState={verifyStates[p.slug] ?? { status: 'idle' }}
              removing={removing === p.slug}
              onSave={(next) => saveKey(p.slug, next)}
              onVerify={() => runVerify(p.slug)}
              onRemove={() => removeKey(p.slug)}
              onEdited={() => invalidateVerify(p.slug)}
            />
          </React.Fragment>
        ))}
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup
        title="What uses what"
        description="Which provider runs each job. One provider can do all three."
      >
        <Field>
          <FieldLabel htmlFor="voice-job-mic">Microphone</FieldLabel>
          {assignment('mic', micSlug, (next) => {
            updateListen({ micProvider: next });
            // Re-ask so Test microphone enables or greys to match. A bare re-ask,
            // not a verify — a red error just for changing a dropdown is noise.
            notifyVoiceConfigChanged();
          })}
          <FieldDescription>{jobBlurb('mic')}</FieldDescription>

          <div className="flex flex-col gap-1 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={onTest}
              disabled={!micReady || (!voiceAvailable && !isConnecting && !isRecording)}
            >
              {isRecording && <VoiceBars volumeRef={volumeRef} isRecording={isRecording} />}
              <span>{buttonLabel}</span>
            </Button>
            {!micSlug && <p className="text-xs text-muted-foreground">Pick a microphone provider first.</p>}
            {micSlug && !micReady && (
              <p className="text-xs text-muted-foreground">
                Add your {voiceProvider(micSlug)?.label ?? micSlug} key above first.
              </p>
            )}
            {testError && <p className="text-xs text-destructive">{testError}</p>}
          </div>

          <div className="min-h-[60px] rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm leading-normal">
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
        </Field>

        <Field>
          <FieldLabel htmlFor="voice-job-listen">Transcription</FieldLabel>
          {assignment('listen', assigned('listen'), (next) => {
            updateListen({ provider: next });
            notifyVoiceConfigChanged();
          })}
          <FieldDescription>{jobBlurb('listen')}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="voice-job-speak">Speech</FieldLabel>
          {/* Speaking costs money per reply, so it is the one job that never
              resolves itself from a key you happened to add. */}
          {assignment(
            'speak',
            speakSlug,
            (next) => updateSpeak({ provider: next, voiceId: '', modelId: '' }),
            "Don't speak",
          )}
          <FieldDescription>
            {jobBlurb('speak')} AssemblyAI doesn&apos;t do text to speech.
          </FieldDescription>
        </Field>

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
                      : !keyStored(speakSlug) ? `Add your ${speak.label} key above`
                        : voices.length ? 'Provider default' : 'No voices'
                  } />
                </SelectTrigger>
                <SelectContent>
                  {voiceOptions.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {/* Only ElevenLabs ships a sample per voice; Deepgram's voices are
                  models with nothing to play, so the button simply isn't there. */}
              {selectedVoice?.preview && (
                <Button type="button" variant="outline" size="sm" onClick={playPreview}>Play</Button>
              )}
            </div>
            <FieldDescription>
              {/* Cloning is an ElevenLabs feature. Deepgram's voices ARE models —
                  there is nothing to clone, and claiming otherwise sent people
                  looking for a screen that doesn't exist. */}
              {speakSlug === 'elevenlabs'
                ? "From ElevenLabs, including voices you've cloned."
                : `${speak.label}'s voices are models.`}
              {keyStored(speakSlug) && (
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

      {/* NOT per-workspace, and it used to say it was. The bot answers in one
          workspace at a time and that choice is made on the Telegram page, quite
          separately from whichever workspace this window has open — so a
          per-workspace mode meant this control wrote a value the bot never read,
          and the replies stayed text with nothing on screen able to explain it.
          See agent-core/voiceReply.ts. Nothing to gate on a workspace either,
          which is why there is no "open a workspace to set this" state. */}
      <SettingsGroup
        title="Telegram replies"
        description="Voice alone can't be skimmed or searched, so pick it knowingly."
      >
        <Field>
          <FieldLabel htmlFor="voice-reply-mode">Reply with</FieldLabel>
          <Select
            value={replyMode}
            onValueChange={(next) => updateSpeak({ telegramReply: next })}
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
          {/* The agent CANNOT change this — `send_message`'s own description tells
              it to answer "send /voice text|voice|both" and says it cannot set the
              mode itself. This line claimed the opposite for as long as it
              existed, sending the user to ask for something the agent is
              instructed to refuse. */}
          <FieldDescription>
            Or send the bot <code className="font-mono">/voice</code> — it changes the same setting.
          </FieldDescription>
        </Field>
        {/* The gate is a provider AND its key, so the instruction has to name
            whichever half is missing. Saying "pick a provider" to someone who
            already picked one is the wrong next step. */}
        {replyMode !== 'text' && !speakSlug && (
          <p className="text-xs text-muted-foreground">Pick a speaking provider above, or replies stay text.</p>
        )}
        {replyMode !== 'text' && !!speakSlug && !keyStored(speakSlug) && (
          <p className="text-xs text-muted-foreground">
            Add your {speak?.label ?? speakSlug} key above, or replies stay text.
          </p>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
