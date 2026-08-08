// The renderer's one settings object, and the rule that makes it one: it is a
// pure function of the payload, so nothing can survive a payload that doesn't
// mention it.
//
// This is what broke when the app was pointed at a second companion. The
// companion answers `GET /settings` from the rows it HAS (`api/src/store.ts`),
// so a setting nobody has set on that server is ABSENT from the response — not
// empty, absent. The renderer used to fan the payload out into twenty `useState`
// slices with seven of the assignments guarded on the key being present, so
// "the new server has no row for this" was applied as "keep the old server's
// value". Every test below is that scenario.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings, EMPTY_SETTINGS } from '../src/renderer/settingsModel.ts';

// What a companion that has been fully configured sends back, credentials
// already replaced by flags (see src/main/settingsStrip.ts).
const CONFIGURED = {
  codingAgent: { provider: 'anthropic', model: 'claude-opus-5', hasProviderKey: { anthropic: true }, baseUrl: '' },
  transcription: { provider: 'deepgram', micProvider: 'assemblyai', echoTelegramTranscript: true },
  speech: { provider: 'elevenlabs', voiceId: 'v1', modelId: 'm1', telegramReply: 'voice' },
  hasVoiceKey: { deepgram: true, elevenlabs: true },
  sync: { hasPat: true, pullIntervalSeconds: 30 },
  telegram: { chatNotice: { gapHours: 24 } },
  timezone: 'America/New_York',
  appearance: { themeMode: 'dark', hideLineNumbers: true, treePanel: { recent: { show: true, count: 5 }, daily: { show: false, count: 10 } } },
};

// The one a fresh companion sends: it has workspaces and an (empty) secret list,
// and no settings rows at all.
const FRESH = { workspaces: [], agentSecrets: [] };

test('a key the payload omits reads as unset, not as the previous value', () => {
  // The whole point: normalize is a function of its argument. Whatever was on
  // screen a moment ago cannot reach it, so switching companions can only ever
  // show the new one's answer.
  const before = normalizeSettings(CONFIGURED);
  assert.equal(before.codingAgent.provider, 'anthropic');
  assert.equal(before.sync.hasPat, true);

  const after = normalizeSettings(FRESH);
  assert.equal(after.codingAgent.provider, '');
  assert.equal(after.codingAgent.model, '');
  assert.deepEqual(after.codingAgent.hasProviderKey, {});
  assert.equal(after.transcription.provider, '');
  assert.equal(after.transcription.micProvider, '');
  assert.equal(after.speech.provider, '');
  assert.deepEqual(after.hasVoiceKey, {});
  assert.equal(after.sync.hasPat, false);
  assert.equal(after.timezone, 'UTC');
  assert.equal(after.appearance.themeMode, 'system');
});

test('codingAgent does not fall back to a previous object', () => {
  // `const ca = disk.codingAgent ?? settingsRef.current.codingAgent` is the line
  // this replaced, and it was the one case that was not merely cosmetic: the
  // stale slice landed in the canonical cache, which is the diff base for saves
  // AND the merge source for `onCodingAgentChange` — so the OLD server's
  // provider and model could be written into the NEW one on the next edit.
  const after = normalizeSettings(FRESH);
  assert.deepEqual(after.codingAgent, EMPTY_SETTINGS.codingAgent);
});

test('normalize is pure — the same payload always gives the same answer', () => {
  const a = normalizeSettings(FRESH);
  const b = normalizeSettings(CONFIGURED);
  const c = normalizeSettings(FRESH);
  assert.deepEqual(a, c);
  assert.notDeepEqual(a, b);
});

test('nothing is invented for a DB-backed value', () => {
  // The desktop applying a default makes a setting look configured on screen
  // while the Telegram and cron runners — which read the same database directly
  // — see the hole and fail. A `DEFAULT_SETTINGS` merge did exactly that to
  // `codingAgent.provider`: the page showed `anthropic`, the server-side agent
  // threw "provider not configured".
  const s = normalizeSettings({});
  assert.equal(s.codingAgent.provider, '');
  assert.equal(s.codingAgent.model, '');
  assert.equal(s.transcription.provider, '');
  assert.equal(s.speech.provider, '');
  // `thinkingLevel` unset means the agent runs with thinking OFF. A page showing
  // 'medium' would name a level that never runs.
  assert.equal(s.codingAgent.thinkingLevel, undefined);
});

