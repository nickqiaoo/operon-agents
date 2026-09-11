// A paused turn, in words -- and a reply, back into answers.
//
// The engine pauses a session for two reasons: the agent asked something (AskUserQuestion
// suspended itself with its questions) or a tool needs approval (the permission floor: a
// sensitive file, a write outside the checkout). Both become one message in the thread, and the
// next reply in the thread answers all of it. Replies are prose: Linear and GitHub have no option
// buttons, so a question's answer is whatever the person wrote, and an approval is read off the
// first word.

import type { InterruptAnswer, PendingRunInterrupt } from "operon-agents";

interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
}

function questionsOf(pending: PendingRunInterrupt): readonly QuestionItem[] {
  if (pending.kind !== "input") return [];
  const display = pending.request.display as { readonly questions?: unknown } | undefined;
  const questions = display?.questions;
  return Array.isArray(questions) ? (questions as QuestionItem[]).filter((q) => typeof q?.question === "string") : [];
}

function displayOf(pending: PendingRunInterrupt): { title?: string; detail?: string } {
  const display = (pending.kind === "approval" ? pending.display : pending.request.display) as
    | { readonly title?: unknown; readonly detail?: unknown }
    | undefined;
  return {
    ...(typeof display?.title === "string" ? { title: display.title } : {}),
    ...(typeof display?.detail === "string" ? { detail: display.detail } : {}),
  };
}

/** The thread message for a paused turn. */
export function renderPending(pending: readonly PendingRunInterrupt[]): string {
  const blocks: string[] = [];
  let n = 0;
  for (const entry of pending) {
    if (entry.kind === "approval") {
      const { detail } = displayOf(entry);
      blocks.push(`**Approval needed:** \`${entry.toolName}\`${detail ? ` — ${detail}` : ""}`);
      continue;
    }
    const questions = questionsOf(entry);
    if (questions.length === 0) {
      const { title, detail } = displayOf(entry);
      blocks.push(`**Waiting on input** (\`${entry.toolName}\`)${title ? `: ${title}` : ""}${detail ? `\n${detail}` : ""}`);
      continue;
    }
    for (const q of questions) {
      n += 1;
      const header = q.header ? ` (${q.header})` : "";
      const lines = [`**Question ${n}${header}:** ${q.question}`];
      for (const option of q.options ?? []) {
        lines.push(`- **${option.label}**${option.description ? ` — ${option.description}` : ""}`);
      }
      if (q.multiSelect) lines.push("_(more than one may apply)_");
      blocks.push(lines.join("\n"));
    }
  }
  const approvals = pending.some((entry) => entry.kind === "approval");
  const questions = pending.some((entry) => entry.kind === "input");
  const footer = approvals
    ? questions
      ? "Reply in this thread: start with `approve` or `reject`, then answer the questions in your own words."
      : "Reply `approve` or `reject` in this thread; anything after the word is passed on as your reason."
    : "Reply in this thread. Free text is fine.";
  return `${blocks.join("\n\n")}\n\n${footer}`;
}

const APPROVE = /^\s*(approve[d]?|yes|ok(ay)?|lgtm|go( ahead)?|proceed|批准|同意|可以|好的?)\b/i;
const REJECT = /^\s*(reject(ed)?|no(pe)?|deny|denied|don'?t|stop|拒绝|不行|不要|别)\b/i;

/** The reply, routed to every pending entry. Unclear approvals are rejections with the reply as
 *  feedback: the agent reads why and can ask again, whereas a guessed approval cannot be undone. */
export function answersFor(pending: readonly PendingRunInterrupt[], reply: string): Record<string, InterruptAnswer> {
  const text = reply.trim();
  const answers: Record<string, InterruptAnswer> = {};
  for (const entry of pending) {
    if (entry.kind === "approval") {
      const approved = APPROVE.test(text);
      const feedback = text.replace(approved ? APPROVE : REJECT, "").replace(/^[\s:,.-]+/, "").trim();
      answers[entry.approvalId] = {
        kind: "approval",
        decision: approved ? "approved" : "rejected",
        ...(feedback ? { feedback } : {}),
      };
      continue;
    }
    // A question's answer is keyed by its text (the AskUserQuestion contract); with no option
    // buttons every question gets the whole reply, marked freeform so the model reads it as prose.
    const questions = questionsOf(entry);
    const byQuestion = Object.fromEntries((questions.length > 0 ? questions.map((q) => q.question) : ["reply"]).map((q) => [q, text]));
    answers[entry.approvalId] = { kind: "input", data: { answers: byQuestion, method: "freeform" } };
  }
  return answers;
}
