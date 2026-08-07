// Guidance that LEFT the system prompt has to exist in the tool it moved into.
//
// Four sections were folded into tool descriptions rather than deleted:
// `# Reaching the user` → `send_message`, `# Earlier chats` → `search_chats`,
// `# Daily notes` → `daily_note`, `# Creating skills` → `manage_skill`. The rule
// behind all four is that what a single tool is FOR belongs with that tool — the
// model reads it at the call site, and a tool description is rebuilt at every
// session boot where the system prompt is frozen when a chat is created.
//
// The move has a failure mode the prompt version did not: deleting a section is
// one edit and adding it to a description is another, and nothing links them. If
// the second is dropped, or a later tidy-up of a description trims the "when"
// back to a "what", the guidance is gone from BOTH places and nothing fails.
// That is what these pin — not the wording, but that the mapping from what the
// user actually says to the tool that answers it still exists somewhere.
//
// Every assertion is a TRIGGER, not a description: the phrases a user says.
// Those are the part that makes a tool get used at all, and the part a
// well-meaning edit is most likely to cut as chatty.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeSendMessageTool } from '../agent-core/sendMessage.ts';
import { makeChatSearchTool } from '../agent-core/chatSearch.ts';

const sendMessage = makeSendMessageTool(async () => ({ ok: true }));
const searchChats = makeChatSearchTool(
  { searchChats: async () => [], readChat: async () => null, recentChats: async () => [] },
  () => ({ workspaceId: 'w', chatId: 'c' }),
);

test('send_message carries the reach-me trigger phrases', () => {
  // The failure without them: "send me the summary when it's done" gets written
  // into a file, or said into a chat nobody is reading.
  const d = sendMessage.description;
  for (const phrase of ['"Send me"', '"notify me"', '"let me know"', '"ping me"', '"remind me"', '"tell me when"']) {
    assert.ok(d.includes(phrase), `send_message no longer maps ${phrase}`);
  }
  assert.ok(d.includes('CALL THIS'));
});

test('send_message describes nothing the agent cannot act on', () => {
  // This description reached 1,249 chars and was cut to ~190. What went was not
  // wrong, it was INERT — and inert text in a tool description is the kind of
  // bloat that accumulates because every sentence looks defensible on its own.
  //
  // The test is the rule, not the wording: a tool taking ONE string should not
  // describe a setting it cannot read, cannot set, and cannot observe the result
  // of, nor restate what a failed call already returns.
  const d = sendMessage.description;
  assert.ok(!/\/voice|voice note|spoken/.test(d), 'the voice setting is back — the agent has no way to act on it');
  assert.ok(!/isError|treating the task as done/.test(d), 'a failed send already returns the reason');
  assert.ok(!/\boutput\b/.test(d), 'the removed `output` argument is being described again');
  assert.ok(d.length < 400, `description is ${d.length} chars — it grew back`);
});

test('search_chats carries the refer-back trigger phrases', () => {
  // The quietest failure of the set: nothing errors and no wrong file appears,
  // the agent simply does not remember a conversation you both had — which reads
  // as normal behaviour rather than as a bug.
  const d = searchChats.description;
  assert.ok(d.includes('SEARCH FIRST'));
  for (const phrase of ['what did we decide about', 'you said last week', 'did I already ask you to']) {
    assert.ok(d.includes(phrase), `search_chats no longer maps "${phrase}"`);
  }
  assert.ok(d.includes('is the one wrong move'));
});

test('both tools describe WHEN to reach for them, not only HOW to call them', () => {
  // The generalisation worth holding: a description that only documents
  // arguments is one the model reads after it has already decided not to call
  // the tool.
  //
  // This used to assert `length > 400`, which was a mistake worth recording —
  // a LENGTH FLOOR MEASURES THE WRONG THING. It passed while send_message
  // carried 1,249 chars of inert prose about a setting it cannot touch, and it
  // would have failed the cut that removed it. Pin the trigger phrases, which
  // are what actually make a tool get used; a description can be short and
  // complete, and long and useless.
  for (const [name, tool] of [['send_message', sendMessage], ['search_chats', searchChats]]) {
    const d = tool.description;
    assert.ok(/mean CALL THIS|SEARCH FIRST/.test(d), `${name} no longer says when to reach for it`);
  }
});
