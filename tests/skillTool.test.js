// The review run's tool set (agent-core/defaults/tools.ts) and the two tools it
// gets built (agent-core/skillTool.ts).
//
// Why this is tested:
//
//   * The review list is EXPLICIT, not the catalog minus exclusions. That
//     direction is the whole safety property — a tool added next month must not
//     arrive in the one run nobody watches. The test names the five, so widening
//     the set has to be a deliberate edit here as well.
//   * `write`, `edit` and `bash` being absent is what makes the guards in
//     manageSkill real rather than decorative: with any of them the agent could
//     edit a SKILL.md directly and skip every check.
//   * The `read` override is what records a read for the read-before-write gate.
//     pi has no skill-loading tool of ours to hang that on — skills are loaded
//     with the plain `read` builtin — so the override IS the mechanism. If it
//     stops delegating or stops recording, the gate silently passes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { toolsForSource, activeToolNames, TOOL_CATALOG } from '../agent-core/defaults/tools.ts';
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

// ── The review tool set ──────────────────────────────────────────────────────

test('a review run gets exactly five tools', () => {
  assert.deepEqual(
    activeToolNames('review').sort(),
    ['find', 'grep', 'ls', 'manage_skill', 'read'],
  );
});

test('the tools that would bypass the guards are absent from a review run', () => {
  const names = activeToolNames('review');
  for (const banned of ['write', 'edit', 'bash', 'send_message', 'get_agent_secret', 'daily_note', 'search_chats']) {
    assert.ok(!names.includes(banned), `${banned} must not be offered to a review run`);
  }
});

test('the review list is explicit, so a NEW catalog tool is excluded by default', () => {
  // Simulates the `daily_note` case: a tool added with no `only` reaches every
  // other source. If this ever fails, someone switched the review scope to an
  // exclusion list and the default flipped from deny to allow.
  const everywhere = TOOL_CATALOG.filter((t) => !t.only).map((t) => t.name);
  const review = activeToolNames('review');
  const reachedReviewWithoutBeingListed = everywhere.filter(
    (n) => review.includes(n) && !['read', 'grep', 'find', 'ls', 'manage_skill'].includes(n),
  );
  assert.deepEqual(reachedReviewWithoutBeingListed, []);
});

test('manage_skill is offered to every source, as in hermes', () => {
  for (const source of ['desktop', 'cron', 'telegram', 'review']) {
    assert.ok(activeToolNames(source).includes('manage_skill'), `missing on ${source}`);
  }
});

test('the other sources are unchanged by the review scope', () => {
  for (const source of ['desktop', 'cron', 'telegram']) {
    const names = activeToolNames(source);
    assert.ok(names.includes('bash') && names.includes('write'), `${source} still has its normal tools`);
  }
  assert.ok(toolsForSource('desktop').some((t) => t.name === 'open_file'), 'desktop keeps open_file');
  assert.ok(!toolsForSource('cron').some((t) => t.name === 'open_file'), 'cron still has no UI');
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
