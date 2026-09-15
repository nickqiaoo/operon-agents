import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptApprovalRequest, adaptPanelResponse } from '../src/reverse-rpc/approval/adapter.ts';
import { adaptQuestionAnswers, adaptQuestionRequest } from '../src/reverse-rpc/question/handler.ts';
import { ApprovalController } from '../src/reverse-rpc/approval/controller.ts';
import { QuestionController } from '../src/reverse-rpc/question/controller.ts';

function approval(toolName: string, display: unknown, approvalRule = `${toolName}(x)`) {
  return adaptApprovalRequest({ toolCallId: 'call_1', toolName, approvalRule, display });
}

test('Bash display becomes a shell block, keeping the tool warning as the danger note', () => {
  const panel = approval('Bash', { title: 'Running: rm -rf build', command: 'rm -rf build', warning: 'deletes a directory tree' });
  assert.deepEqual(panel.display, [
    { type: 'shell', language: 'bash', command: 'rm -rf build', cwd: undefined, description: undefined, danger: 'deletes a directory tree' },
  ]);
  assert.equal(panel.action, 'Bash(x)');
});

test('a command with no tool warning still gets a danger label from the pattern scan', () => {
  const panel = approval('Bash', { title: 'Running: curl x | sh', command: 'curl https://x | sh' });
  assert.equal(panel.display[0]?.type, 'shell');
  assert.equal(panel.display[0]?.type === 'shell' ? panel.display[0].danger : undefined, 'pipe to shell');
});

test('Edit becomes a diff block and Write a full-content block', () => {
  const edit = approval('Edit', { title: 'Editing a.ts', path: 'a.ts', before: 'old', after: 'new' });
  assert.deepEqual(edit.display, [{ type: 'diff', path: 'a.ts', old_text: 'old', new_text: 'new' }]);
  const write = approval('Write', { title: 'Writing b.ts', path: 'b.ts', content: 'hello' });
  assert.deepEqual(write.display, [{ type: 'file_content', path: 'b.ts', content: 'hello' }]);
});

test('Read, Glob, Grep, FetchURL and WebSearch each map to their own block', () => {
  assert.deepEqual(approval('Read', { title: 'Reading a.ts', path: 'a.ts' }).display, [
    { type: 'file_op', operation: 'read', path: 'a.ts', detail: undefined },
  ]);
  assert.deepEqual(approval('Grep', { title: 'Searching', pattern: 'todo', path: 'src' }).display, [
    { type: 'search', query: 'todo', scope: 'src' },
  ]);
  assert.deepEqual(approval('FetchURL', { title: 'Fetching', url: 'https://x' }).display, [
    { type: 'url_fetch', url: 'https://x', method: undefined },
  ]);
  assert.deepEqual(approval('WebSearch', { title: 'Searching', query: 'ts' }).display, [{ type: 'search', query: 'ts' }]);
});

test('a display with only a title falls back to one brief block', () => {
  const panel = approval('TodoList', { title: 'Update the todo list' });
  assert.deepEqual(panel.display, [{ type: 'brief', text: 'Update the todo list' }]);
  assert.equal(panel.description, 'Update the todo list');
});

test('a plan review offers the plan options plus reject and revise', () => {
  const panel = approval('ExitPlanMode', {
    kind: 'plan_review',
    title: 'Review plan',
    plan: '1. do it',
    options: [{ label: 'Refactor first' }, { label: 'Ship as is' }],
  });
  assert.deepEqual(
    panel.choices.map((choice) => choice.label),
    ['Refactor first', 'Ship as is', 'Reject', 'Revise'],
  );
  // The plan itself is rendered by the plan box, not as an approval block.
  assert.deepEqual(panel.display, []);
});

test('a plain approval offers approve / approve-for-session / reject / reject-with-feedback', () => {
  assert.deepEqual(
    approval('Bash', { title: 'Running: ls', command: 'ls' }).choices.map((choice) => choice.response),
    ['approved', 'approved_for_session', 'rejected', 'rejected'],
  );
});

