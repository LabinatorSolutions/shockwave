// What each run may USE (agent-core/defaults/tools.ts) and the two tools a review
// run gets built (agent-core/skillTool.ts).
//
// Every run is now OFFERED the whole catalog and refused per call, so the thing
// worth pinning moved: it is no longer "which tools are in the list" but "which
// calls get through". The properties are the same ones as before.
//
//   * A review run must effectively hold five tools and no more. The table is a
//     DENY list now, which means a tool added next month reaches the one run
//     nobody watches unless someone names it — the exact hazard `daily_note`
//     demonstrated. So the test asserts the ALLOWED set by subtraction: add a
//     tool to the catalog without deciding about it here, and this fails.
//   * `write`, `edit` and `bash` being refused is what makes the guards in
//     manageSkill real rather than decorative: with any of them the agent could
//     edit a SKILL.md directly and skip every check.
//   * Every denial must carry a REASON. Without one pi sends its own generic
//     "Tool execution was blocked", which tells the agent nothing about what it
//     can do instead — and being able to say that is the whole reason for
//     refusing a call rather than hiding the tool.
//   * The `read` override is what records a read for the read-before-write gate.
//     pi has no skill-loading tool of ours to hang that on — skills are loaded
//     with the plain `read` builtin — so the override IS the mechanism. If it
//     stops delegating or stops recording, the gate silently passes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { DENIED, activeToolNames, deniedReason, TOOL_CATALOG, TOOL_SCOPES } from '../agent-core/defaults/tools.ts';

/** What a run from `source` can actually get through the gate. */
const usable = (source) =>
  activeToolNames().filter((n) => !deniedReason(n, source));
import { makeSkillTools } from '../agent-core/skillTool.ts';

const SKILL = (name, body) =>
  `---\nname: ${name}\ndescription: Use when testing ${name}. A probe skill.\n---\n\n# ${name}\n\n${body}\n`;

async function makeWorkspace() {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skilltool-')));
  const agentDir = path.join(cwd, '.agents', 'skills');
  const uploaded = path.join(cwd, '.shockwave', 'skills');
  await fs.mkdir(path.join(agentDir, 'pdf-tools'), { recursive: true });
  await fs.mkdir(uploaded, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'pdf-tools', 'SKILL.md'), SKILL('pdf-tools', 'Step one.'));
  return { cwd, agentDir, roots: { agentDir, protectedDirs: [uploaded] } };
}

// ── What each run may use ────────────────────────────────────────────────────

test('a review run can use exactly five tools', () => {
  assert.deepEqual(usable('review').sort(), ['find', 'grep', 'ls', 'manage_skill', 'read']);
});

test('a memory run can use exactly one tool', () => {
  assert.deepEqual(usable('memory'), ['memory']);
});

test('the tools that would bypass the guards are refused on a review run', () => {
  for (const banned of ['write', 'edit', 'bash', 'send_message', 'get_agent_secret', 'daily_note', 'search_chats']) {
    assert.ok(deniedReason(banned, 'review'), `${banned} must be refused on a review run`);
  }
});

test('a NEW catalog tool cannot reach a background run unnoticed', () => {
  // The table is a deny list, so an unlisted tool is allowed everywhere. This is
  // the tripwire for that: the two background runs have a fixed intended set, so
  // adding anything to the catalog without deciding about it here fails loudly
  // rather than silently widening the runs nobody is watching.
  assert.deepEqual(usable('review').sort(), ['find', 'grep', 'ls', 'manage_skill', 'read'],
    'a catalog tool was added without deciding whether a review run may use it');
  assert.deepEqual(usable('memory'), ['memory'],
    'a catalog tool was added without deciding whether a memory run may use it');
});

test('every refusal names the tool and explains the run', () => {
  // pi falls back to a generic "Tool execution was blocked" when `reason` is
  // empty, which tells the agent nothing it can act on.
  for (const [source, entry] of Object.entries(DENIED)) {
    assert.ok(entry.reason && entry.reason.length > 20, `${source} needs a real reason`);
    for (const tool of entry.tools) {
      const msg = deniedReason(tool, source);
      assert.ok(msg.includes(tool), `${source}/${tool}: the message should name the tool`);
      assert.ok(msg.includes(entry.reason), `${source}/${tool}: the message should explain the run`);
    }
  }
});

test('every tool named in the deny table actually exists', () => {
  const names = new Set(TOOL_CATALOG.map((t) => t.name));
  for (const [source, entry] of Object.entries(DENIED)) {
    for (const tool of entry.tools) {
      assert.ok(names.has(tool), `${source} denies "${tool}", which is not in the catalog`);
    }
  }
});

test('manage_skill can be used from every source but the memory run', () => {
  for (const source of ['desktop', 'cron', 'telegram', 'review']) {
    assert.ok(usable(source).includes('manage_skill'), `missing on ${source}`);
  }
});

test('an ordinary run is unrestricted apart from the app-window tool', () => {
  assert.deepEqual(usable('desktop'), activeToolNames(), 'a desktop chat is denied nothing');
  for (const source of ['cron', 'telegram']) {
    const names = usable(source);
    assert.ok(names.includes('bash') && names.includes('write'), `${source} keeps its normal tools`);
    assert.ok(!names.includes('open_file'), `${source} has no app window`);
  }
});

