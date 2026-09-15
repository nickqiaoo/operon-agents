import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSlashInput } from '../src/commands/parse.ts';
import { BUILTIN_SLASH_COMMANDS, findBuiltInSlashCommand, resolveSlashCommandAvailability, sortSlashCommands } from '../src/commands/registry.ts';
import { resolveSlashCommandInput, slashBusyMessage, slashCommandBusyReason } from '../src/commands/resolve.ts';
import { buildSkillSlashCommands } from '../src/commands/skills.ts';
import { buildExtensionSlashCommands } from '../src/commands/extension-commands.ts';

const NO_SKILLS = new Map<string, string>();
const NO_SESSION_COMMANDS = new Set<string>();

function resolve(input: string, overrides: Partial<Parameters<typeof resolveSlashCommandInput>[0]> = {}) {
  return resolveSlashCommandInput({
    input,
    skillCommandMap: NO_SKILLS,
    sessionCommandNames: NO_SESSION_COMMANDS,
    isStreaming: false,
    isCompacting: false,
    ...overrides,
  });
}

test('parseSlashInput keeps multiline arguments and rejects plain text', () => {
  assert.deepEqual(parseSlashInput('/compact first\nsecond'), { name: 'compact', args: 'first\nsecond' });
  assert.equal(parseSlashInput('hello'), null);
});

test('a builtin wins over a same-named skill or session command', () => {
  const intent = resolve('/model anthropic/claude-opus-4-8', {
    skillCommandMap: new Map([['model', 'model']]),
    sessionCommandNames: new Set(['model']),
  });
  assert.equal(intent.kind, 'builtin');
  assert.equal(intent.kind === 'builtin' ? intent.name : '', 'model');
});

test('a skill resolves by bare name and by the skill: prefix', () => {
  const map = new Map([['skill:review', 'review']]);
  for (const input of ['/review please', '/skill:review please']) {
    const intent = resolve(input, { skillCommandMap: map });
    assert.equal(intent.kind, 'skill', input);
    assert.equal(intent.kind === 'skill' ? intent.skillName : '', 'review');
    assert.equal(intent.kind === 'skill' ? intent.args : '', 'please');
  }
});

test('an engine command resolves to session-command, and an unknown slash stays a message', () => {
  assert.equal(resolve('/cron list', { sessionCommandNames: new Set(['cron']) }).kind, 'session-command');
  assert.equal(resolve('/nonsense').kind, 'message');
});

test('idle-only builtins are blocked while streaming; always-available ones are not', () => {
  const blocked = resolve('/new', { isStreaming: true });
  assert.equal(blocked.kind, 'blocked');
  assert.equal(resolve('/model', { isStreaming: true }).kind, 'builtin');
  // A skill is never blocked: it queues behind the running turn like plain input.
  assert.equal(resolve('/review', { isStreaming: true, skillCommandMap: new Map([['review', 'review']]) }).kind, 'skill');
});

test('/goal availability depends on its subcommand', () => {
  const goal = findBuiltInSlashCommand('goal');
  assert.ok(goal !== undefined);
  assert.equal(resolveSlashCommandAvailability(goal, 'status'), 'always');
  assert.equal(resolveSlashCommandAvailability(goal, 'ship the refactor'), 'idle-only');
});

test('aliases resolve to their command', () => {
  assert.equal(findBuiltInSlashCommand('clear')?.name, 'new');
  assert.equal(findBuiltInSlashCommand('effort')?.name, 'thinking');
  assert.equal(findBuiltInSlashCommand('q')?.name, 'exit');
});

test('busy messages name the blocking condition', () => {
  assert.equal(slashCommandBusyReason({ isStreaming: true, isCompacting: false }), 'streaming');
  assert.equal(slashCommandBusyReason({ isStreaming: false, isCompacting: true }), 'compacting');
  assert.match(slashBusyMessage('new', 'streaming'), /streaming/);
});

test('the builtin table sorts by priority and has unique names', () => {
  const sorted = sortSlashCommands(BUILTIN_SLASH_COMMANDS);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    const byPriority = (previous.priority ?? 0) - (current.priority ?? 0);
    assert.ok(
      byPriority > 0 || (byPriority === 0 && previous.name < current.name),
      `${previous.name} should not precede ${current.name}`,
    );
  }
  const names = new Set<string>();
  for (const command of BUILTIN_SLASH_COMMANDS) {
    for (const name of [command.name, ...command.aliases]) {
      assert.ok(!names.has(name), `duplicate command name ${name}`);
      names.add(name);
    }
  }
});

test('builtin skills answer to a bare name; project skills take the skill: prefix', () => {
  const built = buildSkillSlashCommands([
    { name: 'commit', description: 'Commit', path: '/b/commit', source: 'builtin' },
    { name: 'review', description: 'Review', path: '/p/review', source: 'project' },
    { name: 'hidden', description: 'Not activatable', path: '/p/hidden', source: 'project', type: 'reference' },
  ]);
  assert.deepEqual(
    built.commands.map((command) => command.name),
    ['commit', 'skill:review'],
  );
  assert.equal(built.commandMap.get('skill:review'), 'review');
});

test('session commands that collide with a builtin are dropped from the palette', () => {
  const built = buildExtensionSlashCommands(
    [
      { name: 'cron', aliases: ['crontab'], description: 'Manage cron jobs' },
      { name: 'compact', aliases: [], description: 'The engine has one too' },
    ],
    new Set(['compact']),
  );
  assert.deepEqual(
    built.commands.map((command) => command.name),
    ['cron'],
  );
  assert.ok(built.commandNames.has('crontab'));
  assert.ok(!built.commandNames.has('compact'));
});
