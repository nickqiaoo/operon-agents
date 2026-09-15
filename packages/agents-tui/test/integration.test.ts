/**
 * The seam this client sits on: every Harness API it calls has to exist, on a real session, with
 * the shape it assumes. A rename in the engine should break this test, not the first launch.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLocalHarness, defineModel, type Harness, type HarnessSession } from 'operon-agents';

import { buildExtensionSlashCommands } from '../src/commands/extension-commands.ts';
import { buildSkillSlashCommands } from '../src/commands/skills.ts';
import { limitReplayRecordsByTurn } from '../src/utils/message-replay.ts';

async function withSession(run: (harness: Harness, session: HarnessSession, workDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'operon-tui-home-'));
  const workDir = await mkdtemp(join(tmpdir(), 'operon-tui-work-'));
  // The model is never called: this test only exercises the control surface.
  const harness = await createLocalHarness({
    model: defineModel({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'not-used' }),
    homeDir,
    workDir,
  });
  try {
    const session = await harness.createSession({ workDir });
    await run(harness, session, workDir);
  } finally {
    await harness.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

test('the session exposes the machine its tools run on', async () => {
  await withSession(async (_harness, session, workDir) => {
    const machine = session.machine;
    const result = await machine.run([machine.osEnv.shellPath, '-c', 'echo hello-from-the-session'], { cwd: workDir });
    assert.equal(result.stdout.trim(), 'hello-from-the-session');
    assert.equal(result.exitCode, 0);
  });
});

test('listCommands feeds the palette, and a builtin of the same name wins', async () => {
  await withSession(async (_harness, session) => {
    const commands = session.listCommands();
    assert.ok(commands.length > 0, 'a session should answer to at least one command');
    for (const command of commands) {
      assert.equal(typeof command.name, 'string');
      assert.ok(Array.isArray(command.aliases));
      assert.equal(typeof command.description, 'string');
    }
    // `/compact` exists on both sides; the TUI's own must win, so it is filtered out here.
    const built = buildExtensionSlashCommands(commands, new Set(['compact']));
    assert.ok(!built.commandNames.has('compact'));
    assert.ok(built.commands.length < commands.length || !commands.some((c) => c.name === 'compact'));
  });
});

test('runCommand answers with an ok flag and a message the transcript can show', async () => {
  await withSession(async (_harness, session) => {
    const unknown = await session.runCommand('/definitely-not-a-command');
    assert.equal(unknown.ok, false);
    assert.match(unknown.message, /Unknown command/);
  });
});

test('getTodos starts empty and stays a list', async () => {
  await withSession(async (_harness, session) => {
    assert.deepEqual(session.getTodos(), []);
  });
});

test('renameSession sets the title the picker and the terminal tab read', async () => {
  await withSession(async (harness, session) => {
    await harness.renameSession(session.id, 'Ported the TUI');
    assert.equal((await harness.getSessionSummary(session.id))?.title, 'Ported the TUI');
    // An empty title clears it rather than storing a blank one.
    await harness.renameSession(session.id, '');
    assert.equal((await harness.getSessionSummary(session.id))?.title, undefined);
  });
});

test('the journal is readable per address and replayable through the turn window', async () => {
  await withSession(async (_harness, session) => {
    const records = await session.getRecords('main');
    assert.ok(Array.isArray(records));
    // A fresh session has only its protocol-version record, and no turn to trim to.
    assert.deepEqual(limitReplayRecordsByTurn(records, 10), records);
  });
});

test('skills list, and the activatable ones become slash commands', async () => {
  await withSession(async (_harness, session) => {
    const skills = await session.listSkills();
    const built = buildSkillSlashCommands(skills);
    assert.equal(built.commands.length, built.commandMap.size);
    for (const command of built.commands) {
      const skillName = built.commandMap.get(command.name);
      assert.ok(skillName !== undefined, `${command.name} should map to a skill`);
      assert.ok(skills.some((skill) => skill.name === skillName));
    }
  });
});

test('the session reports the control state the footer renders', async () => {
  await withSession(async (_harness, session) => {
    assert.equal(session.status.state, 'idle');
    await session.setPermissionMode('workspace');
    session.setThinking('high');
    assert.equal(session.permissionMode, 'workspace');
    assert.equal(session.thinkingSetting, 'high');
    const plan = await session.setPlanMode(true);
    assert.ok(plan !== null, 'entering plan mode should produce a plan');
    await session.clearPlan();
    assert.equal(await session.getPlan(), null);
  });
});

test('a durable interruption list exists and is empty on a fresh session', async () => {
  await withSession(async (_harness, session) => {
    assert.deepEqual(await session.pendingInterruptions(), []);
  });
});

test('background tasks, MCP servers and plugins are all listable views', async () => {
  await withSession(async (_harness, session) => {
    assert.deepEqual(await session.listBackgroundTasks({ activeOnly: false }), []);
    assert.deepEqual(session.listMcpServers(), []);
    // Plugins are a capability a host opts into; the local preset leaves them off, and asking a
    // session without them is a registry error the TUI turns into a plain sentence.
    await assert.rejects(() => session.listPlugins(), /plugins/);
  });
});

test('a goal is created, paused, resumed and cancelled through the snapshots the footer shows', async () => {
  await withSession(async (_harness, session) => {
    assert.equal(await session.getGoal(), null);
    const created = await session.createGoal({ objective: 'ship the port' });
    assert.equal(created.objective, 'ship the port');
    assert.equal(created.status, 'active');
    assert.equal((await session.pauseGoal({ reason: 'by hand' }))?.status, 'paused');
    assert.equal((await session.resumeGoal())?.status, 'active');
    assert.equal((await session.cancelGoal())?.objective, 'ship the port');
    assert.equal(await session.getGoal(), null);
  });
});

test('a fork copies the session and can be opened on its own', async () => {
  await withSession(async (harness, session) => {
    const forked = await harness.forkSession(session.id, { title: 'A copy' });
    assert.notEqual(forked.id, session.id);
    assert.equal((await harness.getSessionSummary(forked.id))?.title, 'A copy');
    await harness.closeSession(forked.id);
  });
});

test('sessions list by workspace, which is what the picker filters on', async () => {
  await withSession(async (harness, session, workDir) => {
    const listed = await harness.listSessions({ workDir });
    assert.ok(listed.some((summary) => summary.id === session.id));
    assert.deepEqual(await harness.listSessions({ workDir: join(workDir, 'elsewhere') }), []);
  });
});

test('a provider failure reaches the stream as an assistant error the client must surface', async () => {
  await withSession(async (_harness, session) => {
    const errors: string[] = [];
    let failedTurns = 0;
    session.onEvent((event) => {
      if (event.type === 'error') errors.push(event.message);
      if (event.type === 'message.appended' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
        errors.push(event.message.errorMessage ?? '(no message)');
      }
      if (event.type === 'turn.ended' && event.reason === 'failed') failedTurns += 1;
    });
    // A provider this process has no credentials for: the run fails before the model is reached.
    session.setModel(defineModel({ provider: 'openai', model: 'gpt-5' }));
    const result = await session.prompt('say hi');

    assert.equal(result.status, 'error');
    assert.equal(failedTurns, 1);
    // The reason rides the assistant message, not an `error` event, and not `turn.ended.error`.
    assert.ok(
      errors.some((message) => /not configured/i.test(message)),
      `expected a provider-configuration message, saw ${JSON.stringify(errors)}`,
    );
  });
});
