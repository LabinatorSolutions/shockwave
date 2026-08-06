// What a companion URL is allowed to be (src/main/api/urlPolicy.ts).
//
// The sibling of certPolicy.test.js, guarding the case that policy can't reach:
// over https, the certificate check decides who we're talking to; over plain http
// there is no certificate at all, so the bearer API key — and everything
// GET /settings hands back with it, provider keys, the GitHub PAT, OAuth refresh
// tokens — crosses the wire readable by anything on the path. No fingerprint
// approved later can undo that.
//
// Loopback is the exemption because the bytes never reach a network, and the set
// is the web platform's own — W3C secure-contexts' "potentially trustworthy
// origin", the same list that lets a browser treat `http://localhost` as secure.
// It is a definition of loopback, not a heuristic about what looks local:
// `192.168.x.x` is a real hop over real hardware, and a LAN is precisely where
// somebody else is listening.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companionUrlProblem, isCompanionUrlAllowed } from '../src/main/api/urlPolicy.ts';

test('https is fine anywhere — domain, bare IP, port, path', () => {
  for (const url of [
    'https://companion.example.com',
    'https://203.0.113.10',
    'https://203.0.113.10:8443',
    'https://companion.example.com/api/',
  ]) {
    assert.equal(companionUrlProblem(url), null, url);
    assert.equal(isCompanionUrlAllowed(url), true, url);
  }
});

test('http reaches loopback, in every spelling a person actually types', () => {
  for (const url of [
    'http://localhost',
    'http://localhost:3000',
    'http://LOCALHOST:3000',        // the parser lowercases
    'http://localhost./',           // fully-qualified: one trailing dot, same name
    'http://api.localhost:8080',    // RFC 6761 reserves everything under it too
    'http://127.0.0.1:8080',
    'http://127.0.0.2',             // the whole 127/8 block is loopback
    'http://127.255.255.254',
    'http://[::1]:3000',            // IPv6 loopback
    'http://[0:0:0:0:0:0:0:1]',     // ...which the parser compresses to [::1]
    'http://0.0.0.0:8080',          // what people type off "listening on 0.0.0.0"
  ]) {
    assert.equal(companionUrlProblem(url), null, url);
    assert.equal(isCompanionUrlAllowed(url), true, url);
  }
});

test('obfuscated spellings of 127.0.0.1 are exempt because they ARE 127.0.0.1', () => {
  // Not a hole: the URL parser normalizes every integer form to a dotted quad
  // before the check sees it, so these are the same address, not a way past it.
  // Worth pinning because the instinct on seeing `0x7f000001` in a test is to
  // add a rule blocking it — which would block a legitimate loopback URL.
  for (const url of ['http://0x7f000001', 'http://2130706433', 'http://127.1']) {
    assert.equal(isCompanionUrlAllowed(url), true, url);
  }
});

test('http to a remote host is refused — this is the whole point of the file', () => {
  for (const url of [
    'http://203.0.113.10',
    'http://companion.example.com',
    'http://companion.example.com:8080/api',
  ]) {
    assert.match(companionUrlProblem(url) ?? '', /https:\/\//, url);
    assert.equal(isCompanionUrlAllowed(url), false, url);
  }
});

test('"local" stops at loopback — a LAN is a network', () => {
  // The tempting extra exemption, and the wrong one: a private range is a real
  // hop over real hardware, and it is exactly where someone else is in a
  // position to read the key off the wire. It also buys nothing — a companion
  // on a home server gets a self-signed certificate the app pins, which is a
  // working https deployment rather than a downgrade.
  for (const url of [
    'http://192.168.1.50:8080',
    'http://10.0.0.5',
    'http://172.16.0.9',
    'http://nas.local:8080',        // mDNS: still the LAN
    'http://[2001:db8::1]',         // a routable IPv6 address is not [::1]
  ]) {
    assert.equal(isCompanionUrlAllowed(url), false, url);
  }
});

test('a host that merely CONTAINS a loopback name is not loopback', () => {
  // `localhost.evil.com` resolves to whatever its owner wants. The `.localhost`
  // rule is a SUFFIX (RFC 6761 reserves the whole tree) and the rest are exact,
  // so a name that only starts with one, or embeds one, gets nothing.
  for (const url of [
    'http://localhost.evil.com',
    'http://api.localhost.evil.com',
    'http://notlocalhost',
    'http://mylocalhost:3000',
    'http://127.0.0.1.evil.com',
    'http://1270.0.0.1',
  ]) {
    assert.equal(isCompanionUrlAllowed(url), false, url);
  }
});

test('other schemes are refused, including ones that would never reach a server', () => {
  for (const url of ['ftp://companion.example.com', 'file:///etc/passwd', 'ws://localhost:3000']) {
    assert.equal(isCompanionUrlAllowed(url), false, url);
    assert.notEqual(companionUrlProblem(url), null, url);
  }
});

test('junk is reported as junk rather than throwing', () => {
  assert.match(companionUrlProblem('not a url') ?? '', /valid URL/);
  assert.match(companionUrlProblem('203.0.113.10') ?? '', /valid URL/); // no scheme
  assert.equal(isCompanionUrlAllowed('not a url'), false);
});

test('empty is not a PROBLEM to report, but is not something to send to either', () => {
  // Two different questions, and they answer differently on purpose. Clearing
  // the URL box must not raise "that URL is unsafe" — there is no URL. But the
  // transport fails closed: nothing may be sent to an empty address, and
  // client.ts already reports an unconfigured connection in its own words.
  assert.equal(companionUrlProblem(''), null);
  assert.equal(companionUrlProblem('   '), null);
  assert.equal(isCompanionUrlAllowed(''), false);
  assert.equal(isCompanionUrlAllowed('   '), false);
});

test('a non-string never reaches the URL parser', () => {
  for (const junk of [null, undefined, 42, {}]) {
    assert.equal(companionUrlProblem(junk), null);
    assert.equal(isCompanionUrlAllowed(junk), false);
  }
});

test('the refusal message names the fix, not the rule', () => {
  // It is shown to the user verbatim in Settings → Companion. "Invalid URL"
  // would leave someone retyping a perfectly correct address.
  const msg = companionUrlProblem('http://203.0.113.10') ?? '';
  assert.match(msg, /clear/);
  assert.match(msg, /localhost or 127\.0\.0\.1/);
});
