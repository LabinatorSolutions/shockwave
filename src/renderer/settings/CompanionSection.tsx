import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCommitField, useCredentialField } from './useCommitField';
import CredentialRow from './CredentialRow';
import CompanionUpdateDialog from '../CompanionUpdateDialog.jsx';

// The desktop's connection to the Shockwave companion (server URL + API key).
// Every other settings page reads/writes through this connection. The modal's
// gate on those pages is NOT driven from here — it follows the live feed
// (`companionOnline`); this page's probe is pure diagnostics: it tells the user
// WHAT is wrong (unreachable / bad key / certificate awaiting approval), while
// the feed tells the app WHETHER the stored connection works.
//
// The URL is stored plaintext; the key is safeStorage-wrapped in main. Neither
// crosses back to the renderer — api:read returns only { url, hasApiKey }.
//
// ── Two acts, both explicit ──────────────────────────────────────────────────
//
// Fields still store on blur, like every other settings page. But storing is not
// connecting: **Connect** goes and looks at the server, and **Approve** is what
// records its certificate. Neither happens on its own.
//
// Nothing here can approve a certificate. `api:test` only reports;
// `api:approveCert` is the single path that stores one, and it is reachable only
// from the button underneath a fingerprint the user is looking at. An earlier
// design adopted an unknown certificate automatically during a 30s window after
// a connect attempt — which decided first approval FOR the user without ever
// showing them a fingerprint, so someone intercepting first setup got recorded
// silently and permanently. Don't reintroduce an automatic path. See
// "Companion TLS" in src/main/CLAUDE.md.
//
// Editing either field drops the connection back to "not connected", so the
// status line can never show a stale green for details that have since changed.

type Status = 'idle' | 'checking' | 'connected' | 'failed' | 'needsApproval';

interface CertInfo { host: string; approved: string | null; offered: string }

