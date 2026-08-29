/**
 * The RunCode tool: takes the model's program, exposes this step's tools to it as `tools.*`,
 * runs it in the code runtime, and returns what the program printed or returned.
 *
 * Every `tools.X(args)` the program makes goes through `ToolRunContext.dispatch` — the engine's
 * own pipeline for a nested call — so it faces the same hooks and permissions a direct call
 * would. This file adds only the program-side policy: how many calls, how many at once, what a
 * binding resolves to (the tool's text), and how failures reach the program (`ToolCallError`).
 *
 * ── Pausing for an approval ──
 *
 * A nested call may need the user's approval when nobody is there to give it (a server, a
 * closed terminal). The engine cannot pause a nested call, but this tool can pause ITSELF:
 * it stops the program, records every nested call that already ran in a journal (a durable KV
 * the host supplies), and suspends with the approval request. When the user answers, the
 * program runs again from the top; calls found in the journal return their recorded result
 * without executing, the call that asked is dispatched with the answer, and the rest run
 * live. The program never sees the pause — only its own code, re-executed against the same
 * results. Same idea as the Workflow tool's journal, for the same reason: re-running a
 * program must not repeat its side effects.
 *
 * ── Running in the background ──
 *
 * A long program (polling, many slow tool calls) need not hold the turn. Started with
 * `run_in_background`, or moved there while running (the session's `detachTool`), it becomes a
 * background task the model reads with `BackgroundOutput`; its console lines, each nested call's
 * outcome and the final result go to a log file on the machine, the way a background command's
 * bytes do. A program in the background has no turn to pause, so an approval nobody can give
 * fails inside it instead — the same as with no journal.
 */
import { z } from "zod";
import { asTaskRegistrar, CodeBackgroundTask, defineTool, prepareBackgroundLog, ToolAccesses } from "operon-agents-core";
import type { ApprovalResponse, ImageContent, Machine, NestedCallInterrupt, Tool, ToolResult, ToolResultContent, ToolRunContext } from "operon-agents-core";
import { briefOf } from "./declarations.ts";
import { BACKGROUND_PARAM_DESCRIPTION, CODE_PARAM_DESCRIPTION, DESCRIPTION_PARAM_DESCRIPTION, RUN_CODE_NAME } from "./prompt.ts";
import { ToolCallFailure } from "./runtime.ts";
import type { CodeBinding, CodeRunFailure, CodeRuntime } from "./runtime.ts";

export interface RunCodeLimits {
  /** Wall-clock budget for one program, tool calls included. Default 10 minutes. */
  readonly maxWallMs: number;
  /** Budget for the program's own JavaScript execution. Default 30 s. */
  readonly maxComputeMs: number;
  /** Heap the program may allocate. Default 64 MiB. */
  readonly maxMemoryBytes: number;
  /** Cap on what comes back to the model (logs + return value). Default 32 KiB. */
  readonly maxOutputBytes: number;
  /** Tool calls one program may make. Default 200. */
  readonly maxToolCalls: number;
  /** Tool calls in flight at once; the engine still serializes conflicting ones. Default 8. */
  readonly maxParallel: number;
}

export const DEFAULT_RUN_CODE_LIMITS: RunCodeLimits = {
  maxWallMs: 10 * 60_000,
  maxComputeMs: 30_000,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxOutputBytes: 32 * 1024,
  maxToolCalls: 200,
  maxParallel: 8,
};

/** Durable KV the replay journal lives in — the shape of an extension's `api.state`. */
export interface RunCodeJournalStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RunCodeToolOptions {
  readonly runtime: CodeRuntime;
  readonly limits?: Partial<RunCodeLimits>;
  /** Tools a program may never call, on top of RunCode itself. */
  readonly exclude?: readonly string[];
  /** The description to advertise. The extension replaces it per request with the declarations rendered in. */
  readonly description: string;
  /**
   * Where a paused program's journal is kept. Without it a nested call that needs an approval
   * nobody can give fails inside the program (the model is told to call that tool directly)
   * instead of pausing the run.
   */
  readonly journal?: RunCodeJournalStore;
}

/** One nested call, as the tool reports it in `details.dispatches` — the durable trace of a program. */
export interface RunCodeDispatch {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  /** True when the call did not execute this time: its recorded result was replayed after a pause. */
  readonly replayed?: boolean;
}

