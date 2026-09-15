import assert from 'node:assert/strict';
import test from 'node:test';

import type { BackgroundTaskInfo, GoalSnapshot } from 'operon-agents';

import { parseCliArgs, helpText } from '../src/cli.ts';
import { DEFAULT_TUI_CONFIG, normalizeTuiConfig, parseTuiConfig, renderTuiConfig } from '../src/config.ts';
import { goalChangeBetween } from '../src/controllers/session-event-handler.ts';
import { buildFullModelCatalog, buildModelCatalog, modelDisplayName, splitModelId, thinkingLevelsFor } from '../src/utils/model-catalog.ts';
import { isPermissionMode, PERMISSION_MODE_DISPLAY_NAMES } from '../src/utils/permission-mode.ts';
import { isThinkingLevel, thinkingLabel, THINKING_LEVELS } from '../src/utils/thinking.ts';
import { formatBackgroundTaskTranscript, isTerminalBackgroundTask } from '../src/utils/background-task-status.ts';
import { pickDetachableToolCalls } from '../src/utils/foreground-task.ts';
import { combineSteerInput } from '../src/utils/steer-input.ts';
import { sumTokenUsage, type ToolCallBlockData } from '../src/types.ts';

test('the CLI resolves the startup controls it owns', () => {
  const parsed = parseCliArgs(['--model', 'openai/gpt-5', '--permission', 'workspace', '--thinking', 'high', '--plan', '-C', '.'], {});
  assert.equal(parsed.model, 'openai/gpt-5');
  assert.equal(parsed.permission, 'workspace');
  assert.equal(parsed.thinking, 'high');
  assert.equal(parsed.plan, true);
  assert.equal(parsed.continueLast, false);
});

test('--session with no id means "open the picker"; with an id it names one', () => {
  assert.equal(parseCliArgs(['--session'], {}).sessionId, '');
  assert.equal(parseCliArgs(['--session', '--plan'], {}).sessionId, '');
  assert.equal(parseCliArgs(['--session', 's123'], {}).sessionId, 's123');
  assert.equal(parseCliArgs([], {}).sessionId, undefined);
});

test('the CLI rejects an unknown flag and an invalid mode instead of guessing', () => {
  assert.throws(() => parseCliArgs(['--nope'], {}), /Unknown option/);
  assert.throws(() => parseCliArgs(['--permission', 'sometimes'], {}), /Permission mode/);
  assert.throws(() => parseCliArgs(['--thinking', 'hard'], {}), /Thinking level/);
  assert.throws(() => parseCliArgs(['--model'], {}), /Missing value/);
});

test('OPERON_MODEL supplies the model when --model is absent', () => {
  assert.equal(parseCliArgs([], { OPERON_MODEL: 'anthropic/claude-sonnet-5' }).model, 'anthropic/claude-sonnet-5');
  assert.equal(parseCliArgs(['-m', 'openai/gpt-5'], { OPERON_MODEL: 'anthropic/x' }).model, 'openai/gpt-5');
});

test('help text lists every permission mode and thinking level', () => {
  const text = helpText();
  for (const mode of Object.keys(PERMISSION_MODE_DISPLAY_NAMES)) assert.ok(text.includes(mode), mode);
  for (const level of THINKING_LEVELS) assert.ok(text.includes(level), level);
});

test('permission modes and thinking levels are validated against the engine vocabulary', () => {
  assert.equal(isPermissionMode('workspace'), true);
  assert.equal(isPermissionMode('sometimes'), false);
  assert.equal(isThinkingLevel('xhigh'), true);
  assert.equal(isThinkingLevel('off'), false);
  assert.equal(thinkingLabel('medium'), 'Medium');
});

