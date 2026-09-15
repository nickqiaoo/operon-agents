import type { ApprovalResponse, InterruptAnswer, PendingRunInterrupt } from 'operon-agents';

import { QuestionDialogComponent } from '../components/dialogs/question-dialog.ts';
import { ApprovalPanelComponent, type ApprovalPanelResponse } from '../components/dialogs/approval-panel.ts';
import { adaptApprovalRequest, adaptPanelResponse } from '../reverse-rpc/approval/adapter.ts';
import { adaptQuestionRequest } from '../reverse-rpc/question/handler.ts';
import type { QuestionPanelResponse } from '../reverse-rpc/types.ts';
import { formatErrorMessage } from '../utils/event-payload.ts';
import type { SlashCommandHost } from './dispatch.ts';

/**
 * Answer a durable interruption and resume the run.
 *
 * A session whose run paused with nobody attached (an approval or an AskUserQuestion raised while
 * headless, or a crash mid-approval) reopens in the `interrupted` state. Each pending item gets
 * its own panel, exactly like the live path, and the collected answers go back through
 * `session.resume`.
 */
export async function handleContinueCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;

  let pending: readonly PendingRunInterrupt[];
  try {
    pending = await session.pendingInterruptions();
  } catch (error) {
    host.showError(`Failed to read the pending interruption: ${formatErrorMessage(error)}`);
    return;
  }
  if (pending.length === 0) {
    host.showStatus('There is no durable interruption to resume.', 'textMuted');
    return;
  }

  const answers: Record<string, ApprovalResponse | InterruptAnswer> = {};
  for (const item of pending) {
    const answer = await askPending(host, item);
    if (answer === undefined) {
      host.showStatus('Resume cancelled; the session stays interrupted.', 'warning');
      return;
    }
    answers[item.approvalId] = answer;
  }

  host.beginSessionRequest();
  try {
    await session.resume(answers);
  } catch (error) {
    host.failSessionRequest(`Failed to resume: ${formatErrorMessage(error)}`);
  }
}

async function askPending(host: SlashCommandHost, item: PendingRunInterrupt): Promise<InterruptAnswer | undefined> {
  if (item.kind === 'approval') {
    // Esc on the panel answers "rejected" — a real decision, not a cancellation.
    return { kind: 'approval', ...(await askApproval(host, item)) };
  }
  const questions = questionItemsOf(item.request.display);
  if (questions !== undefined) {
    const answers = await askQuestions(host, questions);
    const keyed: Record<string, string | readonly string[]> = {};
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      const answer = answers.answers[i];
      if (question === undefined || answer === undefined || answer.length === 0) continue;
      keyed[question.question] = question.multiSelect ? answer.split(', ').filter((s) => s.length > 0) : answer;
    }
    return { kind: 'input', data: Object.keys(keyed).length > 0 ? { answers: keyed, method: answers.method } : null };
  }
  host.showError(`The paused ${item.toolName} call asks for "${item.request.kind ?? 'input'}", which this client cannot render.`);
  return undefined;
}

interface PendingQuestionItem {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiSelect: boolean;
}

/** A suspended `AskUserQuestion` carries its items on the request's display payload. */
function questionItemsOf(display: unknown): readonly PendingQuestionItem[] | undefined {
  if (typeof display !== 'object' || display === null) return undefined;
  const questions = (display as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  return questions as readonly PendingQuestionItem[];
}

function askApproval(host: SlashCommandHost, item: Extract<PendingRunInterrupt, { kind: 'approval' }>): Promise<ApprovalResponse> {
  return new Promise((resolve) => {
    const panel = new ApprovalPanelComponent(
      {
        data: adaptApprovalRequest({
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          approvalRule: item.approvalRule,
          display: item.display,
        }),
      },
      (response: ApprovalPanelResponse) => {
        host.restoreEditor();
        resolve(adaptPanelResponse(response));
      },
    );
    host.mountEditorReplacement(panel);
  });
}

function askQuestions(host: SlashCommandHost, questions: readonly PendingQuestionItem[]): Promise<QuestionPanelResponse> {
  return new Promise((resolve) => {
    const dialog = new QuestionDialogComponent(
      {
        data: adaptQuestionRequest({
          turnId: '',
          toolCallId: 'resume',
          questions: questions.map((question) => ({
            question: question.question,
            header: question.header,
            options: question.options,
            multiSelect: question.multiSelect,
          })),
        }),
      },
      (response) => {
        host.restoreEditor();
        resolve(response);
      },
      6,
    );
    host.mountEditorReplacement(dialog);
  });
}
