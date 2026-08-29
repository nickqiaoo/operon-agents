/**
 * The RunCode tool: takes the model's program, exposes this step's tools to it as `tools.*`,
 * runs it in the code runtime, and returns what the program printed or returned.
 *
 * Every `tools.X(args)` the program makes goes through `ToolRunContext.dispatch` — the engine's
 * own pipeline for a nested call — so it faces the same hooks and permissions a direct call
 * would. This file adds only the program-side policy: how many calls, how many at once, what a
 * binding resolves to (the tool's text), and how failures reach the program (`ToolCallError`).
 */
import { z } from "zod";
import { defineTool, ToolAccesses } from "operon-agents-core";
import type { ImageContent, Tool, ToolResult, ToolResultContent, ToolRunContext } from "operon-agents-core";
import { briefOf } from "./declarations.ts";
import { CODE_PARAM_DESCRIPTION, DESCRIPTION_PARAM_DESCRIPTION, RUN_CODE_NAME } from "./prompt.ts";
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

export interface RunCodeToolOptions {
  readonly runtime: CodeRuntime;
  readonly limits?: Partial<RunCodeLimits>;
  /** Tools a program may never call, on top of RunCode itself. */
  readonly exclude?: readonly string[];
  /** The description to advertise. The extension replaces it per request with the declarations rendered in. */
  readonly description: string;
}

/** One nested call, as the tool reports it in `details.dispatches` — the durable trace of a program. */
export interface RunCodeDispatch {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
}

export interface RunCodeDetails {
  readonly dispatches: readonly RunCodeDispatch[];
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly error?: CodeRunFailure;
}

const RunCodeInput = z.object({
  code: z.string().describe(CODE_PARAM_DESCRIPTION),
  description: z.string().describe(DESCRIPTION_PARAM_DESCRIPTION),
});

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
        run: (ctx) => execute(args.code, ctx),
      };
    },
  });

  async function execute(code: string, ctx: ToolRunContext): Promise<ToolResult> {
    const dispatch = ctx.dispatch;
    if (dispatch === undefined) {
      return errorResult("RunCode needs an engine that supports nested tool calls (ToolRunContext.dispatch); this one does not provide it.");
    }
    const schemas = dispatch.schemas.filter((schema) => !excluded.has(schema.name));
    const dispatches: RunCodeDispatch[] = [];
    const images: ImageContent[] = [];
    const gate = new Gate(limits.maxParallel);
    let calls = 0;

    const bindings: Record<string, CodeBinding> = {};
    for (const schema of schemas) {
      const name = schema.name;
      bindings[name] = async (args) => {
        if (ctx.signal.aborted) throw new ToolCallFailure(name, "the run was aborted");
        calls += 1;
        if (calls > limits.maxToolCalls) {
          throw new ToolCallFailure(name, `this program has reached its limit of ${String(limits.maxToolCalls)} tool calls`);
        }
        await gate.enter();
        const started = Date.now();
        try {
          const result = await dispatch.call(name, args);
          const ms = Date.now() - started;
          const isError = result.isError === true;
          dispatches.push({ name, ok: !isError, ms });
          ctx.onUpdate?.({ kind: "status", text: `tools.${name} -> ${isError ? "error" : "ok"} (${String(ms)} ms)` });
          const text = textOf(result.content);
          if (isError) throw new ToolCallFailure(name, text.length > 0 ? text : "the tool reported an error");
          for (const part of result.content) if (part.type === "image") images.push(part);
          return text;
        } finally {
          gate.leave();
        }
      };
    }

    const run = await options.runtime.run({
      program: code,
      bindings,
      globals: { ALL_TOOLS: schemas.map((schema) => ({ name: schema.name, description: briefOf(schema.description) })) },
      limits: {
        maxWallMs: limits.maxWallMs,
        maxComputeMs: limits.maxComputeMs,
        maxMemoryBytes: limits.maxMemoryBytes,
        maxOutputBytes: limits.maxOutputBytes,
      },
      signal: ctx.signal,
    });

    const details: RunCodeDetails = {
      dispatches,
      toolCalls: calls,
      truncated: run.truncated,
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
    if (run.error !== undefined) {
      const where = run.error.line !== undefined ? ` at line ${String(run.error.line)}` : "";
      const captured = run.logs.length > 0 ? `\n\nCaptured output:\n${run.logs.join("\n")}` : "";
      return {
        content: [{ type: "text", text: `RunCode failed (${run.error.kind}${where}): ${run.error.message}${captured}` }],
        isError: true,
        details,
      };
    }
    const parts = [run.logs.join("\n"), renderValue(run.value)].filter((part) => part.length > 0);
    let text = parts.length > 0 ? parts.join("\n") : "(RunCode completed with no output)";
    if (run.truncated) {
      text += `\n\n[output cut at ${String(limits.maxOutputBytes)} bytes; summarize inside the program instead of returning raw data]`;
    }
    return { content: [{ type: "text", text }, ...images], details };
  }
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

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