test('tui.toml round-trips, and an unknown status_line slot is dropped with a warning', () => {
  const warnings: string[] = [];
  const config = normalizeTuiConfig(
    {
      theme: 'dark',
      render_latex: false,
      editor: { command: 'nvim' },
      default_model: 'anthropic/claude-opus-4-8',
      status_line: { items: ['model', 'nonsense', 'git'] },
    },
    (message) => warnings.push(message),
  );
  assert.equal(config.theme, 'dark');
  assert.equal(config.renderLatex, false);
  assert.equal(config.editorCommand, 'nvim');
  assert.equal(config.defaultModel, 'anthropic/claude-opus-4-8');
  assert.deepEqual(config.statusLine?.items, ['model', 'git']);
  assert.equal(warnings.length, 1);

  const reparsed = parseTuiConfig(renderTuiConfig(config));
  assert.equal(reparsed.theme, 'dark');
  assert.equal(reparsed.editorCommand, 'nvim');
  assert.equal(reparsed.defaultModel, 'anthropic/claude-opus-4-8');
  assert.deepEqual(reparsed.statusLine?.items, ['model', 'git']);
});

test('an empty tui.toml is the default config, and defaults round-trip', () => {
  assert.deepEqual(parseTuiConfig('   '), DEFAULT_TUI_CONFIG);
  const reparsed = parseTuiConfig(renderTuiConfig(DEFAULT_TUI_CONFIG));
  assert.equal(reparsed.theme, DEFAULT_TUI_CONFIG.theme);
  assert.equal(reparsed.editorCommand, null);
  assert.equal(reparsed.defaultModel, undefined);
});

test('a model id splits into provider and model, and refuses anything else', () => {
  assert.deepEqual(splitModelId('anthropic/claude-opus-4-8'), { provider: 'anthropic', model: 'claude-opus-4-8' });
  assert.deepEqual(splitModelId('openai/gpt-5-mini'), { provider: 'openai', model: 'gpt-5-mini' });
  for (const bad of ['claude', '/leading', 'trailing/', '']) assert.equal(splitModelId(bad), undefined, bad);
});

test('the picker offers configured providers only, never the whole registry', async () => {
  const configured = await buildModelCatalog([]);
  const everything = buildFullModelCatalog([]);
  // The registry knows every model the engine can speak to; the picker must not be that list.
  assert.ok(Object.keys(everything).length > 500, 'the full registry should be large');
  assert.ok(
    Object.keys(configured).length < Object.keys(everything).length,
    'the configured list should be a subset of the registry',
  );
  for (const entry of Object.values(configured)) {
    assert.ok(everything[entry.id] !== undefined, `${entry.id} should also exist in the registry`);
  }
});

test('the model we were started with is always offered, even if no registry knows it', async () => {
  for (const catalog of [await buildModelCatalog(['acme/custom-1']), buildFullModelCatalog(['acme/custom-1'])]) {
    const extra = catalog['acme/custom-1'];
    assert.ok(extra !== undefined, 'a custom endpoint model must stay selectable');
    assert.equal(extra.provider, 'acme');
    assert.equal(extra.model, 'custom-1');
    // Nothing is known about it, so the picker assumes it can do everything rather than hiding controls.
    assert.equal(extra.reasoning, true);
    assert.equal(extra.imageInput, true);
  }
});

test('every catalog entry is keyed by its own provider/model id', () => {
  for (const entry of Object.values(buildFullModelCatalog())) {
    assert.equal(entry.id, `${entry.provider}/${entry.model}`);
  }
});

test('a model that does not reason offers no thinking levels', () => {
  const reasoning = { id: 'a/b', provider: 'a', model: 'b', displayName: 'B', contextWindow: 1, imageInput: true, reasoning: true };
  assert.deepEqual(thinkingLevelsFor(reasoning), THINKING_LEVELS);
  assert.deepEqual(thinkingLevelsFor({ ...reasoning, reasoning: false }), []);
  // An unknown model is assumed to reason: the engine, not the TUI, has the last word.
  assert.deepEqual(thinkingLevelsFor(undefined), THINKING_LEVELS);
  assert.equal(modelDisplayName('a/b', reasoning), 'B');
  assert.equal(modelDisplayName('a/b', undefined), 'b');
});

function goal(status: GoalSnapshot['status'], reason?: string): GoalSnapshot {
  return {
    objective: 'ship it',
    status,
    turnsUsed: 1,
    tokensUsed: 10,
    wallClockMs: 1000,
    ...(reason !== undefined ? { terminalReason: reason } : {}),
    budget: { turnBudget: null, tokenBudget: null, wallClockBudgetMs: null, remainingTurns: null, remainingTokens: null, remainingWallClockMs: null },
  };
}