export interface RunCodeDetails {
  readonly dispatches: readonly RunCodeDispatch[];
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly error?: CodeRunFailure;
  /** Nested calls answered from the journal after a pause. */
  readonly replayed: number;
  /** The call at which a re-run stopped matching its journal (its program branched differently); later calls ran live. */
  readonly divergedAt?: number;
  /** Present when the program went to the background: the task to read its output from. */
  readonly taskId?: string;
  readonly movedToBackground?: boolean;
}

/** What a paused RunCode call saves; the journal itself lives under `journalKey`. */
export interface RunCodeSuspendState {
  readonly version: 1;
  /** Sequence number of the nested call waiting for the answer. */
  readonly pendingCall: number;
  readonly journalKey: string;
}

/** The request a paused program surfaces: the nested call's approval, plus where it sits in the program. */
export interface RunCodeApprovalRequest extends NestedCallInterrupt {
  /** Sequence number of the nested call inside the program. */
  readonly sequence: number;
  /** The model's one-line description of the program. */
  readonly program: string;
}

interface JournalEntry {
  readonly name: string;
  /** The call's arguments as JSON — a replayed call must match on both name and arguments. */
  readonly args: string;
  readonly text: string;
  readonly isError: boolean;
}

/** Recorded nested calls by sequence number. Holes are calls that never completed (the paused one). */
type Journal = Record<string, JournalEntry>;

const JOURNAL_KEY_PREFIX = "code-mode:journal:";
const PAUSING = "the program is pausing for the user's approval";
/** How often the background log on the machine is rewritten while a program runs. */
const LOG_FLUSH_INTERVAL_MS = 250;

const RunCodeInput = z.object({
  code: z.string().describe(CODE_PARAM_DESCRIPTION),
  description: z.string().describe(DESCRIPTION_PARAM_DESCRIPTION),
  run_in_background: z.boolean().optional().describe(BACKGROUND_PARAM_DESCRIPTION),
});

/** How a program run ends, before it is rendered for the model. */
type ProgramOutcome =
  | { readonly kind: "result"; readonly result: ToolResult; readonly isError: boolean }
  | { readonly kind: "paused"; readonly request: RunCodeApprovalRequest; readonly state: RunCodeSuspendState };

