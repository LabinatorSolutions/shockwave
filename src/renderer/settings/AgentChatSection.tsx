import React, { useEffect, useState } from 'react';
import Combobox from '../Combobox.jsx';
import { DEFAULT_PROVIDER_SLUG } from '../constants.js';
import { useCommitField } from './useCommitField';
import { removeCredential } from './credentialField';
import CredentialRow from './CredentialRow';
import { SettingsSection, SettingsGroup, SettingsDivider, NUMBER_FIELD } from './SectionUI';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Our generic OpenAI-compatible endpoint slug (Ollama, LM Studio, vLLM, gateways).
const COMPATIBLE_SLUG = 'openai-compatible';

// Human labels for the reasoning levels (pi's vocabulary, dropdown display).
const THINKING_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

function ProviderModelKey({ idPrefix, provider, model, hasKey, baseUrl, contextWindow, thinkingLevel, onChange, onKeyChange, onRemoveKey }) {
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [validateState, setValidateState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [validateMsg, setValidateMsg] = useState('');

  const isCompatible = provider === COMPATIBLE_SLUG;

  // All three commit on blur (see useCommitField) — same rule as every other
  // settings text box. The Test button below also reads the endpoint, so
  // per-keystroke writes meant it was re-armed against every partial URL.
  const baseUrlField = useCommitField(baseUrl ?? '', (next) => onChange({ baseUrl: next }));
  // Write-only: starts empty, commits only what was typed.
  const keyField = useCommitField('', (next) => onKeyChange(next));
  const ctxField = useCommitField(
    contextWindow == null ? '' : String(contextWindow),
    (next) => onChange({ contextWindow: next ? Number(next) : undefined }),
  );

  // Providers come from pi-ai's registry plus our injected openai-compatible
  // (intersected with our supported set in main). Fetched once on mount.
  useEffect(() => {
    let active = true;
    window.api.agent.listProviders().then((list) => {
      if (active) setProviders(list ?? []);
    });
    return () => { active = false; };
  }, []);

  // Models are scoped to the current provider. openai-compatible has no static
  // catalog — its models come from the Test button (or are typed free-form) —
  // so skip the fetch for it, otherwise this would wipe a Test-populated list.
  useEffect(() => {
    if (!provider || provider === COMPATIBLE_SLUG) return;
    let active = true;
    window.api.agent.listModels(provider).then((list) => {
      if (active) setModels(list ?? []);
    });
    return () => { active = false; };
  }, [provider]);

  // Supported thinking levels for the chosen provider+model. Built-in models
  // carry per-model reasoning metadata; openai-compatible returns a static list.
  // A single-entry (['off']) result means the model has no reasoning — the
  // dropdown is then hidden.
  useEffect(() => {
    if (!provider) { setThinkingLevels([]); return; }
    let active = true;
    window.api.agent.listThinkingLevels({ provider, model }).then((list) => {
      if (active) setThinkingLevels(list ?? []);
    });
    return () => { active = false; };
  }, [provider, model]);

  // Reset the transient Test result whenever the inputs it validated change.
  useEffect(() => { setValidateState('idle'); setValidateMsg(''); }, [provider, baseUrl, hasKey]);

  const handleValidate = async () => {
    setValidateState('loading');
    setValidateMsg('');
    try {
      // Drafts, not the stored props: clicking Test blurs the input, which
      // commits, but that write is async — the props are still one edit behind
      // at this point. The drafts are always the freshest values on screen.
      //
      // `provider` lets main fall back to the STORED key when nothing is typed.
      // The key box is write-only, so it's empty unless you're mid-edit — sending
      // only the draft meant Test ran unauthenticated against a saved endpoint and
      // reported a 401 for a setup that works.
      const result = await window.api.agent.validateConnection({
        baseUrl: baseUrlField.value,
        apiKey: keyField.value,
        provider,
      });
      if (result.ok) {
        setValidateState('ok');
        if (result.models?.length) {
          setModels(result.models);
          // Convenience: a single discovered model auto-selects.
          if (!model && result.models.length === 1) onChange({ model: result.models[0] });
          setValidateMsg(`Connection OK · ${result.models.length} model${result.models.length === 1 ? '' : 's'}`);
        } else {
          setValidateMsg('Connection OK');
        }
      } else {
        setValidateState('error');
        setValidateMsg(result.error ?? 'Connection failed');
      }
    } catch (err) {
      setValidateState('error');
      setValidateMsg(err instanceof Error ? err.message : String(err));
    }
  };

  // The ✓/✗ glyphs the old addon-sized button used are gone — the result now
  // reads in `validateMsg` under the field, which has room for the actual reason.
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-provider`}>Provider</FieldLabel>
        <Select
          value={provider}
          // Switching providers invalidates the model AND the endpoint — clear
          // both so a stale openai-compatible baseUrl doesn't bleed across.
          onValueChange={(next) => onChange({ provider: next, model: '', baseUrl: '' })}
        >
          <SelectTrigger id={`${idPrefix}-provider`} className="w-full">
            <SelectValue>{provider || undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {isCompatible && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-base-url`}>Base URL</FieldLabel>
          <Input
            id={`${idPrefix}-base-url`}
            className="font-mono"
            type="text"
            value={baseUrlField.value}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => baseUrlField.onChange(e.target.value)}
            onBlur={baseUrlField.onBlur}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
          <FieldDescription className="text-xs">
            Ollama: http://localhost:11434/v1<br />
            LM Studio: http://localhost:1234/v1
          </FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-model`}>Model</FieldLabel>
        {/* Built-in providers: validated dropdown — only a real catalog model
            can be committed, so a nonexistent id can't be saved.
            openai-compatible has no catalog (local/custom endpoints), so it
            stays a free-form combobox (type the id yourself; Test populates
            the suggestion list). */}
        {isCompatible ? (
          <Combobox
            id={`${idPrefix}-model`}
            options={models}
            value={model}
            onChange={(next) => onChange({ model: next })}
            freeForm
          />
        ) : (
          <Select value={model} onValueChange={(next) => onChange({ model: next })}>
            <SelectTrigger id={`${idPrefix}-model`} className="w-full">
              <SelectValue placeholder={model || undefined}>{model || undefined}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* Surface a saved model that isn't in the current catalog (e.g. a stale
            or mistyped id from before validation) so it's obvious it won't run. */}
        {!isCompatible && model && models.length > 0 && !models.includes(model) && (
          <p className="text-xs text-destructive">
            “{model}” isn’t in {provider}’s catalog — pick a model from the list.
          </p>
        )}
      </Field>

      {isCompatible && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-ctx`}>Context window</FieldLabel>
          <Input
            id={`${idPrefix}-ctx`}
            type="number"
            min={1}
            value={ctxField.value}
            placeholder="128000"
            onChange={(e) => ctxField.onChange(e.target.value)}
            onBlur={ctxField.onBlur}
          />
          <FieldDescription className="text-xs">Tokens the model can hold. Leave blank for 128000.</FieldDescription>
        </Field>
      )}

      {thinkingLevels.length > 1 && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-thinking`}>Reasoning</FieldLabel>
          <Select
            value={thinkingLevel ?? 'off'}
            onValueChange={(next) => onChange({ thinkingLevel: next })}
          >
            <SelectTrigger id={`${idPrefix}-thinking`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {thinkingLevels.map((l) => (
                <SelectItem key={l} value={l}>{THINKING_LABELS[l] ?? l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription className="text-xs">
            Extended thinking before each reply. Higher = more reasoning, more tokens and latency.
            Streamed live in the chat sidebar.
          </FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-key`}>
          API key{isCompatible ? ' (optional for local)' : ''}
        </FieldLabel>
        <CredentialRow
          id={`${idPrefix}-key`}
          saved={hasKey}
          value={keyField.value}
          onChange={(e) => keyField.onChange(e.target.value)}
          onBlur={keyField.onBlur}
          actions={
            <>
              {/* Primary because it's the one ACTION on this page — but it only exists
                  for openai-compatible, so on a cloud provider this page has no
                  primary. Cloud keys have nothing to probe here: /models paths and auth
                  differ per provider, and pi already supplies their model lists, so
                  those keys validate on the first message instead. */}
              {isCompatible && (
                <Button
                  onClick={handleValidate}
                  disabled={validateState === 'loading' || !baseUrlField.value}
                  title="Test connection (GET /models)"
                >
                  {validateState === 'loading' ? 'Testing…' : 'Test'}
                </Button>
              )}
              {/* Only route that removes a stored key — clearing the box can't, by
                  design (see removeCredential). Per provider: removing Anthropic's key
                  leaves the others alone. */}
              {hasKey && (
                <Button variant="destructive" onClick={() => onRemoveKey?.()}>
                  Remove
                </Button>
              )}
            </>
          }
        />
        {isCompatible && validateMsg && (
          <p className={validateState === 'error' ? 'text-xs text-destructive' : 'text-xs text-success'}>
            {validateMsg}
          </p>
        )}
      </Field>
    </>
  );
}