test('every tool is OFFERED to every run — refusal happens at call time', () => {
  // This is what lets the system prompt be written once and read back verbatim:
  // the offered list cannot vary by source, so a chat started on one side stays
  // true when continued on another.
  for (const source of TOOL_SCOPES) {
    assert.deepEqual(activeToolNames(), TOOL_CATALOG.map((t) => t.name), `offered set varied on ${source}`);
  }
});

// ── What the factory builds ──────────────────────────────────────────────────

test('an ordinary run gets manage_skill alone — no read override', async () => {
  const ws = await makeWorkspace();
  const tools = makeSkillTools({ cwd: ws.cwd, roots: ws.roots });
  assert.deepEqual(tools.map((t) => t.name), ['manage_skill']);
});

test('a review run also gets a read tool, and it is pi\'s own definition', async () => {
  const ws = await makeWorkspace();
  const tools = makeSkillTools({ cwd: ws.cwd, roots: ws.roots, trackReads: true });
  assert.deepEqual(tools.map((t) => t.name).sort(), ['manage_skill', 'read']);
  const read = tools.find((t) => t.name === 'read');
  // Same schema and description as pi's builtin — this is that tool with one
  // line added, not a reimplementation.
  assert.ok(read.parameters, 'carries pi\'s parameter schema');
  assert.match(read.description, /Read the contents of a file/);
});

// ── The override actually delegates and records ──────────────────────────────

test('the read override returns real file contents', async () => {
  const ws = await makeWorkspace();
  const [read] = makeSkillTools({ cwd: ws.cwd, roots: ws.roots, trackReads: true });
  const res = await read.execute('t1', { path: '.agents/skills/pdf-tools/SKILL.md' }, undefined, undefined, {});
  const text = (res?.content ?? []).map((c) => c.text ?? '').join('');
  assert.match(text, /Step one\./, 'delegation to pi\'s read works');
});

test('reading a skill is what lets manage_skill patch it', async () => {
  const ws = await makeWorkspace();
  const tools = makeSkillTools({ cwd: ws.cwd, roots: ws.roots, trackReads: true });
  const read = tools.find((t) => t.name === 'read');
  const manage = tools.find((t) => t.name === 'manage_skill');

  // Before reading: refused.
  const blocked = await manage.execute('t1', {
    action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Step two.',
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /have not read SKILL\.md in this run/);

  // Read it, then the same patch lands.
  await read.execute('t2', { path: '.agents/skills/pdf-tools/SKILL.md' }, undefined, undefined, {});
  const okRes = await manage.execute('t3', {
    action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Step two.',
  });
  assert.ok(!okRes.isError, okRes.content?.[0]?.text);
  assert.match(
    await fs.readFile(path.join(ws.agentDir, 'pdf-tools', 'SKILL.md'), 'utf8'),
    /Step two\./,
  );
});

test('an absolute read path counts the same as a relative one', async () => {
  const ws = await makeWorkspace();
  const tools = makeSkillTools({ cwd: ws.cwd, roots: ws.roots, trackReads: true });
  const read = tools.find((t) => t.name === 'read');
  const manage = tools.find((t) => t.name === 'manage_skill');

  await read.execute('t1', { path: path.join(ws.agentDir, 'pdf-tools', 'SKILL.md') }, undefined, undefined, {});
  const res = await manage.execute('t2', {
    action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Step two.',
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
});

test('a failed read records nothing', async () => {
  const ws = await makeWorkspace();
  const tools = makeSkillTools({ cwd: ws.cwd, roots: ws.roots, trackReads: true });
  const read = tools.find((t) => t.name === 'read');
  const manage = tools.find((t) => t.name === 'manage_skill');

  // pi throws on a missing file rather than returning an error result — the
  // wrapper must let that through untouched and record nothing.
  await assert.rejects(
    () => read.execute('t1', { path: '.agents/skills/pdf-tools/nope.md' }, undefined, undefined, {}),
  );
  const res = await manage.execute('t2', {
    action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Step two.',
  });
  assert.equal(res.isError, true, 'the failed read must not satisfy the gate');
});

test('two runs do not share what each other has read', async () => {
  const ws = await makeWorkspace();
  const runA = makeSkillTools({ cwd: ws.cwd, roots: ws.roots, trackReads: true });
  const runB = makeSkillTools({ cwd: ws.cwd, roots: ws.roots, trackReads: true });

  await runA.find((t) => t.name === 'read')
    .execute('a1', { path: '.agents/skills/pdf-tools/SKILL.md' }, undefined, undefined, {});

  const res = await runB.find((t) => t.name === 'manage_skill').execute('b1', {
    action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Step two.',
  });
  assert.equal(res.isError, true, "run B never read it — the set is per-session, not module-level");
});

test('manage_skill reports a refusal as a tool error, not a silent success', async () => {
  const ws = await makeWorkspace();
  const [manage] = makeSkillTools({ cwd: ws.cwd, roots: ws.roots });
  const res = await manage.execute('t1', { action: 'create', name: 'BAD NAME', content: SKILL('x', 'y') });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Invalid skill name/);
});
