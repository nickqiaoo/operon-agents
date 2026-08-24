import type { QuestionItem, QuestionResult } from "./questions.ts";
import type { ToolRunContext } from "./types.ts";

/**
 * Ask the user from inside a tool, on whatever channel is available:
 *
 *  - live question channel present (`ctx.responder.requestQuestion`) → ask inline, return
 *    the answer immediately;
 *  - otherwise → suspend durably (`ctx.suspend`): the run pauses, the questions surface on
 *    the paused run's pending list, and the answer arrives through `Runner.resume` — this
 *    call then returns it on the re-run.
 *
 * This mirrors the permission layer's rule: a live responder answers in place, an absent
 * one means durable. `state` is persisted across the suspension and comes back on
 * `ctx.resumed.state` — pass whatever the re-run needs to skip already-done work.
 *
 * Contract: at most ONE `askUser` per tool run — enforced at runtime: a second call in
 * the same run throws (on a resumed run it would otherwise silently return the SAME
 * stale answer). Multi-round tools should use `ctx.suspend` directly with a state field
 * tracking the round.
 */
export async function askUser(
  ctx: ToolRunContext,
  questions: readonly QuestionItem[],
  state?: unknown,
): Promise<QuestionResult> {
  if (asked.has(ctx)) {
    throw new Error(
      "askUser was called twice in one tool run. A resumed run delivers exactly one answer; for multi-round questions use ctx.suspend directly with round-tracking state.",
    );
  }
  asked.add(ctx);
  if (ctx.resumed) return ctx.resumed.answer as QuestionResult;
  if (ctx.responder?.requestQuestion) {
    return await ctx.responder.requestQuestion(
      { turnId: ctx.turnId, toolCallId: ctx.toolCallId, questions },
      { signal: ctx.signal },
    );
  }
  ctx.suspend({ kind: "question", display: { questions } }, state);
  // suspend() is typed `never`, but that's a runtime promise the type system cannot
  // verify. A non-conforming ToolRunContext that returns here would resolve `undefined`
  // as the "answer" — fail loudly instead of handing the tool a phantom result.
  throw new Error("ToolRunContext.suspend() returned instead of interrupting the run — non-conforming implementation.");
}

/** One entry per tool-run context: each run (including each post-suspend re-run) gets a
 *  fresh `ToolRunContext` object, so identity tracks "this run" exactly. */
const asked = new WeakSet<ToolRunContext>();
