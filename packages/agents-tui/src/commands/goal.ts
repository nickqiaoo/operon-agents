import type { GoalSnapshot, HarnessSession } from 'operon-agents';

import { GoalSetMessageComponent } from '../components/messages/goal-panel.ts';
import { formatErrorMessage } from '../utils/event-payload.ts';
import { nextTranscriptId } from '../utils/transcript-id.ts';
import type { SlashCommandHost } from './dispatch.ts';

/** Beyond this the objective is prompt-sized rather than a goal; the editor warns before submit. */
const MAX_GOAL_OBJECTIVE_CHARS = 2000;

export function goalObjectiveLengthWarning(input: string): string | undefined {
  const parsed = parseGoalCommand(input);
  if (parsed?.kind !== 'create' && parsed?.kind !== 'replace') return undefined;
  const length = parsed.objective.length;
  if (length <= MAX_GOAL_OBJECTIVE_CHARS) return undefined;
  return `Goal objective is ${String(length)} characters (max ${String(MAX_GOAL_OBJECTIVE_CHARS)}).`;
}

export type GoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'replace'; readonly objective: string };

/** Parse `/goal …`; returns null when the input is not a `/goal` command at all. */
export function parseGoalCommand(input: string): GoalCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/goal')) return null;
  const rest = trimmed.slice('/goal'.length).trim();
  if (rest.length === 0 || rest === 'status') return { kind: 'status' };
  if (rest === 'pause') return { kind: 'pause' };
  if (rest === 'resume') return { kind: 'resume' };
  if (rest === 'cancel') return { kind: 'cancel' };
  if (rest.startsWith('replace')) {
    return { kind: 'replace', objective: rest.slice('replace'.length).trim() };
  }
  return { kind: 'create', objective: rest };
}

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = parseGoalCommand(`/goal ${args}`);
  if (command === null) return;
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;

  switch (command.kind) {
    case 'status':
      await showGoalStatus(host, session);
      return;
    case 'pause':
      await runGoalLifecycle(host, () => session.pauseGoal({ reason: 'Paused by the user' }), 'Goal paused.');
      return;
    case 'resume':
      await runGoalLifecycle(host, () => session.resumeGoal({ reason: 'Resumed by the user' }), 'Goal resumed.');
      return;
    case 'cancel':
      host.noteGoalCancelled?.();
      await runGoalLifecycle(host, () => session.cancelGoal({ reason: 'Cancelled by the user' }), 'Goal cancelled.');
      return;
    case 'create':
    case 'replace':
      await createGoal(host, session, command.objective, command.kind === 'replace');
      return;
  }
}

async function showGoalStatus(host: SlashCommandHost, session: HarnessSession): Promise<void> {
  let goal: GoalSnapshot | null;
  try {
    goal = await session.getGoal();
  } catch (error) {
    host.showError(`Failed to read the goal: ${formatErrorMessage(error)}`);
    return;
  }
  if (goal === null) {
    host.showStatus('No active goal. Start one with /goal <objective>.', 'textMuted');
    return;
  }
  host.setAppState({ goal });
  const budget = goal.budget;
  const parts = [`status ${goal.status}`, `${String(goal.turnsUsed)} turns`, `${String(goal.tokensUsed)} tokens`];
  if (budget.remainingTurns !== null) parts.push(`${String(budget.remainingTurns)} turns left`);
  if (budget.remainingTokens !== null) parts.push(`${String(budget.remainingTokens)} tokens left`);
  host.showNotice(`Goal: ${goal.objective}`, parts.join(' · '));
}

async function runGoalLifecycle(
  host: SlashCommandHost,
  run: () => Promise<GoalSnapshot | null>,
  message: string,
): Promise<void> {
  try {
    const snapshot = await run();
    if (snapshot === null) {
      host.showStatus('No active goal.', 'textMuted');
      return;
    }
    host.showStatus(message, 'success');
  } catch (error) {
    host.showError(formatErrorMessage(error));
  }
}

/**
 * Start a goal and hand the engine the first turn. `createGoal` records the objective; the
 * objective itself is then sent as the prompt that opens the loop.
 */
export async function createGoal(
  host: SlashCommandHost,
  session: HarnessSession,
  objective: string,
  replace: boolean,
): Promise<boolean> {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    host.showError('Usage: /goal <objective>');
    return false;
  }
  const warning = goalObjectiveLengthWarning(`/goal ${trimmed}`);
  if (warning !== undefined) {
    host.showError(`${warning} Put the detail in a file and point the goal at it.`);
    return false;
  }
  const existing = await session.getGoal().catch(() => null);
  if (existing !== null && !replace) {
    host.showError('A goal is already active. Use /goal replace <objective> to swap it, or /goal cancel first.');
    return false;
  }
  try {
    const snapshot = await session.createGoal({ objective: trimmed });
    host.setAppState({ goal: snapshot });
  } catch (error) {
    host.showError(`Failed to create the goal: ${formatErrorMessage(error)}`);
    return false;
  }
  host.state.transcriptContainer.addChild(new GoalSetMessageComponent());
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'user',
    renderMode: 'plain',
    content: trimmed,
  });
  host.sendQueuedMessage(session, { text: trimmed });
  return true;
}
