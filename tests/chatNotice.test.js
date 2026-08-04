// The catching-up notice's settings (agent-core/chatNotice.ts) — the one
// declaration of how stale a chat has to be before Telegram says anything, and
// how many of the newer chats it lists.
//
// Why this is tested: two builds read it. The companion decides whether to send
// the notice; the desktop's Telegram page renders the values in effect. If those
// two ever resolve an unset field differently, the page says 24 hours while the
// bot waits 48 — and nothing anywhere would report the disagreement. Pinning the
// resolver is what makes one declaration actually mean one behaviour.
//
// The clamping matters for a second reason: the numbers arrive from a text box,
// by way of a JSON column, so "24" and -1 and 999 are all things this really sees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_NOTICE_DEFAULTS, resolveChatNotice } from '../agent-core/chatNotice.ts';

test('unset resolves to the documented defaults', () => {
  assert.deepEqual(resolveChatNotice(undefined), { enabled: true, afterHours: 24, limit: 3 });
  assert.deepEqual(resolveChatNotice(null), CHAT_NOTICE_DEFAULTS);
  assert.deepEqual(resolveChatNotice({}), CHAT_NOTICE_DEFAULTS);
});

test('each field falls back on its own', () => {
  // A stored `limit` must not drag `afterHours` along with it — settings rows are
  // written one leaf at a time, so a partial object is the normal case, not an edge.
  assert.equal(resolveChatNotice({ limit: 5 }).afterHours, 24);
  assert.equal(resolveChatNotice({ afterHours: 6 }).limit, 3);
  assert.equal(resolveChatNotice({ enabled: false }).afterHours, 24);
});

test('off is a stored false, not a missing field', () => {
  assert.equal(resolveChatNotice({ enabled: false }).enabled, false);
  assert.equal(resolveChatNotice({ enabled: undefined }).enabled, true);
});

test('zero hours is legal and is not the same as off', () => {
  // Every resumed chat gets a notice. Distinct from `enabled: false`, and the
  // reason the floor is 0 rather than 1.
  const n = resolveChatNotice({ afterHours: 0 });
  assert.equal(n.afterHours, 0);
  assert.equal(n.enabled, true);
});

test('out-of-range numbers are clamped, not rejected', () => {
  assert.equal(resolveChatNotice({ limit: 0 }).limit, 1);
  assert.equal(resolveChatNotice({ limit: 99 }).limit, 10);   // the /chats "Recent" cap
  assert.equal(resolveChatNotice({ afterHours: -5 }).afterHours, 0);
  assert.equal(resolveChatNotice({ afterHours: 1e9 }).afterHours, 24 * 365);
});

test('fractions round rather than making a fractional list', () => {
  assert.equal(resolveChatNotice({ limit: 2.6 }).limit, 3);
  assert.equal(resolveChatNotice({ afterHours: 11.4 }).afterHours, 11);
});

test('non-numbers fall back instead of being coerced', () => {
  // '24' compared against a millisecond difference is the failure this prevents:
  // it would not throw, it would just quietly never fire.
  for (const bad of ['24', null, {}, [], NaN, Infinity]) {
    assert.equal(resolveChatNotice({ afterHours: bad }).afterHours, 24, `afterHours: ${String(bad)}`);
    assert.equal(resolveChatNotice({ limit: bad }).limit, 3, `limit: ${String(bad)}`);
  }
});
