// A paused turn, in words -- and a reply, back into answers.
//
// A session pauses (`session.status_idle` with `requires_action`) for two reasons, each named by
// the event it blocks on: a tool needs approval (`agent.tool_use` with `evaluated_permission:
// "ask"` -- the permission floor: a sensitive file, a write outside the checkout) or the agent
// asked something (`agent.custom_tool_use` -- AskUserQuestion suspended itself with its
// questions). Both become one message in the thread, and the next reply in the thread answers
// all of it: a `user.tool_confirmation` or a `user.custom_tool_result` per blocking event.
// Replies are prose: Linear and GitHub have no option buttons, so a question's answer is whatever
// the person wrote, and an approval is read off the first word.

import type { ManagedEventResource, ManagedInputEvent } from "operon-managed-agents/protocol";

/** An event a paused session is blocked on. */
export type BlockingEvent = Extract<ManagedEventResource, { readonly type: "agent.tool_use" | "agent.custom_tool_use" }>;

export function isBlocking(event: ManagedEventResource): event is BlockingEvent {
  return (event.type === "agent.tool_use" && event.evaluated_permission === "ask") || event.type === "agent.custom_tool_use";
}

interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
}

// What the call shows about itself: an approval's input is its display; a question's input is
// the request it suspended with, display inside.
function displayOf(event: BlockingEvent): { readonly title?: unknown; readonly detail?: unknown; readonly questions?: unknown } | undefined {
  const input = event.input as { readonly display?: unknown } | null | undefined;
  return (event.type === "agent.tool_use" ? input : input?.display) as ReturnType<typeof displayOf>;
}

function questionsOf(event: BlockingEvent): readonly QuestionItem[] {
  if (event.type !== "agent.custom_tool_use") return [];
  const questions = displayOf(event)?.questions;
  return Array.isArray(questions) ? (questions as QuestionItem[]).filter((q) => typeof q?.question === "string") : [];
}

function textsOf(event: BlockingEvent): { title?: string; detail?: string } {
  const display = displayOf(event);
  return {
    ...(typeof display?.title === "string" ? { title: display.title } : {}),
    ...(typeof display?.detail === "string" ? { detail: display.detail } : {}),
  };
}

/** The thread message for a paused turn. */
export function renderPending(pending: readonly BlockingEvent[]): string {
  const blocks: string[] = [];
  let n = 0;
  for (const entry of pending) {
    if (entry.type === "agent.tool_use") {
      const { detail } = textsOf(entry);
      blocks.push(`**Approval needed:** \`${entry.name}\`${detail ? ` — ${detail}` : ""}`);
      continue;
    }
    const questions = questionsOf(entry);
    if (questions.length === 0) {
      const { title, detail } = textsOf(entry);
      blocks.push(`**Waiting on input** (\`${entry.name}\`)${title ? `: ${title}` : ""}${detail ? `\n${detail}` : ""}`);
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
  const approvals = pending.some((entry) => entry.type === "agent.tool_use");
  const questions = pending.some((entry) => entry.type === "agent.custom_tool_use");
  const footer = approvals
    ? questions
      ? "Reply in this thread: start with `approve` or `reject`, then answer the questions in your own words."
      : "Reply `approve` or `reject` in this thread; anything after the word is passed on as your reason."
    : "Reply in this thread. Free text is fine.";
  return `${blocks.join("\n\n")}\n\n${footer}`;
}

const APPROVE = /^\s*(approve[d]?|yes|ok(ay)?|lgtm|go( ahead)?|proceed|批准|同意|可以|好的?)\b/i;
const REJECT = /^\s*(reject(ed)?|no(pe)?|deny|denied|don'?t|stop|拒绝|不行|不要|别)\b/i;

/** The reply, as one answer per blocking event. Unclear approvals are denials with the reply as
 *  the reason: the agent reads why and can ask again, whereas a guessed approval cannot be
 *  undone. A question gets the whole reply as text; the server hands it to every question the
 *  call asked, as a freeform answer. */
export function answersFor(pending: readonly BlockingEvent[], reply: string): ManagedInputEvent[] {
  const text = reply.trim();
  return pending.map((entry): ManagedInputEvent => {
    if (entry.type === "agent.tool_use") {
      if (APPROVE.test(text)) return { type: "user.tool_confirmation", tool_use_id: entry.id, result: "allow" };
      const reason = text.replace(REJECT, "").replace(/^[\s:,.-]+/, "").trim();
      return { type: "user.tool_confirmation", tool_use_id: entry.id, result: "deny", ...(reason ? { deny_message: reason } : {}) };
    }
    return { type: "user.custom_tool_result", custom_tool_use_id: entry.id, content: [{ type: "text", text }] };
  });
}
