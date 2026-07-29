import React, { useEffect, useState } from 'react';
import CompanionUpdateDialog from '../CompanionUpdateDialog.jsx';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

// The desktop's connection to the Shockwave companion (server URL + API key).
// Every other settings page reads/writes through this connection, so this page
// gates them: until the companion is reachable with a valid key, the rest are
// disabled.
//
// The URL is stored plaintext; the key is safeStorage-wrapped in main. Neither
// crosses back to the renderer — api:read returns only { url, hasApiKey }.
export default function CompanionSection({ onReadyChange }: { onReadyChange?: (ready: boolean) => void }) {
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');       // '' = leave stored key untouched
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<'unknown' | 'ok' | 'error'>('unknown');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Companion-vs-desktop version check (runs after a successful connection).
  const [verCheck, setVerCheck] = useState<{ status: string; desktop?: string; companion?: string } | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);

  const emitReady = (ready: boolean) => onReadyChange?.(ready);

  const refreshVersionCheck = () => {
    window.api.settings.apiCheckVersion().then(setVerCheck).catch(() => setVerCheck(null));
  };

  // Load the stored config + verify reachability on open.
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await window.api.settings.apiRead();
      if (!alive) return;
      setUrl(c.url || '');
      setHasStoredKey(!!c.hasApiKey);
      if (c.url && c.hasApiKey) {
        const r = await window.api.settings.apiTest({ url: c.url });
        if (!alive) return;
        setStatus(r.ok ? 'ok' : 'error');
        setMessage(r.ok ? `Connected${r.version ? ` — companion ${r.version}` : ''}.` : (r.error || 'Could not reach the companion.'));
        emitReady(!!r.ok);
        if (r.ok) refreshVersionCheck();
      } else {
        setStatus('unknown');
        emitReady(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist URL + key (if a new one was entered). Does not test — readiness is
  // owned by the separate Test button.
  const onSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const patch: any = { url: url.trim() };
      if (apiKey) patch.apiKey = apiKey;
      const w = await window.api.settings.apiWrite(patch);
      setUrl(w.url);
      setHasStoredKey(!!w.hasApiKey);
      setApiKey('');
      setShowKey(false);
      setStatus('unknown');
      setMessage('Saved. Test the connection to verify.');
      emitReady(false);
    } catch (err: any) {
      setStatus('error');
      setMessage(err?.message || 'Failed to save the connection.');
      emitReady(false);
    } finally {
      setSaving(false);
    }
  };

  // Health-check the current config. Uses the typed key if one is entered
  // (test-before-save), else the stored key.
  const onTest = async () => {
    setTesting(true);
    setMessage('');
    try {
      const args: any = { url: url.trim() };
      if (apiKey) args.apiKey = apiKey;
      const r = await window.api.settings.apiTest(args);
      setStatus(r.ok ? 'ok' : 'error');
      setMessage(r.ok ? `Connected${r.version ? ` — companion ${r.version}` : ''}.` : (r.error || 'Could not reach the companion.'));
      emitReady(!!r.ok);
      if (r.ok) refreshVersionCheck(); else setVerCheck(null);
    } catch (err: any) {
      setStatus('error');
      setMessage(err?.message || 'Connection test failed.');
      emitReady(false);
    } finally {
      setTesting(false);
    }
  };

  const hasKey = !!apiKey || hasStoredKey;
  const canSave = !!url.trim() && hasKey && !saving && !testing;
  const canTest = !!url.trim() && hasKey && !saving && !testing;

  return (
    <SettingsSection
      title="Companion"
      description="Shockwave stores your settings, secrets, workspaces, and chats on your companion server. Point the app at it here — every other page needs this connection."
    >
      <SettingsGroup>
        <Field>
          <FieldLabel htmlFor="companion-url">Companion URL</FieldLabel>
          <Input
            id="companion-url"
            type="text"
            placeholder="https://api.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            className="font-mono"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="companion-key">API key</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="companion-key"
              type={showKey ? 'text' : 'password'}
              placeholder={hasStoredKey ? '•••••••• (stored — leave blank to keep)' : 'Paste your API key'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              className="font-mono"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setShowKey((v) => !v)}>
                {showKey ? 'Hide' : 'Show'}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            Encrypted on this machine with your OS keychain. Only this key leaves the app — your secrets stay on the companion.
          </FieldDescription>
        </Field>

        <div className="flex items-center gap-2">
          <Button type="button" size="sm" className="w-fit" onClick={onSave} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" size="sm" variant="outline" className="w-fit" onClick={onTest} disabled={!canTest}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          {status === 'ok' && <span className="text-xs text-success">{message}</span>}
          {status === 'error' && <span className="text-xs text-destructive">{message}</span>}
          {status === 'unknown' && message && <span className="text-xs text-muted-foreground">{message}</span>}
        </div>

        {verCheck?.status === 'companion-older' && (
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <div className="text-sm">
              Update available — companion <span className="font-mono">{verCheck.companion}</span> →{' '}
              <span className="font-mono">v{String(verCheck.desktop ?? '').replace(/^v/, '')}</span>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setUpdateOpen(true)}>
              Update companion
            </Button>
          </div>
        )}
        {verCheck?.status === 'companion-newer' && (
          <p className="text-xs text-muted-foreground">
            The companion ({verCheck.companion}) is newer than this app — update the desktop app to match.
          </p>
        )}
      </SettingsGroup>

      <CompanionUpdateDialog
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        desktop={verCheck?.desktop}
        companion={verCheck?.companion}
        onUpdated={() => { refreshVersionCheck(); onTest(); }}
      />
    </SettingsSection>
  );
}
