// The waiting bubble (`api/src/telegram/waitingBubble.ts`) — the "..." message a
// turn posts before it has anything to show, and the same one a 🤬 reaction posts
// while the audio is being made.
//
// What is worth pinning here is EXCLUSIVE OWNERSHIP, because that is the whole
// reason this is a separate piece rather than the animation it grew out of. The
// bubble writes to its message until somebody takes it; after that it must never
// write again. Get that wrong and a dot lands on top of the first words of a
// reply — visible, intermittent, and impossible to reproduce on demand.
//
// The client is injected, so none of this touches the network.

import { test } from 'node:test';
import assert from 'node:assert';
import { startWaitingBubble } from '../api/src/telegram/waitingBubble.ts';

/** A stand-in for TelegramClient that records what it was asked to do. */
function fakeClient({ failPost = false } = {}) {
  const calls = [];
  let nextId = 100;
  return {
    calls,
    edits: () => calls.filter((c) => c.method === 'editMessageText'),
    async sendMessage(chatId, text, opts = {}) {
      calls.push({ method: 'sendMessage', chatId, text, opts });
      if (failPost) throw new Error('telegram sendMessage failed: nope');
      return { message_id: nextId++ };
    },
    async editMessageText(chatId, messageId, text) {
      calls.push({ method: 'editMessageText', chatId, messageId, text });
    },
    async deleteMessage(chatId, messageId) {
      calls.push({ method: 'deleteMessage', chatId, messageId });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('posts a bubble immediately and hands the message id to the first claimer', async () => {
  const client = fakeClient();
  const bubble = startWaitingBubble(client, 42);
  const id = await bubble.claim();
  assert.equal(id, 100);
  assert.equal(client.calls[0].method, 'sendMessage');
  assert.equal(client.calls[0].chatId, 42);
  assert.match(client.calls[0].text, /^\.\.\.$/);
});

test('only one owner: a second claim gets nothing', async () => {
  const client = fakeClient();
  const bubble = startWaitingBubble(client, 42);
  assert.equal(await bubble.claim(), 100);
  assert.equal(await bubble.claim(), null);
});

test('the bubble never writes again once claimed', async () => {
  const client = fakeClient();
  const bubble = startWaitingBubble(client, 42);
  const id = await bubble.claim();
  const after = client.calls.length;
  // Well past several frames. If the animation outlived the handover it would
  // overwrite whatever the new owner has written into this message.
  await sleep(1400);
  assert.equal(client.calls.length, after, 'bubble wrote after being claimed');
  assert.equal(id, 100);
});

test('it grows a dot at a time while nobody has taken it', async () => {
  const client = fakeClient();
  const bubble = startWaitingBubble(client, 42);
  await sleep(1400);
  bubble.stop();
  const bodies = client.edits().map((c) => c.text);
  assert.ok(bodies.length >= 2, `expected the dots to grow, saw ${bodies.length} edits`);
  assert.deepEqual(bodies.slice(0, 2), ['....', '.....']);
  assert.ok(client.edits().every((c) => c.messageId === 100));
});

test('remove deletes the message, and nothing can claim it afterwards', async () => {
  const client = fakeClient();
  const bubble = startWaitingBubble(client, 42);
  await bubble.remove();
  const del = client.calls.find((c) => c.method === 'deleteMessage');
  assert.ok(del, 'the bubble was not deleted');
  assert.equal(del.messageId, 100);
  assert.equal(await bubble.claim(), null);
});

test('remove is a no-op once the message has been claimed', async () => {
  const client = fakeClient();
  const bubble = startWaitingBubble(client, 42);
  await bubble.claim();
  await bubble.remove();
  assert.equal(client.calls.filter((c) => c.method === 'deleteMessage').length, 0);
});

test('a bubble that could not be posted is simply absent', async () => {
  const client = fakeClient({ failPost: true });
  const bubble = startWaitingBubble(client, 42);
  // No slot for the caller — it posts its own message instead — and nothing to
  // delete, so `remove` must not try.
  assert.equal(await bubble.claim(), null);
  await bubble.remove();
  assert.equal(client.calls.filter((c) => c.method === 'deleteMessage').length, 0);
});

test('it is a plain message, never a reply', async () => {
  // The bubble stands in for an answer that has not arrived. Anchoring it to
  // something is the answer's job — and this one is deleted or written over.
  const client = fakeClient();
  const bubble = startWaitingBubble(client, 42);
  await bubble.claim();
  assert.deepEqual(client.calls[0].opts, {});
});