export function createRunCodeTool(options: RunCodeToolOptions): Tool {
  const limits: RunCodeLimits = { ...DEFAULT_RUN_CODE_LIMITS, ...options.limits };
  const excluded = new Set([RUN_CODE_NAME, ...(options.exclude ?? [])]);
  return defineTool({
    name: RUN_CODE_NAME,
    description: options.description,
    params: RunCodeInput,
    // The program is what the `auto`-mode judge should read; each nested call is judged on its own.
    toAutoApprovalInput: (args) => args.code,
    resolve(args) {
      if (args.description.trim().length === 0) throw new Error("description must not be empty");
      return {
        approvalRule: RUN_CODE_NAME,
        // Control flow, like Agent and Workflow: the program itself has no effect; every tool it
        // calls is authorized on its own as a nested call. So RunCode does not prompt — a deny
        // rule naming it still wins, as for any control-flow tool.
        controlFlow: true,
        // What a program touches is unknown until it runs: serialize it against the rest of the batch.
        accesses: ToolAccesses.all(),
        display: { title: args.description, code: args.code },
        run: (ctx) => execute(args.code, args.description, args.run_in_background === true, ctx),
      };
    },
  });

  async function execute(code: string, description: string, runInBackground: boolean, ctx: ToolRunContext): Promise<ToolResult> {
    const dispatch = ctx.dispatch;
    if (dispatch === undefined) {
      return errorResult("RunCode needs an engine that supports nested tool calls (ToolRunContext.dispatch); this one does not provide it.");
    }
    const registrar = asTaskRegistrar(ctx.background);
    if (runInBackground && registrar === undefined) {
      return errorResult("run_in_background requested but this session has no background capability; run the program in the foreground.");
    }

    // The program runs on its OWN controller, bridged from the turn's signal only while the
    // program is attached: moving it to the background drops the bridge, so the end of the
    // turn no longer kills it.
    const controller = new AbortController();
    const bridge = (): void => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", bridge, { once: true });
    let detached = runInBackground;
    const detachable = registrar !== undefined && (runInBackground || ctx.detachSignal !== undefined);
    const log = detachable ? await TaskLog.open(ctx.machine) : undefined;

    const program = runProgram({
      code,
      description,
      ctx,
      dispatch,
      signal: controller.signal,
      canPause: () => !detached && options.journal !== undefined,
      onLine: (line) => {
        if (!detached) ctx.onUpdate?.({ kind: "stdout", text: line });
        log?.append(line);
      },
    });

    /** Hand the running program to the background: register the task, unhook it from the turn. */
    const moveToBackground = (): ToolResult => {
      ctx.signal.removeEventListener("abort", bridge);
      detached = true;
      const taskId = registrar!.registerTask(
        new CodeBackgroundTask(
          async () => {
            const outcome = await program;
            const done = outcome.kind === "result"
              ? outcome
              : { isError: true, result: errorResult(`the program needed an approval (${outcome.request.toolName}) that a background program cannot wait for`) };
            log!.append(done.isError ? "--- failed ---" : "--- result ---");
            log!.append(textOf(done.result.content));
            await log!.close();
            return { ok: !done.isError, ...(done.isError ? { stopReason: firstLine(textOf(done.result.content)) } : {}) };
          },
          description,
          { logPath: log!.path, machine: ctx.machine, parentAddress: ctx.address, toolCallId: ctx.toolCallId, abort: () => controller.abort() },
        ),
      );
      ctx.onUpdate?.({ kind: "custom", customKind: "detached", customData: { taskId } });
      return {
        content: [
          {
            type: "text",
            text: [
              `Moved to background task ${taskId}.`,
              `program: ${description}`,
              "automatic_notification: true",
              "",
              `next_step: A completion notice arrives automatically. BackgroundOutput(task_id="${taskId}", block=false) reads the program's console output so far, then its final result.`,
            ].join("\n"),
          },
        ],
        details: { dispatches: [], toolCalls: 0, truncated: false, replayed: 0, taskId, movedToBackground: true } satisfies RunCodeDetails,
      };
    };

    if (runInBackground) return moveToBackground();

    let outcome: ProgramOutcome;
    if (detachable && ctx.detachSignal !== undefined) {
      const detachSignal = ctx.detachSignal;
      ctx.onUpdate?.({ kind: "custom", customKind: "detachable" }); // UI: offer "move to background"
      const detachRequested = new Promise<"detach">((resolve) => {
        if (detachSignal.aborted) resolve("detach");
        else detachSignal.addEventListener("abort", () => resolve("detach"), { once: true });
      });
      const winner = await Promise.race([program.then(() => "done" as const), detachRequested]);
      if (winner === "detach") return moveToBackground();
      ctx.signal.removeEventListener("abort", bridge);
      outcome = await program;
      await log?.close();
    } else {
      try {
        outcome = await program;
      } finally {
        ctx.signal.removeEventListener("abort", bridge);
      }
    }
    if (outcome.kind === "paused") ctx.suspend({ kind: "approval", display: outcome.request }, outcome.state);
    return outcome.result;
  }

  interface ProgramRun {
    readonly code: string;
    readonly description: string;
    readonly ctx: ToolRunContext;
    readonly dispatch: NonNullable<ToolRunContext["dispatch"]>;
    readonly signal: AbortSignal;
    /** Whether an approval nobody can give may pause the run right now (attached, with a journal). */
    readonly canPause: () => boolean;
    readonly onLine: (line: string) => void;
  }

  /** One execution of the program: bindings, replay, limits, and the rendering of what came back. */
  async function runProgram(run: ProgramRun): Promise<ProgramOutcome> {
    const { ctx, dispatch } = run;
    const schemas = dispatch.schemas.filter((schema) => !excluded.has(schema.name));
    const dispatches: RunCodeDispatch[] = [];
    const images: ImageContent[] = [];
    const gate = new Gate(limits.maxParallel);
    let calls = 0;

    // ── continuation of a paused program ──
    const resume = continuationOf(ctx);
    const journalKey = resume?.journalKey ?? `${JOURNAL_KEY_PREFIX}${ctx.toolCallId}`;
    const journal: Journal = resume !== undefined && options.journal !== undefined ? ((await options.journal.get<Journal>(resume.journalKey)) ?? {}) : {};
    let replaying = resume !== undefined;
    let replayed = 0;
    let divergedAt: number | undefined;
    const inFlight = new Set<Promise<unknown>>();
    let pause: { readonly sequence: number; readonly interrupt: NestedCallInterrupt } | undefined;
    const pauseController = new AbortController();
    const signal = AbortSignal.any([run.signal, pauseController.signal]);

    const bindings: Record<string, CodeBinding> = {};
    for (const schema of schemas) {
      const name = schema.name;
      bindings[name] = async (args) => {
        if (pause !== undefined) throw new ToolCallFailure(name, PAUSING);
        if (run.signal.aborted) throw new ToolCallFailure(name, "the run was aborted");
        calls += 1;
        const sequence = calls;
        if (calls > limits.maxToolCalls) {
          throw new ToolCallFailure(name, `this program has reached its limit of ${String(limits.maxToolCalls)} tool calls`);
        }
        const argsJson = JSON.stringify(args ?? null) ?? "null";

        // Replay: a call the previous run already made returns what it got then. The journal
        // is trusted only while the program keeps making the same calls in the same order; the
        // first mismatch means it branched differently (Date.now(), Math.random()), and from
        // there on everything runs live — announced in the result, never silently.
        if (replaying) {
          const entry = journal[String(sequence)];
          if (entry !== undefined) {
            if (entry.name === name && entry.args === argsJson) {
              replayed += 1;
              dispatches.push({ name, ok: !entry.isError, ms: 0, replayed: true });
              if (entry.isError) throw new ToolCallFailure(name, entry.text);
              return entry.text;
            }
            replaying = false;
            divergedAt = sequence;
          }
        }

        await gate.enter();
        const started = Date.now();
        try {
          // The call that asked for the approval gets the user's answer; the engine applies it
          // the way a resumed batch applies its answers.
          const approval = resume !== undefined && sequence === resume.pendingCall ? resume.answer : undefined;
          const promise = dispatch.call(name, args, approval !== undefined ? { approval } : undefined);
          inFlight.add(promise);
          let result;
          try {
            result = await promise;
          } finally {
            inFlight.delete(promise);
          }
          if (result.interrupt !== undefined && run.canPause()) {
            // Nobody can approve this now. Stop the program here; the run pauses once everything
            // still in flight has settled and been journaled.
            pause ??= { sequence, interrupt: result.interrupt };
            pauseController.abort();
            throw new ToolCallFailure(name, PAUSING);
          }
          const ms = Date.now() - started;
          const isError = result.isError === true;
          const text = textOf(result.content);
          dispatches.push({ name, ok: !isError, ms });
          journal[String(sequence)] = { name, args: argsJson, text, isError };
          const status = `tools.${name} -> ${isError ? "error" : "ok"} (${String(ms)} ms)`;
          ctx.onUpdate?.({ kind: "status", text: status });
          run.onLine(`[${status}]`);
          if (isError) throw new ToolCallFailure(name, text.length > 0 ? text : "the tool reported an error");
          for (const part of result.content) if (part.type === "image") images.push(part);
          return text;
        } finally {
          gate.leave();
        }
      };
    }

    const result = await options.runtime.run({
      program: run.code,
      bindings,
      globals: { ALL_TOOLS: schemas.map((schema) => ({ name: schema.name, description: briefOf(schema.description) })) },
      limits: {
        maxWallMs: limits.maxWallMs,
        maxComputeMs: limits.maxComputeMs,
        maxMemoryBytes: limits.maxMemoryBytes,
        maxOutputBytes: limits.maxOutputBytes,
      },
      signal,
      onLog: run.onLine,
    });

    if (pause !== undefined && options.journal !== undefined) {
      // Calls that were in flight when the pause hit finish and land in the journal too, so the
      // re-run replays them instead of repeating them.
      await Promise.allSettled([...inFlight]);
      await options.journal.set(journalKey, journal);
      return {
        kind: "paused",
        request: { ...pause.interrupt, sequence: pause.sequence, program: run.description },
        state: { version: 1, pendingCall: pause.sequence, journalKey },
      };
    }
    if (resume !== undefined && options.journal !== undefined) {
      // The program ran to its end: the journal has served its purpose.
      await options.journal.delete(journalKey).catch(() => undefined);
    }

    const details: RunCodeDetails = {
      dispatches,
      toolCalls: calls,
      truncated: result.truncated,
      replayed,
      ...(divergedAt !== undefined ? { divergedAt } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    const divergence = divergedAt !== undefined
      ? `\n\n[replay note: after an approval this program re-ran and stopped matching its journal at tool call ${String(divergedAt)}; calls before it were not repeated, calls from it on ran live]`
      : "";
    if (result.error !== undefined) {
      const where = result.error.line !== undefined ? ` at line ${String(result.error.line)}` : "";
      const captured = result.logs.length > 0 ? `\n\nCaptured output:\n${result.logs.join("\n")}` : "";
      return {
        kind: "result",
        isError: true,
        result: {
          content: [{ type: "text", text: `RunCode failed (${result.error.kind}${where}): ${result.error.message}${captured}${divergence}` }],
          isError: true,
          details,
        },
      };
    }
    const parts = [result.logs.join("\n"), renderValue(result.value)].filter((part) => part.length > 0);
    let text = parts.length > 0 ? parts.join("\n") : "(RunCode completed with no output)";
    if (result.truncated) {
      text += `\n\n[output cut at ${String(limits.maxOutputBytes)} bytes; summarize inside the program instead of returning raw data]`;
    }
    return { kind: "result", isError: false, result: { content: [{ type: "text", text: text + divergence }, ...images], details } };
  }
}

/**
 * The background log of a program: a file on the machine, rewritten with everything so far at
 * most every {@link LOG_FLUSH_INTERVAL_MS} while the program runs, and once more when it ends.
 * Writes are chained so a slow machine never sees them out of order.
 */
class TaskLog {
  private readonly lines: string[] = [];
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  readonly path: string;
  private readonly machine: Machine;
  private constructor(path: string, machine: Machine) {
    this.path = path;
    this.machine = machine;
  }

  static async open(machine: Machine): Promise<TaskLog> {
    return new TaskLog(await prepareBackgroundLog(machine), machine);
  }

  append(line: string): void {
    this.lines.push(line);
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, LOG_FLUSH_INTERVAL_MS);
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const content = `${this.lines.join("\n")}\n`;
    this.chain = this.chain.then(() => this.machine.writeText(this.path, content)).then(() => undefined, () => undefined);
  }

  /** Write everything out and wait for it; the log is complete when this resolves. */
  async close(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flush();
    await this.chain;
  }
}

/** The saved state and the user's answer when this call is the re-run of a paused one. */
function continuationOf(ctx: ToolRunContext): { readonly pendingCall: number; readonly journalKey: string; readonly answer: ApprovalResponse } | undefined {
  const resumed = ctx.resumed;
  if (resumed === undefined) return undefined;
  const state = resumed.state;
  if (!isRecord(state) || state.version !== 1 || typeof state.pendingCall !== "number" || typeof state.journalKey !== "string") return undefined;
  return { pendingCall: state.pendingCall, journalKey: state.journalKey, answer: approvalOf(resumed.answer) };
}

/** The answer as an `ApprovalResponse`; anything else counts as a rejection, never an approval. */
function approvalOf(answer: unknown): ApprovalResponse {
  if (isRecord(answer) && (answer.decision === "approved" || answer.decision === "rejected" || answer.decision === "cancelled")) {
    return {
      decision: answer.decision,
      ...(answer.scope === "session" ? { scope: "session" as const } : {}),
      ...(typeof answer.feedback === "string" ? { feedback: answer.feedback } : {}),
    };
  }
  return { decision: "rejected", feedback: "the answer to the approval request was not an approval response" };
}

/** At most `size` callers inside at once; the rest wait their turn in order. */
class Gate {
  private inside = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  async enter(): Promise<void> {
    if (this.inside < this.size) {
      this.inside += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inside += 1;
  }
  leave(): void {
    this.inside -= 1;
    this.waiting.shift()?.();
  }
}

function textOf(content: ToolResultContent): string {
  return content
    .filter((part): part is Extract<ToolResultContent[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function renderValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