test('machine-local values keep their defaults — those need no server', () => {
  // The exception, and the only one. These live in a userData file that main
  // always supplies, so they are never absent because a companion is fresh.
  const s = normalizeSettings({});
  assert.equal(s.viewMode, 'live');
  assert.equal(s.treeSortOrder, 'name-asc');
  assert.equal(s.sidebarWidth, 260);
  assert.equal(s.chatSidebarOpen, true);
  assert.equal(s.chatSources, null); // null means "all sources", not "none"
});

test('a value the payload does carry wins over the unset default', () => {
  const s = normalizeSettings(CONFIGURED);
  assert.equal(s.transcription.micProvider, 'assemblyai');
  assert.equal(s.transcription.echoTelegramTranscript, true);
  assert.equal(s.speech.telegramReply, 'voice');
  assert.equal(s.sync.pullIntervalSeconds, 30);
  assert.equal(s.appearance.hideLineNumbers, true);
  assert.deepEqual(s.telegram, { chatNotice: { gapHours: 24 } });
});

test('micProvider survives a hydrate', () => {
  // It was dropped by a two-field whitelist, so it persisted correctly and then
  // vanished from the screen on the next push.
  const s = normalizeSettings({ transcription: { provider: 'deepgram', micProvider: 'assemblyai' } });
  assert.equal(s.transcription.micProvider, 'assemblyai');
});

test('telegramReply goes through the shared normalizer, unset ⇒ text', () => {
  assert.equal(normalizeSettings({}).speech.telegramReply, 'text');
  assert.equal(normalizeSettings({ speech: { telegramReply: 'both' } }).speech.telegramReply, 'both');
  assert.equal(normalizeSettings({ speech: { telegramReply: 'nonsense' } }).speech.telegramReply, 'text');
});

test('both retired treePanel shapes still migrate forward', () => {
  // Superseded rows stay in the DB — nothing deletes a settings row for a key
  // that stops being written — so an older build on another machine keeps
  // reading them, and this only ever falls BACK to them.
  const legacyBool = normalizeSettings({ appearance: { dailyNotesInBookmarks: true } });
  assert.equal(legacyBool.appearance.treePanel.daily.show, true);
  assert.equal(legacyBool.appearance.treePanel.recent.show, false);

  const legacyContent = normalizeSettings({ appearance: { treePanel: { content: 'both', count: 7 } } });
  assert.equal(legacyContent.appearance.treePanel.recent.show, true);
  assert.equal(legacyContent.appearance.treePanel.daily.show, true);
  assert.equal(legacyContent.appearance.treePanel.recent.count, 7);

  // The current shape wins over both.
  const current = normalizeSettings({
    appearance: { treePanel: { content: 'both', count: 7, recent: { show: false, count: 3 } } },
  });
  assert.equal(current.appearance.treePanel.recent.show, false);
  assert.equal(current.appearance.treePanel.recent.count, 3);
});

test('junk in, usable shape out', () => {
  // A payload is a network response; it must not be able to crash the renderer.
  for (const junk of [null, undefined, 'nope', 42, []]) {
    const s = normalizeSettings(junk);
    assert.equal(typeof s.appearance.themeMode, 'string');
    assert.deepEqual(s.workspaces, []);
    assert.deepEqual(s.agentSecrets, []);
  }
  const bad = normalizeSettings({ workspaces: 'not-an-array', agentSecrets: {}, openTabs: 7, chatSources: 'all' });
  assert.deepEqual(bad.workspaces, []);
  assert.deepEqual(bad.agentSecrets, []);
  assert.deepEqual(bad.openTabs, {});
  assert.equal(bad.chatSources, null);
});

test('EMPTY_SETTINGS is what a reset lands on, and it holds no companion values', () => {
  // `resetSettings` (the companion-changed handler) applies this object.
  assert.equal(EMPTY_SETTINGS.codingAgent.provider, '');
  assert.equal(EMPTY_SETTINGS.transcription.provider, '');
  assert.equal(EMPTY_SETTINGS.sync.hasPat, false);
  assert.deepEqual(EMPTY_SETTINGS.hasVoiceKey, {});
  assert.deepEqual(EMPTY_SETTINGS.workspaces, []);
  assert.equal(EMPTY_SETTINGS.activeWorkspaceId, null);
});