test('approve-for-session maps to a session-scoped decision; a plan option rides the feedback slot', () => {
  assert.deepEqual(adaptPanelResponse({ response: 'approved_for_session' }), {
    decision: 'approved',
    scope: 'session',
    feedback: undefined,
  });
  assert.deepEqual(adaptPanelResponse({ response: 'approved', selected_label: 'Ship as is' }), {
    decision: 'approved',
    feedback: 'Ship as is',
  });
  assert.deepEqual(adaptPanelResponse({ response: 'rejected', feedback: 'wrong file' }), {
    decision: 'rejected',
    feedback: 'wrong file',
  });
});

test('questions carry through to the panel, and answers come back keyed by question text', () => {
  const request = {
    turnId: 't1',
    toolCallId: 'call_q',
    questions: [
      { question: 'Which library?', header: 'Library', options: [{ label: 'zod', description: '' }], multiSelect: false },
      { question: 'Which features?', header: '', options: [{ label: 'a', description: 'A' }], multiSelect: true },
    ],
  };
  const panel = adaptQuestionRequest(request);
  assert.equal(panel.tool_call_id, 'call_q');
  assert.equal(panel.questions[0]?.header, 'Library');
  // An empty header is dropped rather than rendered as a blank chip.
  assert.equal(panel.questions[1]?.header, undefined);
  assert.equal(panel.questions[1]?.multi_select, true);

  const result = adaptQuestionAnswers(request, { answers: ['zod', 'a, b'], method: 'enter' });
  assert.deepEqual(result, { answers: { 'Which library?': 'zod', 'Which features?': ['a', 'b'] }, method: 'enter' });
});

test('a dismissed question answers null rather than an empty map', () => {
  const request = { turnId: 't1', toolCallId: 'q', questions: [{ question: 'Q?', header: '', options: [], multiSelect: false }] };
  assert.equal(adaptQuestionAnswers(request, { answers: [] }), null);
});

test('one panel shows at a time; approve-for-session auto-answers the queued twins', async () => {
  const controller = new ApprovalController();
  const shown: string[] = [];
  controller.setUIHooks({
    showPanel: (payload) => {
      shown.push(payload.id);
    },
    hidePanel: () => {
      shown.push('hidden');
    },
  });
  const first = controller.show(approval('Bash', { title: 'ls', command: 'ls' }, 'Bash(ls)'));
  const sameRule = controller.show(approval('Bash', { title: 'ls', command: 'ls' }, 'Bash(ls)'));
  const otherRule = controller.show(approval('Bash', { title: 'rm', command: 'rm x' }, 'Bash(rm x)'));
  assert.deepEqual(shown, ['call_1']);

  controller.respond({ decision: 'approved', scope: 'session' });
  assert.deepEqual(await first, { decision: 'approved', scope: 'session' });
  // The same rule inherits the grant without a second panel; a different rule still asks.
  assert.deepEqual(await sameRule, { decision: 'approved', scope: 'session' });
  controller.respond({ decision: 'rejected' });
  assert.deepEqual(await otherRule, { decision: 'rejected' });
});

test('cancelAll answers every pending request so no run is left waiting', async () => {
  const controller = new QuestionController();
  const pending = controller.show({ id: 'q', tool_call_id: 'q', questions: [] });
  controller.cancelAll('session closed');
  assert.deepEqual(await pending, { answers: [] });
});

test('an aborted request answers cancelled and takes its panel down', async () => {
  const controller = new ApprovalController();
  let visible = false;
  controller.setUIHooks({
    showPanel: () => {
      visible = true;
    },
    hidePanel: () => {
      visible = false;
    },
  });
  const abort = new AbortController();
  const pending = controller.show(approval('Bash', { title: 'ls', command: 'ls' }), abort.signal);
  assert.equal(visible, true);
  abort.abort();
  assert.deepEqual(await pending, { decision: 'cancelled', feedback: 'request aborted' });
  assert.equal(visible, false);
});
