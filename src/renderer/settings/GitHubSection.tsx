import React, { useEffect, useRef, useState } from 'react';
import { SettingsSection, SettingsGroup, SettingsDivider, NUMBER_FIELD } from './SectionUI';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useCommitField } from './useCommitField';
import { removeCredential } from './credentialField';
import CredentialRow from './CredentialRow';
import ErrorMessage from '../ErrorMessage.jsx';

// GitHub — the account and the machine, i.e. everything that is NOT per
// workspace. The token is one account for all of them; the interval is one
// engine; git is one binary on this box.
//
// This was briefly folded into Workspaces, on the theory that a workspace IS a
// repo so the account belonged above the list. The list won that argument: it's
// the thing you actually come to that page for, and three global controls on
// top of it pushed the workspaces below the fold.
//
// The old split's real failure wasn't that the token lived elsewhere — it's
// that Workspaces gave you no way to GET here, so you had to already know. The
// add dialog now links straight to this page when no token is set.

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 600;

const INSTALL_INSTRUCTIONS = {
  darwin: {
    label: 'macOS',
    // Apple ships git inside Command Line Tools (`xcode-select --install`).
    // We recommend Homebrew because it's actively versioned and avoids the
    // CLT update treadmill.
    body: 'Install Homebrew (brew.sh) then run:',
    cmd: 'brew install git',
  },
  win32: {
    label: 'Windows',
    body: 'Download Git for Windows:',
    cmd: 'https://git-scm.com/download/win',
  },
  linux: {
    label: 'Linux',
    body: 'Use your distro\'s package manager. Examples:',
    cmd: 'sudo apt install git    # Debian/Ubuntu\nsudo dnf install git    # Fedora\nsudo pacman -S git      # Arch',
  },
};