export default function AgentChatSection({ codingAgent, onCodingAgentChange }) {
  const caProvider = codingAgent?.provider ?? DEFAULT_PROVIDER_SLUG;
  const caModel = codingAgent?.model ?? '';
  // Main strips provider keys, so the screen only learns WHICH providers have one.
  const caHasKey = !!(codingAgent?.hasProviderKey ?? {})[caProvider];
  const caBaseUrl = codingAgent?.baseUrl ?? '';
  const caContextWindow = codingAgent?.contextWindow;
  const caThinkingLevel = codingAgent?.thinkingLevel ?? 'medium';
  const caMaxRunMinutes = codingAgent?.maxRunMinutes;
  const caMaxFixAttempts = codingAgent?.maxFixAttempts;
  const caScratchTtlDays = codingAgent?.scratchTtlDays;
  const updateCa = (patch) => onCodingAgentChange?.({
    provider: caProvider,
    model: caModel,
    baseUrl: caBaseUrl,
    contextWindow: caContextWindow,
    thinkingLevel: caThinkingLevel,
    maxRunMinutes: caMaxRunMinutes,
    maxFixAttempts: caMaxFixAttempts,
    scratchTtlDays: caScratchTtlDays,
    ...patch,
  });

  // Blank clears the value rather than storing 0 — unset is a real state here,
  // and the consumers fall back at the point of use.
  const maxRunField = useCommitField(
    caMaxRunMinutes == null ? '' : String(caMaxRunMinutes),
    (next) => updateCa({ maxRunMinutes: next ? Number(next) : undefined }),
  );
  const fixAttemptsField = useCommitField(
    caMaxFixAttempts == null ? '' : String(caMaxFixAttempts),
    (next) => updateCa({ maxFixAttempts: next ? Number(next) : undefined }),
  );
  const ttlField = useCommitField(
    caScratchTtlDays == null ? '' : String(caScratchTtlDays),
    (next) => updateCa({ scratchTtlDays: next ? Number(next) : undefined }),
  );
  // Only the slot being typed into. The server merges rather than treating the map
  // as complete (see reconcileProviderKeys), so other providers' keys are untouched
  // and there is no need to hold — or resend — any of them.
  const updateKey = (value) => { if (value) updateCa({ providerKeys: { [caProvider]: value } }); };
  // Removing is its own call — an empty value can't carry the intent, because the
  // renderer never holds key values and empty ones are stripped from saves.
  const removeKey = () => removeCredential(`codingAgent.providerKeys.${caProvider}`);

  return (
    <SettingsSection
      title="Agent Chat"
      description="The chat sidebar agent can read, edit, and run commands inside your active workspace. API keys are encrypted on this machine using your OS keychain."
    >
      <SettingsGroup title="LLM">
        <ProviderModelKey
          idPrefix="coding-agent"
          provider={caProvider}
          model={caModel}
          hasKey={caHasKey}
          baseUrl={caBaseUrl}
          contextWindow={caContextWindow}
          thinkingLevel={caThinkingLevel}
          onChange={updateCa}
          onKeyChange={updateKey}
          onRemoveKey={removeKey}
        />
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup>
        <Field>
          <FieldLabel htmlFor="agent-max-run">Agent Run Max Minutes</FieldLabel>
          <Input
            id="agent-max-run"
            className={NUMBER_FIELD}
            type="number"
            min={1}
            placeholder="30"
            value={maxRunField.value}
            onChange={(e) => maxRunField.onChange(e.target.value)}
            onBlur={maxRunField.onBlur}
          />
          <FieldDescription>Aborts a Telegram or scheduled run that overruns.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="agent-fix-attempts">Git Fixer Max Attempts</FieldLabel>
          <Input
            id="agent-fix-attempts"
            className={NUMBER_FIELD}
            type="number"
            min={1}
            placeholder="3"
            value={fixAttemptsField.value}
            onChange={(e) => fixAttemptsField.onChange(e.target.value)}
            onBlur={fixAttemptsField.onBlur}
          />
          <FieldDescription>How many times the git-fixer retries a merge it can&apos;t resolve.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="agent-scratch-ttl">Scratch Pad Max Days</FieldLabel>
          <Input
            id="agent-scratch-ttl"
            className={NUMBER_FIELD}
            type="number"
            min={1}
            placeholder="1"
            value={ttlField.value}
            onChange={(e) => ttlField.onChange(e.target.value)}
            onBlur={ttlField.onBlur}
          />
          <FieldDescription>How long files in the agent&apos;s scratch pad are kept.</FieldDescription>
        </Field>
      </SettingsGroup>
    </SettingsSection>
  );
}
