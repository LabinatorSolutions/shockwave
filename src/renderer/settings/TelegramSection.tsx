import React, { useEffect, useState } from 'react';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

// Telegram integration. Everything happens on the companion (it owns the bot,
// registers the webhook, and runs the turns) — this page just triggers those
// actions. A message to the bot runs the agent on the bot's workspace (picked
// below, or /workspace in the bot) and streams the reply back to Telegram.
export default function TelegramSection({ workspaces, transcription, onTranscriptionChange }: {
  workspaces?: any[];
  transcription?: any;
  onTranscriptionChange?: (next: any) => void;
}) {
  const [status, setStatus] = useState<any>(null);
  const [botToken, setBotToken] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = () => window.api.settings.telegramStatus().then(setStatus).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const connect = async () => {
    setBusy(true); setMsg(null);
    const r = await window.api.settings.telegramConnect({ botToken: botToken.trim(), authorizedTgUserId: Number(userId.trim()) });
    setBusy(false);
    if (r.ok) { setMsg({ ok: true, text: `Connected as @${r.botUsername}.` }); setBotToken(''); refresh(); }
    else setMsg({ ok: false, text: r.error || 'Could not connect.' });
  };

  const disconnect = async () => {
    setBusy(true); setMsg(null);
    const r = await window.api.settings.telegramDisconnect();
    setBusy(false);
    if (r.ok) { setMsg({ ok: true, text: 'Disconnected.' }); refresh(); }
    else setMsg({ ok: false, text: r.error || 'Could not disconnect.' });
  };

  const setWorkspace = async (workspaceId: string) => {
    setBusy(true); setMsg(null);
    const r = await window.api.settings.telegramSetWorkspace(workspaceId);
    setBusy(false);
    if (r.ok) refresh();
    else setMsg({ ok: false, text: r.error || 'Could not switch workspace.' });
  };

  const connected = status?.ok && status?.connected;

  return (
    <SettingsSection
      title="Telegram"
      description="Message your agent from Telegram. A message runs the agent on the companion's default workspace and streams the reply back. Create a bot with @BotFather to get a token; get your numeric user id from @userinfobot."
    >
      <SettingsGroup>
        {connected ? (
          <>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
              <div>
                <div className="text-[13px] font-medium">Connected{status.botUsername ? ` as @${status.botUsername}` : ''}</div>
                <div className="text-xs text-muted-foreground">Message the bot on Telegram to run the agent.</div>
              </div>
              <Button type="button" size="sm" onClick={disconnect} disabled={busy}>
                {busy ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
            <Field>
              <FieldLabel htmlFor="tg-workspace">Default workspace</FieldLabel>
              {/* Always-controlled: '' matches no item, so the placeholder shows.
                  `?? undefined` flipped the Select to uncontrolled while status
                  loaded, then controlled again — selection acted flaky. */}
              <Select value={status.workspaceId ?? ''} onValueChange={setWorkspace} disabled={busy || !(workspaces?.length)}>
                <SelectTrigger id="tg-workspace" className="w-full">
                  <SelectValue placeholder={workspaces?.length ? 'Choose a workspace' : 'No workspaces yet'} />
                </SelectTrigger>
                <SelectContent>
                  {(workspaces || []).map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>The default workspace a Telegram message runs the agent on. Changing it starts a fresh chat — same as /workspace in the bot.</FieldDescription>
            </Field>
          </>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="tg-token">Bot token</FieldLabel>
              {/* Not a CredentialRow: this one is never stored-and-hidden — it's
                  a connect-flow field that is always empty until you paste, so
                  its placeholder is a format example rather than the dots. Width
                  still has to match, hence a plain full-width Input. The old
                  InputGroup here wrapped an EMPTY inline-end addon, which bought
                  nothing and cost 8px of text column. */}
              <Input
                id="tg-token" type="password" className="w-full font-mono"
                placeholder="123456:ABC-DEF…" value={botToken}
                onChange={(e) => setBotToken(e.target.value)} spellCheck={false} autoComplete="off"
              />
              <FieldDescription>From @BotFather. Stored encrypted on the companion — it never lives on this machine.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="tg-user">Your Telegram user id</FieldLabel>
              <Input id="tg-user" type="text" className="font-mono" placeholder="123456789" value={userId} onChange={(e) => setUserId(e.target.value)} spellCheck={false} />
              <FieldDescription>Only this user can drive the bot. Get it from @userinfobot.</FieldDescription>
            </Field>
            <div className="flex items-center gap-3">
              <Button type="button" size="sm" onClick={connect} disabled={busy || !botToken.trim() || !userId.trim()}>
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
              <span className="text-xs text-muted-foreground">The companion needs a public HTTPS URL (TELEGRAM_PUBLIC_URL) for the webhook.</span>
            </div>
          </>
        )}
        {msg && <p className={msg.ok ? 'text-xs text-success' : 'text-xs text-destructive'}>{msg.text}</p>}
      </SettingsGroup>

      <SettingsDivider />

      {/* Voice notes to the bot are transcribed on the COMPANION (AssemblyAI, the
          same `transcription.apiKey` the desktop mic uses) because the agent takes
          text only — so there is a transcript here that the desktop mic path never
          produces, and this decides whether the bot says it out loud before acting.
          Spread the whole slice: `onTranscriptionChange` REPLACES the renderer's
          copy, so a bare `{echoTelegramTranscript}` would drop `hasApiKey` and make
          the Transcription page read as if no key were stored until the next push. */}
      <SettingsGroup title="Voice notes">
        <Field>
          <Label className="gap-2.5 text-[13px] font-normal">
            <Checkbox
              checked={!!transcription?.echoTelegramTranscript}
              onCheckedChange={(v) => onTranscriptionChange?.({
                ...(transcription ?? { provider: 'assemblyai' }),
                echoTelegramTranscript: v === true,
              })}
            />
            Echo the transcript back in the chat
          </Label>
          <FieldDescription>
            Posts what was heard as 🎤 “…” before the agent runs, so a misheard word
            is distinguishable from a misunderstood instruction.
          </FieldDescription>
        </Field>
      </SettingsGroup>
    </SettingsSection>
  );
}