export default function GitHubSection({ sync, onSyncChange }) {
  const hasPat = !!sync?.hasPat;
  const interval = sync?.pullIntervalSeconds ?? 10;

  // The PAT is edited locally and committed on blur. Every change here writes
  // settings (re-encrypting through the keychain) AND restarts the sync engine,
  // so typing a token character by character did ~90 of each, against ~90
  // partial tokens.
  // Write-only: main never sends the token down, so this is a draft only.
  const [patDraft, setPatDraft] = useState('');
  const [verifyState, setVerifyState] = useState<any>({ status: 'idle' });
  const [gitState, setGitState] = useState<any>({ status: 'checking' });
  // Tracks the thumb while dragging; the real write happens on release.

  // Cheap (one process) and the answer can change while the app runs, so it's
  // re-checked whenever the section mounts rather than cached.
  useEffect(() => {
    let cancelled = false;
    setGitState({ status: 'checking' });
    window.api.sync.checkGit().then((res) => {
      if (cancelled) return;
      setGitState({ status: res.ok ? 'ok' : 'missing', ...res });
    });
    return () => { cancelled = true; };
  }, []);

  // No `pat` here — main strips it, so including it would send '' and delete it.
  const updateSync = (patch) => onSyncChange?.({ pullIntervalSeconds: interval, ...patch });

  // Verifying a token the user hasn't saved yet: pass the current form value
  // (not the persisted one) so they can verify before committing.
  // Each verify claims a token. Without it, editing the PAT mid-flight (which
  // resets the result to idle) still got overwritten by the in-flight response —
  // a green "Signed in as X" beside a token that was never checked.
  const verifyReq = useRef(0);
  const onVerify = async () => {
    // Empty draft is not "nothing to do" — it's the normal state, because the
    // renderer is never given the stored token. Main verifies the saved one when
    // nothing is typed; returning early here is what made Verify dead for anyone
    // who already had a token.
    const value = patDraft.trim();
    const req = ++verifyReq.current;
    setVerifyState({ status: 'checking' });
    const res = await window.api.sync.verifyPat(value);
    if (verifyReq.current !== req) return;
    setVerifyState(res.ok
      ? { status: 'ok', login: res.login, name: res.name }
      : { status: 'error', error: res.error });
  };

  // A stale green check next to a changed token would be actively misleading.
  const onPatChange = (e) => {
    setPatDraft(e.target.value);
    verifyReq.current++;   // invalidate any verify already in flight
    if (verifyState.status !== 'idle') setVerifyState({ status: 'idle' });
  };

  const commitPat = () => {
    if (patDraft) { updateSync({ pat: patDraft }); setPatDraft(''); }
  };

  // Removing the token is a separate call from saving one — see removeCredential.
  // The `hasPat` flag comes back through `settings:changed`, so the field and this
  // button update themselves once main confirms.
  const [removing, setRemoving] = useState(false);
  const onRemovePat = async () => {
    setRemoving(true);
    try {
      const r = await removeCredential('sync.pat');
      if (!r?.ok) setVerifyState({ status: 'error', error: r?.error || 'Could not remove the token.' });
      else { setPatDraft(''); setVerifyState({ status: 'idle' }); }
    } finally {
      setRemoving(false);
    }
  };

  // Clamped here as well as on the slider: the engine clamps to this same range
  // anyway, so anything outside it would silently not apply.
  // Commits on blur like every other numeric settings box. Blank restores the
  // stored value rather than writing 0 — there is no "no interval" state, and the
  // engine would clamp it to the minimum anyway.
  const intervalField = useCommitField(
    String(interval),
    (next) => { if (next.trim()) setInterval(Number(next)); },
  );

  const setInterval = (n: number) => {
    if (!Number.isFinite(n)) return;
    updateSync({ pullIntervalSeconds: Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, n)) });
  };

  const install = INSTALL_INSTRUCTIONS[gitState.platform] || INSTALL_INSTRUCTIONS.linux;

  return (
    <SettingsSection
      title="GitHub"
      description="The account your workspaces live under, and how often they sync."
    >
      <SettingsGroup title="Account">
        <Field>
          <FieldLabel htmlFor="sync-pat">Personal Access Token</FieldLabel>
          <CredentialRow
            id="sync-pat"
            saved={hasPat}
            value={patDraft}
            onChange={onPatChange}
            onBlur={commitPat}
            actions={
              <>
                {/* This page's one primary: checking the token is the action you come
                    here to take. Enabled whenever there is something to check —
                    either typed here or already stored. Gating it on the draft alone
                    disabled it forever, since the draft is empty unless you're
                    mid-edit. */}
                <Button onClick={onVerify} disabled={(!patDraft.trim() && !hasPat) || verifyState.status === 'checking'}>
                  {verifyState.status === 'checking' ? 'Verifying…' : 'Verify'}
                </Button>
                {/* Only route that removes a stored token — clearing the box can't, by
                    design. Destructive styling because sync stops until a new one is
                    entered, and because a token you delete here is one you probably
                    need to revoke on GitHub too. */}
                {hasPat && (
                  <Button variant="destructive" onClick={onRemovePat} disabled={removing}>
                    {removing ? 'Removing…' : 'Remove'}
                  </Button>
                )}
              </>
            }
          />
          <FieldDescription className="text-xs">
            Needs <code className="font-mono">Contents: Read and write</code>, plus{' '}
            <code className="font-mono">Administration: Write</code> to create repos.{' '}
            <a
              href="#"
              className="text-primary hover:underline"
              onClick={(e) => { e.preventDefault(); window.api.openExternal('https://github.com/settings/tokens?type=beta'); }}
            >Create one</a>. Encrypted with your OS keychain.
          </FieldDescription>
          {verifyState.status === 'ok' && (
            <p className="text-xs text-success">
              ✓ Signed in as <strong>{verifyState.login}</strong>
              {verifyState.name ? ` (${verifyState.name})` : ''}
            </p>
          )}
          {verifyState.status === 'error' && <ErrorMessage>{verifyState.error}</ErrorMessage>}
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Sync">
        <Field>
          <FieldLabel htmlFor="sync-interval">Sync Interval Seconds</FieldLabel>
          <Input
            id="sync-interval"
            className={NUMBER_FIELD}
            type="number"
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            placeholder="10"
            value={intervalField.value}
            onChange={(e) => intervalField.onChange(e.target.value)}
            onBlur={intervalField.onBlur}
          />
          <FieldDescription className="text-xs">
            How often the open workspace pulls and pushes. {MIN_INTERVAL}&ndash;{MAX_INTERVAL}s.
          </FieldDescription>
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="System">
        {gitState.status === 'checking' && (
          <p className="text-xs text-muted-foreground">Checking for git…</p>
        )}
        {gitState.status === 'ok' && (
          <p className="text-xs text-success">✓ {gitState.version}</p>
        )}
        {gitState.status === 'missing' && (
          <div className="flex flex-col gap-2">
            <ErrorMessage>git not found on PATH. Workspaces require git to be installed.</ErrorMessage>
            <p className="text-xs text-muted-foreground">
              <strong>{install.label}:</strong> {install.body}
            </p>
            <pre className="m-0 rounded-md bg-raise px-3 py-2 font-mono text-xs whitespace-pre-wrap">{install.cmd}</pre>
          </div>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