export default function CompanionSection() {
  const [storedUrl, setStoredUrl] = useState('');
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  // Write-only: the key never reads back (api:read returns hasApiKey, not the
  // key), so it's a draft cleared once stored — `useCredentialField`, not
  // `useCommitField`, which has no stored value here to follow.
  const keyField = useCredentialField((next) => {
    save({ url: urlField.value.trim(), apiKey: next });
  });
  const keyDraft = keyField.value;
  // The certificate the server offered, when it isn't the approved one.
  // `approved === null` = never approved (first connection); a value = approved
  // once and has since changed. Different question, different wording.
  const [cert, setCert] = useState<CertInfo | null>(null);
  // The certificate currently approved on this machine. Shown while connected so
  // the user can check it against `shockwave-fingerprint` on the server whenever
  // they like — not only during first setup. Empty when the server has a
  // publicly-trusted certificate, since then nothing is pinned.
  const [approvedFp, setApprovedFp] = useState('');
  // Companion-vs-desktop version check. Runs after a successful connection: the
  // two are cut from the same release tag, so a mismatch means one side is stale.
  const [verCheck, setVerCheck] = useState<{ status: string; desktop?: string; companion?: string } | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);

  const refreshVersionCheck = () => {
    window.api.settings.apiCheckVersion().then(setVerCheck).catch(() => setVerCheck(null));
  };

  // Only the newest probe may publish. Press Connect twice, or edit a field
  // mid-probe, and a slower earlier reply must not overwrite a newer result.
  const probeReq = useRef(0);

  // Drop to "not connected" without probing. Called when the stored details
  // change and when a field is edited — a green line describing a URL you have
  // since changed is a lie.
  const disconnect = useCallback((msg: string) => {
    probeReq.current++;              // invalidate anything in flight
    setStatus('idle');
    setMessage(msg);
    setCert(null);
    setVerCheck(null); // it described the connection we just dropped
  }, []);

  // Probe. Reports only — it cannot approve a certificate.
  const connect = useCallback(async (url: string, apiKey?: string) => {
    if (!url.trim()) { disconnect(''); return; }
    const req = ++probeReq.current;
    setStatus('checking');
    setMessage(`Contacting ${url.trim()}…`);
    try {
      const args: any = { url: url.trim() };
      if (apiKey) args.apiKey = apiKey;
      const r = await window.api.settings.apiTest(args);
      if (probeReq.current !== req) return;
      if (r.ok) {
        // No message — the row's heading already says "Connected", and repeating
        // it rendered "Connected / Connected." one under the other.
        setStatus('connected'); setMessage(''); setCert(null);
        // Re-read: an approval that just happened changes what's stored.
        window.api.settings.apiRead().then((c) => setApprovedFp(c.certFingerprint || '')).catch(() => {});
        refreshVersionCheck();
      } else if (r.certNeedsApproval) {
        setStatus('needsApproval'); setMessage(''); setCert(r.certNeedsApproval);
      } else {
        setStatus('failed'); setMessage(r.error || 'Could not reach the companion.'); setCert(null);
      }
    } catch (err: any) {
      if (probeReq.current !== req) return;
      setStatus('failed');
      setMessage(err?.message || 'Connection attempt failed.');
      setCert(null);
    }
  }, [disconnect]);

  // On open: show what's stored and re-probe. Safe now that a probe can't
  // approve anything — it either confirms an already-approved server or reports
  // that one is waiting. Opening a page decides nothing.
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await window.api.settings.apiRead();
      if (!alive) return;
      setStoredUrl(c.url || '');
      setHasStoredKey(!!c.hasApiKey);
      setApprovedFp(c.certFingerprint || '');
      if (c.url && c.hasApiKey) connect(c.url);
      else setMessage('Enter your server details, then press Connect.');
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Store only. Connecting is the button's job.
  const save = useCallback(async (patch: any) => {
    try {
      const w = await window.api.settings.apiWrite(patch);
      setStoredUrl(w.url);
      setHasStoredKey(!!w.hasApiKey);
      disconnect('Saved. Press Connect.');
    } catch (err: any) {
      setStatus('failed');
      setMessage(err?.message || 'Failed to save the connection.');
    }
  }, [disconnect]);

  const urlField = useCommitField(storedUrl, (next) => { save({ url: next.trim() }); });

  // Typing invalidates a live "Connected" immediately — before the blur that
  // stores it — so the line always describes what's in the boxes.
  const onUrlChange = (next: string) => {
    urlField.onChange(next);
    if (status === 'connected' || status === 'needsApproval') disconnect('Press Connect to use the new address.');
  };
  const onKeyChange = (next: string) => {
    keyField.onChange(next);
    if (status === 'connected' || status === 'needsApproval') disconnect('Press Connect to use the new key.');
  };

  // The typed key if one is sitting in the box (it may not have blurred yet),
  // else the stored one.
  const onConnect = () => connect(urlField.value, keyDraft || undefined);
  const canConnect = !!urlField.value.trim() && (!!keyDraft || hasStoredKey) && status !== 'checking';

  // The one path that pins a certificate — and only for the fingerprint rendered
  // above the button. Re-probes afterwards so the row reflects the real result
  // rather than assuming approval was enough.
  const onApprove = async () => {
    if (!cert) return;
    const r = await window.api.settings.approveCert(cert.offered);
    if (!r?.ok) { setStatus('failed'); setMessage(r?.error || 'Could not store the certificate.'); return; }
    setCert(null);
    await connect(urlField.value.trim(), keyDraft || undefined);
  };

  // Un-approve, then re-probe — which lands back on the approval panel with the
  // fingerprint on screen, so the next approval is a fresh look rather than a
  // dead end.
  const onForget = async () => {
    await window.api.settings.forgetCert();
    setApprovedFp('');
    await connect(urlField.value.trim(), keyDraft || undefined);
  };

  const firstConnection = !cert?.approved;

  return (
    <SettingsSection
      title="Companion"
      description="Your settings, secrets, workspaces, and chats live on your companion server. Every other page needs this connection."
    >
      <SettingsGroup>
        {/* Version mismatch rides at the top of the page, not down by Connect.
            It only ever renders while connected (`disconnect` clears verCheck),
            but it's the one thing here that needs doing rather than setting up
            once — below the fields and the status row it was missed. */}
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
            Companion ({verCheck.companion}) is newer than this app — update the desktop app.
          </p>
        )}

        <Field>
          <FieldLabel htmlFor="companion-url">Server URL</FieldLabel>
          <Input
            id="companion-url"
            type="text"
            placeholder="https://203.0.113.10"
            value={urlField.value}
            onChange={(e) => onUrlChange(e.target.value)}
            onBlur={urlField.onBlur}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            className="font-mono"
          />
          {/* The self-signed caveat used to be spelled out here, for a case most
              users hit once. The approval panel below explains it in context and
              only when it applies. */}
          <FieldDescription>
            Printed by the installer. With no domain, your server&rsquo;s IP over https.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="companion-key">API key</FieldLabel>
          <CredentialRow
            id="companion-key"
            saved={hasStoredKey}
            value={keyDraft}
            onChange={(e) => onKeyChange(e.target.value)}
            onBlur={keyField.onBlur}
          />
          <FieldDescription>
            Also printed by the installer. Encrypted in your OS keychain.
          </FieldDescription>
        </Field>

        {/* One status row, always present. This page gates every other page, so
            its state has to be unmissable rather than a small grey note. */}
        <div
          className={[
            'rounded-lg border px-3 py-2.5 text-xs',
            status === 'connected' ? 'border-success/40 bg-success-soft'
              : status === 'failed' ? 'border-destructive/40 bg-destructive/5'
              : status === 'needsApproval' ? 'border-ring/50 bg-ring/5'
              : 'border-border bg-raise',
          ].join(' ')}
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={[
                'size-2 shrink-0 rounded-full',
                status === 'connected' ? 'bg-success'
                  : status === 'failed' ? 'bg-destructive'
                  : status === 'needsApproval' ? 'bg-ring'
                  : status === 'checking' ? 'bg-muted-foreground animate-pulse'
                  : 'bg-muted-foreground/50',
              ].join(' ')}
            />
            <span className="font-medium">
              {status === 'connected' ? 'Connected'
                : status === 'checking' ? 'Connecting…'
                : status === 'failed' ? "Couldn't connect"
                : status === 'needsApproval'
                  ? (firstConnection ? 'Approve this server' : 'This server’s identity has changed')
                  : 'Not connected'}
            </span>
          </div>

          {status !== 'needsApproval' && message && (
            <p className="mt-1 text-muted-foreground">{message}</p>
          )}

          {/* What's actually running over there. It used to surface ONLY as a
              mismatch prompt, so the common case — the two agree — showed no
              version at all, and "is my server current?" had no answer on the
              page that owns the server. Read from the same `verCheck` the
              mismatch rows use, so there is one version fact and it can't
              disagree with itself.

              Ephemeral by construction: `verCheck` is component state and this
              section is conditionally mounted, so leaving the page drops it and
              a stale version can never outlive the connection it described —
              the same reason `disconnect` clears it. */}
          {status === 'connected' && verCheck?.companion && (
            <p className="mt-1 text-muted-foreground">
              Running <span className="font-mono">{verCheck.companion}</span>
              {verCheck.status === 'match' && <> &mdash; up to date</>}
            </p>
          )}

          {/* Connected on an approved certificate — show which one, so it can be
              checked against `shockwave-fingerprint` on the server at any time,
              not just during setup. Absent for a publicly-trusted certificate,
              where nothing is pinned and there's nothing to compare. */}
          {status === 'connected' && approvedFp && (
            <div className="mt-2">
              <p className="text-muted-foreground">
                Approved certificate &mdash; compare with{' '}
                <code className="font-mono">shockwave-fingerprint</code> on the server.
              </p>
              <p className="mt-1 font-mono break-all">{approvedFp}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 w-fit"
                onClick={onForget}
              >
                Forget it
              </Button>
            </div>
          )}

          {status === 'needsApproval' && cert && (
            <>
              <p className="mt-1 text-muted-foreground">
                {/* Kept concrete on purpose. These two are the only text on the
                    page a user must actually weigh — everything else was trimmed
                    so these stand out rather than compete. */}
                {firstConnection ? (
                  <>
                    {cert.host} is self-signed, so nothing vouches for it. Approve only if this
                    fingerprint matches the one the installer printed.
                  </>
                ) : (
                  <>
                    {cert.host} is offering a different certificate than the one you approved. Normal
                    after a rebuild or move &mdash; and also what an impostor looks like. Continue
                    only if you know why it changed.
                  </>
                )}
              </p>
              <dl className="mt-2 space-y-1 font-mono break-all">
                {!firstConnection && (
                  <div>
                    <dt className="inline text-muted-foreground">Approved: </dt>
                    <dd className="inline">{cert.approved}</dd>
                  </div>
                )}
                <div>
                  <dt className="inline text-muted-foreground">
                    {firstConnection ? 'Fingerprint: ' : 'Now offering: '}
                  </dt>
                  <dd className="inline">{cert.offered || '(unknown)'}</dd>
                </div>
              </dl>
              {/* Not the page's primary — Connect is. First approval isn't
                  destructive; replacing one that changed can mean an impostor. */}
              <Button
                type="button"
                size="sm"
                variant={firstConnection ? 'outline' : 'destructive'}
                className="mt-3 w-fit"
                onClick={onApprove}
              >
                {firstConnection ? 'Approve and connect' : 'Approve the new certificate'}
              </Button>
            </>
          )}
        </div>

        <Button type="button" size="sm" className="w-fit" onClick={onConnect} disabled={!canConnect}>
          {status === 'checking' ? 'Connecting…' : 'Connect'}
        </Button>
      </SettingsGroup>

      <CompanionUpdateDialog
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        desktop={verCheck?.desktop}
        companion={verCheck?.companion}
      />
    </SettingsSection>
  );
}