test('a goal lifecycle change is read off the status transition', () => {
  assert.deepEqual(goalChangeBetween(goal('active'), goal('paused', 'user asked'), false), {
    kind: 'lifecycle',
    status: 'paused',
    reason: 'user asked',
    actor: undefined,
  });
  // The same status twice is not a change; a first snapshot is the /goal command's own card.
  assert.equal(goalChangeBetween(goal('active'), goal('active'), false), undefined);
  assert.equal(goalChangeBetween(null, goal('active'), false), undefined);
});

test('a cleared goal reads as a cancel, unless the command already announced it', () => {
  assert.deepEqual(goalChangeBetween(goal('active'), null, false), { kind: 'completion', status: 'complete', actor: 'user' });
  assert.equal(goalChangeBetween(goal('active'), null, true), undefined);
  assert.equal(goalChangeBetween(null, null, false), undefined);
});

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    kind: 'process',
    taskId: 't1',
    description: 'build',
    status: 'running',
    startedAt: 1,
    endedAt: null,
    command: 'make',
    exitCode: null,
    ...overrides,
  } as BackgroundTaskInfo;
}

test('a background task card names the subject and the outcome', () => {
  assert.deepEqual(formatBackgroundTaskTranscript(task()), {
    phase: 'started',
    headline: 'bash task started in background',
    detail: 'build',
  });
  const failed = formatBackgroundTaskTranscript(task({ status: 'failed', exitCode: 2, stopReason: 'compiler error' } as Partial<BackgroundTaskInfo>));
  assert.equal(failed.phase, 'failed');
  assert.match(failed.detail ?? '', /exit 2/);
  assert.match(failed.detail ?? '', /compiler error/);
  assert.equal(formatBackgroundTaskTranscript(task({ kind: 'agent', status: 'lost' } as Partial<BackgroundTaskInfo>)).headline, 'agent task lost');
});

test('every non-running status counts as terminal', () => {
  assert.equal(isTerminalBackgroundTask(task()), false);
  for (const status of ['completed', 'failed', 'paused', 'timed_out', 'killed', 'lost'] as const) {
    assert.equal(isTerminalBackgroundTask(task({ status } as Partial<BackgroundTaskInfo>)), true, status);
  }
});

function call(id: string, overrides: Partial<ToolCallBlockData> = {}): ToolCallBlockData {
  return { id, name: 'Bash', args: {}, ...overrides };
}

test('Ctrl-B only offers calls the engine announced as detachable and that have not finished', () => {
  const detachable = pickDetachableToolCalls([
    call('a'),
    call('b', { detachable: true, streamingStartedAtMs: 1 }),
    call('c', { detachable: true, streamingStartedAtMs: 2 }),
    call('d', { detachable: true, result: { tool_call_id: 'd', output: 'done' } }),
  ]);
  // Most recently started first, so Ctrl-B reaches for what is most likely still running.
  assert.deepEqual(detachable.map((item) => item.id), ['c', 'b']);
});

test('steered items are joined by a blank line', () => {
  assert.equal(combineSteerInput([{ text: 'first' }, { text: 'second' }]), 'first\n\nsecond');
  assert.equal(combineSteerInput([{ text: 'only' }]), 'only');
});

test('run-total tokens prefer the reported total and fall back to the parts', () => {
  assert.equal(sumTokenUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 99, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }), 99);
  assert.equal(sumTokenUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }), 10);
});

test('the registry covers the common providers and describes each model fully', () => {
  const entries = Object.values(buildFullModelCatalog());
  const providers = new Set(entries.map((entry) => entry.provider));
  assert.ok(providers.has('anthropic') && providers.has('openai'), 'the common providers should be known');
  // Every entry carries what the picker renders and what a switch needs.
  for (const entry of entries.slice(0, 50)) {
    assert.equal(typeof entry.displayName, 'string');
    assert.ok(entry.displayName.length > 0);
    assert.equal(typeof entry.reasoning, 'boolean');
    assert.equal(typeof entry.imageInput, 'boolean');
  }
});
