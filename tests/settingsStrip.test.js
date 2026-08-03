// The main→renderer credential strip. `tests/credentials.test.js` pins WHICH
// fields are credentials; this pins what the stripped object LOOKS like, which is
// what the renderer branches on.
import test from 'node:test';
import assert from 'node:assert/strict';

import { stripCredentials } from '../src/main/settingsStrip.ts';

test('a static-token agent secret does not grow an oauth object', () => {
  // The shape ensureBuiltinSecretSlots provisions: a name, a description, and an
  // empty token. Writing the `oauth.hasClientSecret` flag used to invent an
  // `oauth: {}` here, and the renderer classifies by `!!s.oauth` — so every token
  // rendered as an OAuth connection with a Reconnect button that could only fail.
  const out = stripCredentials({
    agentSecrets: [
      { name: 'FIRECRAWL_API_KEY', description: 'Used by the firecrawl skill', token: '' },
    ],
  });
  const secret = out.agentSecrets[0];
  assert.equal('oauth' in secret, false);
  assert.equal(secret.hasToken, false);
  assert.equal('token' in secret, false);
});

test('a stored token reports present, and never comes back as a value', () => {
  const out = stripCredentials({
    agentSecrets: [{ name: 'FIRECRAWL_API_KEY', token: 'fc-real-key' }],
  });
  assert.equal(out.agentSecrets[0].hasToken, true);
  assert.equal('token' in out.agentSecrets[0], false);
});

test('a real OAuth secret keeps its oauth object and gets its flags', () => {
  const out = stripCredentials({
    agentSecrets: [{
      name: 'GMAIL',
      kind: 'oauth',
      oauth: {
        provider: 'google',
        clientId: 'abc.apps.googleusercontent.com',
        clientSecret: 'shh',
        accessToken: 'at',
        refreshToken: '',
        status: 'connected',
      },
    }],
  });
  const { oauth } = out.agentSecrets[0];
  assert.equal(oauth.provider, 'google');
  assert.equal(oauth.status, 'connected');
  assert.equal(oauth.hasClientSecret, true);
  assert.equal(oauth.hasAccessToken, true);
  assert.equal(oauth.hasRefreshToken, false);
  for (const k of ['clientSecret', 'accessToken', 'refreshToken']) {
    assert.equal(k in oauth, false, `${k} must not cross into the renderer`);
  }
});

test('fixed-path settings credentials become flags beside where they were', () => {
  const out = stripCredentials({
    transcription: { provider: 'assemblyai' },
    voiceKeys: { assemblyai: 'aai-key', deepgram: 'dg-key', elevenlabs: '' },
    sync: { pat: 'github_pat_x', intervalSeconds: 10 },
    codingAgent: { provider: 'anthropic', providerKeys: { anthropic: 'sk-ant', openai: '' } },
  });
  assert.equal(out.sync.hasPat, true);
  assert.equal(out.sync.intervalSeconds, 10);
  // The wildcard map's flag is a map, so the box shows dots per provider — and
  // only for providers that actually have a key stored.
  assert.deepEqual(out.codingAgent.hasProviderKey, { anthropic: true });
  assert.equal('providerKeys' in out.codingAgent, false);
  // Same rule for the vendor-keyed voice map, which lives at the ROOT — a
  // top-level credential leaves its flag at the root too, with nothing to invent.
  assert.deepEqual(out.hasVoiceKey, { assemblyai: true, deepgram: true });
  assert.equal('voiceKeys' in out, false);
  // The listening half keeps its non-secret fields untouched.
  assert.equal(out.transcription.provider, 'assemblyai');
});

test('an absent settings slice is not invented to hold a flag', () => {
  // Same rule as the agent-secret case: unset must read as unset, not as a slice
  // that exists and happens to be empty.
  const out = stripCredentials({ appearance: { themeMode: 'dark' } });
  assert.equal('transcription' in out, false);
  assert.equal('sync' in out, false);
  assert.equal('codingAgent' in out, false);
});
