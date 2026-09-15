import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentRecord, Message, PromptOrigin } from 'operon-agents';

import {
  appStateFromRecords,
  assistantToolCalls,
  collectReplayMessageContent,
  createReplayRenderContext,
  isTurnBoundaryRecord,
  isTurnStartingOrigin,
  limitReplayRecordsByTurn,
  toolCallFromReplayMessage,
} from '../src/utils/message-replay.ts';
import { buildExportMarkdown, toolCallHint } from '../src/utils/export-markdown.ts';
import { serializeToolResultOutput, toolResultText, userMessageText } from '../src/utils/event-payload.ts';

function userRecord(text: string, origin?: PromptOrigin): AgentRecord {
  return {
    type: 'context.append_message',
    message: { role: 'user', content: text, timestamp: 1 },
    ...(origin !== undefined ? { origin } : {}),
  } as AgentRecord;
}

function assistantRecord(text: string, toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = []): AgentRecord {
  return {
    type: 'context.append_message',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...toolCalls.map((call) => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: call.args })),
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 2,
    },
  } as AgentRecord;
}

function toolResultRecord(toolCallId: string, toolName: string, text: string, isError = false): AgentRecord {
  return {
    type: 'context.append_message',
    message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError, timestamp: 3 },
  } as AgentRecord;
}

test('a user-authored message starts a turn; framing the model was handed does not', () => {
  assert.equal(isTurnStartingOrigin({ kind: 'user' }), true);
  assert.equal(isTurnStartingOrigin({ kind: 'cron_job', jobId: 'j', cron: '* * * * *', recurring: true, coalescedCount: 0, stale: false }), true);
  assert.equal(isTurnStartingOrigin({ kind: 'injection', variant: 'todo' }), false);
  assert.equal(isTurnStartingOrigin({ kind: 'compaction_summary' }), false);
  assert.equal(isTurnStartingOrigin({ kind: 'background_task', taskId: 't' }), false);
  // No origin at all is our own prompt, which is a turn.
  assert.equal(isTurnStartingOrigin(undefined), true);
});

test('only a turn-starting user message counts as a replay boundary', () => {
  assert.equal(isTurnBoundaryRecord(userRecord('hello')), true);
  assert.equal(isTurnBoundaryRecord(userRecord('reminder', { kind: 'injection', variant: 'todo' })), false);
  assert.equal(isTurnBoundaryRecord(assistantRecord('hi')), false);
});

test('the replay window keeps whole turns, counted back from the newest', () => {
  const records: AgentRecord[] = [
    userRecord('one'),
    assistantRecord('a'),
    userRecord('two'),
    assistantRecord('b'),
    userRecord('three'),
    assistantRecord('c'),
  ];
  const limited = limitReplayRecordsByTurn(records, 2);
  assert.equal(limited.length, 4);
  assert.equal(userMessageText((limited[0] as { message: Message }).message as Extract<Message, { role: 'user' }>), 'two');
  // A window wider than the history keeps everything.
  assert.equal(limitReplayRecordsByTurn(records, 10).length, 6);
});

test('assistant content splits into thinking, text and tool calls', () => {
  const context = createReplayRenderContext();
  const message = {
    role: 'assistant' as const,
    content: [
      { type: 'thinking' as const, thinking: 'pondering' },
      { type: 'thinking' as const, thinking: 'redacted', redacted: true },
      { type: 'text' as const, text: 'answer' },
      { type: 'toolCall' as const, id: 'c1', name: 'Read', arguments: { path: 'a.ts' } },
    ],
  } as Extract<Message, { role: 'assistant' }>;
  collectReplayMessageContent(context.assistant, message.content);
  // Redacted reasoning has no visible text, so it is not replayed as a thinking block.
  assert.deepEqual(context.assistant.thinking, ['pondering']);
  assert.deepEqual(context.assistant.text, ['answer']);
  assert.deepEqual(assistantToolCalls(message).map((call) => call.name), ['Read']);

  const block = toolCallFromReplayMessage(assistantToolCalls(message)[0]!, context);
  assert.equal(block?.name, 'Read');
  assert.deepEqual(block?.args, { path: 'a.ts' });
});

test('a tool call description becomes the card description', () => {
  const context = createReplayRenderContext();
  const block = toolCallFromReplayMessage({ type: 'toolCall', id: 'c', name: 'Agent', arguments: { description: 'Sweep the repo' } }, context);
  assert.equal(block?.description, 'Sweep the repo');
});

test('cumulative tokens come from the last usage record in the journal', () => {
  const records: AgentRecord[] = [
    { type: 'usage.record', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, total: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AgentRecord,
    { type: 'usage.record', usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, total: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AgentRecord,
  ];
  assert.deepEqual(appStateFromRecords(records), { cumulativeTokens: 30 });
  assert.deepEqual(appStateFromRecords([]), {});
});

test('tool result content renders as text, with an image shown as a placeholder', () => {
  assert.equal(toolResultText([{ type: 'text', text: 'ok' }]), 'ok');
  assert.equal(toolResultText([{ type: 'image', data: 'AAA', mimeType: 'image/png' }]), '[image image/png]');
  assert.equal(serializeToolResultOutput([{ type: 'text', text: 'done' }]), 'done');
  assert.equal(serializeToolResultOutput({ a: 1 }), '{\n  "a": 1\n}');
});

test('a Markdown export carries the conversation and skips framing the user never wrote', () => {
  const markdown = buildExportMarkdown({
    sessionId: 's1',
    title: 'Refactor',
    workDir: '/repo',
    model: 'anthropic/claude-opus-4-8',
    records: [
      userRecord('do the thing'),
      userRecord('todo list', { kind: 'injection', variant: 'todo' }),
      assistantRecord('on it', [{ id: 'c1', name: 'Bash', args: { command: 'ls' } }]),
      toolResultRecord('c1', 'Bash', 'a.ts'),
      { type: 'context.apply_compaction', summary: 'earlier work', cutoff: 2, compactedCount: 2, tokensBefore: 100, tokensAfter: 20 } as AgentRecord,
    ],
  });
  assert.match(markdown, /# Refactor/);
  assert.match(markdown, /## User\n\ndo the thing/);
  assert.match(markdown, /### Bash: ls/);
  assert.match(markdown, /#### Bash result/);
  assert.match(markdown, /## Compaction\n\nearlier work/);
  assert.ok(!markdown.includes('todo list'), 'an injection must not reach the export');
});

test('a tool call hint prefers the field a human would recognise', () => {
  assert.equal(toolCallHint({ type: 'toolCall', id: 'c', name: 'Bash', arguments: { command: 'ls -la' } }), 'ls -la');
  assert.equal(toolCallHint({ type: 'toolCall', id: 'c', name: 'Read', arguments: { path: 'a.ts' } }), 'a.ts');
  assert.equal(toolCallHint({ type: 'toolCall', id: 'c', name: 'X', arguments: {} }), '');
});
