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
  // into a file, or said into a chat nobody is reading. Worst on an unattended
  // run, where the reply has no reader at all — which is why that consequence is
  // pinned too, not just the phrase list.
  const d = sendMessage.description;
  for (const phrase of ['"Send me"', '"notify me"', '"let me know"', '"ping me"', '"remind me"', '"tell me when"']) {
    assert.ok(d.includes(phrase), `send_message no longer maps ${phrase}`);
  }
  assert.ok(d.includes('ALL MEAN THIS TOOL'));
  assert.ok(d.includes('a message that is not sent is a message that did not happen'));
});

test('send_message still says the delivery mode is not the agent\'s to choose', () => {
  // Separate from the triggers and separately load-bearing: the tool had an
  // `output` argument once, the agent passed `both` where the setting said
  // `text`, and the user got a voice note they had switched off.
  const d = sendMessage.description;
  assert.ok(d.includes('THEIR setting'));
  // And it must not claim a SCOPE the setting doesn't have. It said "for this
  // workspace" while the mode really was per-workspace, and that scope was the
  // bug — see agent-core/voiceReply.ts.
  assert.ok(!/for this workspace/.test(d), 'the reply mode is app-level, not per workspace');
  assert.ok(d.includes('/voice text'));
  assert.ok(!/\boutput\b/.test(d), 'the removed `output` argument is being described again');
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
  // The generalisation, cheap to state and the thing actually worth holding: a
  // description that only documents arguments is a description the model reads
  // after it has already decided not to call the tool.
  for (const [name, tool] of [['send_message', sendMessage], ['search_chats', searchChats]]) {
    const d = tool.description;
    assert.ok(d.length > 400, `${name}'s description is short enough that the "when" was probably cut`);
  }
});
