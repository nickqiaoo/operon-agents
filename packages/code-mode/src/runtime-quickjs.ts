/**
 * The QuickJS runtime: the program runs inside a WebAssembly build of QuickJS (quickjs-ng),
 * loaded into this process. Confinement is by construction — the guest has the ECMAScript
 * built-ins and nothing else; there is no `require`, `process`, `fetch` or filesystem to reach,
 * because none of Node exists on that side. The only way out is a function this file installs.
 *
 * Every run gets a fresh runtime and context, torn down at the end, so nothing survives from
 * one program to the next and nothing else lives beside a program while it runs. Limits are
 * enforced by the engine: a heap cap, and an interrupt handler consulted while JavaScript
 * executes (a hot loop dies there; a program merely waiting on a tool is stopped by the wall
 * clock instead).
 *
 * Bindings cross the boundary as plain data. A host function hands the guest a pending
 * promise and returns; when the host side settles, the promise is resolved and the job queue
 * is pumped so the guest continues from its `await`.
 */
import { stripTypeScriptTypes } from "node:module";
import { newQuickJSWASMModuleFromVariant, Scope } from "quickjs-emscripten-core";
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSSyncVariant, QuickJSWASMModule } from "quickjs-emscripten-core";
import quickjsNg from "@jitl/quickjs-ng-wasmfile-release-sync";
import type { CodeRunFailure, CodeRunFailureKind, CodeRunRequest, CodeRunResult, CodeRuntime } from "./runtime.ts";

export interface QuickJSRuntimeOptions {
  /** The QuickJS build to load. Defaults to quickjs-ng, release, sync. */
  readonly variant?: QuickJSSyncVariant | Promise<QuickJSSyncVariant>;
  /** Stack the program may use, in bytes. Default 256 KiB — keep it well under 512 KiB (see DEFAULT_MAX_STACK_BYTES). */
  readonly maxStackBytes?: number;
}

// Well under the WebAssembly instance's native stack: the guest's own overflow check must fire first,
// or V8 throws a host RangeError from inside the engine and leaves it unusable (see the tests).
const DEFAULT_MAX_STACK_BYTES = 256 * 1024;
const PROGRAM_FILENAME = "program.ts";
/** The program becomes the body of this async IIFE; its one leading line offsets error lines by one. */
const WRAPPER_HEAD = "(async () => {\n";
const WRAPPER_TAIL = "\n})()";
const WRAPPER_LINES = 1;

/**
 * Defines `ToolCallError` for programs and hands the host a factory for it, so a binding's
 * failure reaches the program as a real instance (`instanceof ToolCallError`, `.toolName`).
 */
const PRELUDE = `(() => {
  class ToolCallError extends Error {
    constructor(toolName, message) {
      super(message);
      this.name = "ToolCallError";
      this.toolName = toolName;
    }
  }
  Object.defineProperty(globalThis, "ToolCallError", { value: ToolCallError, configurable: false, enumerable: false });
  return (toolName, message) => new ToolCallError(toolName, message);
})()`;

export function createQuickJSRuntime(options: QuickJSRuntimeOptions = {}): CodeRuntime {
  let modulePromise: Promise<QuickJSWASMModule> | undefined;
  const load = (): Promise<QuickJSWASMModule> => (modulePromise ??= newQuickJSWASMModuleFromVariant(options.variant ?? quickjsNg));
  // An engine assertion during teardown (quickjs-ng trips one after a stack overflow inside an
  // async function) aborts the WebAssembly instance for good; the next run loads a fresh one.
  const invalidate = (): void => {
    modulePromise = undefined;
  };
  const maxStackBytes = options.maxStackBytes ?? DEFAULT_MAX_STACK_BYTES;
  return {
    language: "typescript",
    isolation: "wasm",
    async run(request) {
      return runProgram(await load(), request, maxStackBytes, invalidate);
    },
    async dispose() {
      // The module holds only WebAssembly memory; dropping the reference lets it be collected.
      modulePromise = undefined;
    },
  };
}

async function runProgram(module: QuickJSWASMModule, request: CodeRunRequest, maxStackBytes: number, invalidate: () => void): Promise<CodeRunResult> {
  const output = new OutputLedger(request.limits.maxOutputBytes);
  const compiled = compile(request.program);
  if (compiled.error !== undefined) return { logs: [], truncated: false, error: compiled.error };

  const runtime = module.newRuntime();
  runtime.setMemoryLimit(request.limits.maxMemoryBytes);
  runtime.setMaxStackSize(maxStackBytes);
  const clock = new ComputeClock(request.limits.maxComputeMs);
  const deadline = Date.now() + request.limits.maxWallMs;
  /** Set by whichever limit fires first; the interrupt handler then stops any further execution. */
  let stop: CodeRunFailure | undefined;
  let announceHalt: (failure: CodeRunFailure) => void = () => undefined;
  /** Resolves when a limit ends the run — whether the wall clock, the signal, or the interrupt handler saw it first. */
  const halted = new Promise<{ readonly kind: "limit"; readonly failure: CodeRunFailure }>((resolve) => {
    announceHalt = (failure) => resolve({ kind: "limit", failure });
  });
  const halt = (failure: CodeRunFailure): void => {
    if (stop !== undefined) return;
    stop = failure;
    announceHalt(failure);
  };
  runtime.setInterruptHandler(() => {
    if (stop !== undefined) return true;
    if (request.signal?.aborted) halt({ kind: "abort", message: "the run was aborted" });
    else if (Date.now() > deadline) halt({ kind: "timeout", message: `the program exceeded its ${String(request.limits.maxWallMs)} ms wall-clock budget` });
    else if (clock.exhausted()) halt({ kind: "compute-limit", message: `the program spent more than ${String(request.limits.maxComputeMs)} ms executing JavaScript` });
    return stop !== undefined;
  });

  const context = runtime.newContext();
  const scope = new Scope();
  const deferreds = new Set<QuickJSDeferredPromise>();
  const limit = waitForLimit(request.signal, deadline, halt);
  const pump = (): void => {
    if (!context.alive || stop !== undefined) return;
    clock.measure(() => {
      const jobs = runtime.executePendingJobs();
      // A job that throws is an unhandled rejection of some promise the program never awaited;
      // the program's own outcome still arrives through its returned promise, so this is noise.
      if (jobs.error) jobs.error.dispose();
      else jobs.dispose();
    });
  };

  try {
    const makeToolCallError = scope.manage(unwrap(context, context.evalCode(PRELUDE, "prelude.js", { type: "global" })));
    const jsonParse = scope.manage(context.getProp(scope.manage(context.getProp(context.global, "JSON")), "parse"));
    const fromData = (value: unknown): QuickJSHandle => dataToHandle(context, jsonParse, value);
    installConsole(context, scope, output);
    installGlobals(context, scope, fromData, request.globals ?? {});
    installBindings(context, scope, request, {
      deferreds,
      fromData,
      pump,
      makeToolCallError,
      alive: () => context.alive && stop === undefined,
    });

    const evaluated = clock.measure(() => context.evalCode(compiled.source, PROGRAM_FILENAME, { type: "global", strict: true }));
    if (evaluated.error) {
      const failure = classifyError(context, evaluated.error, stop);
      evaluated.error.dispose();
      return { logs: output.logs, truncated: output.truncated, error: failure };
    }
    const programPromise = scope.manage(evaluated.value);
    // Subscribing to the program's promise queues a job on the guest side; pump so a program
    // that already finished (no binding ever pumps for it) settles the host promise now.
    const settling = context.resolvePromise(programPromise).then(
      (result) => ({ kind: "settled" as const, result, hostError: undefined }),
      (error: unknown) => ({ kind: "settled" as const, result: undefined, hostError: error }),
    );
    pump();

    const outcome = await Promise.race([settling, limit.promise, halted]);
    if (outcome.kind === "limit" || stop !== undefined) {
      return { logs: output.logs, truncated: output.truncated, error: stop ?? { kind: "timeout", message: "the program timed out" } };
    }
    if (outcome.result === undefined) {
      return { logs: output.logs, truncated: output.truncated, error: { kind: "exception", message: messageOf(outcome.hostError) } };
    }
    if (outcome.result.error) {
      const failure = classifyError(context, outcome.result.error, stop);
      outcome.result.error.dispose();
      return { logs: output.logs, truncated: output.truncated, error: failure };
    }
    const valueType = context.typeof(outcome.result.value);
    const value: unknown = valueType === "function" || valueType === "symbol" ? INVALID_VALUE : context.dump(outcome.result.value);
    outcome.result.value.dispose();
    return output.finish(value);
  } catch (error) {
    // The engine itself failed — a WebAssembly trap, a host-side stack overflow the guest's own
    // check did not catch first. The instance cannot be trusted afterwards; reload it next time.
    invalidate();
    return {
      logs: output.logs,
      truncated: output.truncated,
      error: { kind: "exception", message: `the runtime failed: ${messageOf(error)}` },
    };
  } finally {
    limit.cancel();
    for (const deferred of deferreds) {
      if (deferred.alive) deferred.dispose();
    }
    try {
      scope.dispose();
      context.dispose();
      runtime.dispose();
    } catch {
      // The instance is unusable after an engine abort; the result computed above still stands.
      invalidate();
    }
  }
}

// ── compile ───────────────────────────────────────────────────────────────────────────────────

function compile(program: string): { readonly source: string; readonly error?: undefined } | { readonly source?: undefined; readonly error: CodeRunFailure } {
  try {
    // Strip-only: type annotations become whitespace, positions are preserved, and TypeScript
    // that needs transformation (`enum`, namespaces) is rejected — which the prompt promises.
    const source = stripTypeScriptTypes(WRAPPER_HEAD + program + WRAPPER_TAIL, { mode: "strip" });
    return { source };
  } catch (error) {
    const message = messageOf(error);
    // Node reports the position at the head of `stack` (":<line>" then a code frame), not in `message`.
    const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
    const position = /^:(\d+)\n/.exec(stack);
    const line = position !== null ? Number(position[1]) - WRAPPER_LINES : undefined;
    return {
      error: {
        kind: "syntax",
        message: message.split("\n", 1)[0] ?? message,
        ...(line !== undefined && line >= 1 ? { line } : {}),
      },
    };
  }
}

// ── the guest's world ─────────────────────────────────────────────────────────────────────────

function installConsole(context: QuickJSContext, scope: Scope, output: OutputLedger): void {
  const console = scope.manage(context.newObject());
  const log = scope.manage(
    context.newFunction("log", (...args) => {
      output.log(args.map((arg) => formatLogArg(context.dump(arg))).join(" "));
    }),
  );
  for (const method of ["log", "info", "warn", "error", "debug"]) context.setProp(console, method, log);
  context.setProp(context.global, "console", console);
}

function installGlobals(context: QuickJSContext, scope: Scope, fromData: (value: unknown) => QuickJSHandle, globals: Readonly<Record<string, unknown>>): void {
  const freeze = scope.manage(context.getProp(scope.manage(context.getProp(context.global, "Object")), "freeze"));
  for (const [name, value] of Object.entries(globals)) {
    Scope.withScope((inner) => {
      const handle = inner.manage(fromData(value));
      inner.manage(unwrap(context, context.callFunction(freeze, context.undefined, [handle])));
      context.defineProp(context.global, name, { value: handle, configurable: false, enumerable: false });
    });
  }
}

interface BindingHost {
  readonly deferreds: Set<QuickJSDeferredPromise>;
  readonly fromData: (value: unknown) => QuickJSHandle;
  readonly pump: () => void;
  readonly makeToolCallError: QuickJSHandle;
  readonly alive: () => boolean;
}

function installBindings(context: QuickJSContext, scope: Scope, request: CodeRunRequest, host: BindingHost): void {
  // Null-prototype: a tool named `constructor` or `__proto__` must land as an own property.
  const tools = scope.manage(unwrap(context, context.evalCode("Object.create(null)", "tools.js", { type: "global" })));
  for (const [name, binding] of Object.entries(request.bindings)) {
    const fn = scope.manage(
      context.newFunction(name, (argHandle) => {
        const args: unknown = argHandle === undefined ? undefined : context.dump(argHandle);
        const deferred = context.newPromise();
        host.deferreds.add(deferred);
        deferred.settled.then(
          () => {
            host.deferreds.delete(deferred);
            if (deferred.alive) deferred.dispose();
            host.pump();
          },
          () => undefined,
        );
        // Settling on a fresh macrotask: a program looping over an instantly-resolving binding
        // would otherwise starve the event loop, and with it the wall clock and the abort signal.
        Promise.resolve()
          .then(() => binding(args))
          .then((value) => new Promise<unknown>((resolve) => setImmediate(() => resolve(value))))
          .then(
            (value) => {
              if (!host.alive() || !deferred.alive) return;
              Scope.withScope((inner) => {
                deferred.resolve(inner.manage(host.fromData(value)));
              });
            },
            (error: unknown) => {
              if (!host.alive() || !deferred.alive) return;
              Scope.withScope((inner) => {
                deferred.reject(inner.manage(errorToHandle(context, host.makeToolCallError, error)));
              });
            },
          );
        return deferred.handle;
      }),
    );
    context.defineProp(tools, name, { value: fn, configurable: false, enumerable: true });
  }
  context.defineProp(context.global, "tools", { value: tools, configurable: false, enumerable: false });
}

// ── values across the boundary ────────────────────────────────────────────────────────────────

/** Plain data → guest value, by way of the guest's own `JSON.parse`. */
function dataToHandle(context: QuickJSContext, jsonParse: QuickJSHandle, value: unknown): QuickJSHandle {
  if (value === undefined) return context.undefined;
  if (value === null) return context.null;
  if (typeof value === "string") return context.newString(value);
  if (typeof value === "number") return context.newNumber(value);
  if (typeof value === "boolean") return value ? context.true : context.false;
  const json = JSON.stringify(value);
  if (json === undefined) return context.undefined;
  return Scope.withScope((scope) => {
    const text = scope.manage(context.newString(json));
    return unwrap(context, context.callFunction(jsonParse, context.undefined, [text]));
  });
}

function errorToHandle(context: QuickJSContext, makeToolCallError: QuickJSHandle, error: unknown): QuickJSHandle {
  const toolName = isRecord(error) && typeof error.toolName === "string" ? error.toolName : undefined;
  const message = messageOf(error);
  if (toolName === undefined) return context.newError(message);
  return Scope.withScope((scope) => {
    const name = scope.manage(context.newString(toolName));
    const text = scope.manage(context.newString(message));
    return unwrap(context, context.callFunction(makeToolCallError, context.undefined, [name, text]));
  });
}

interface GuestResult<T> {
  readonly error?: QuickJSHandle;
  readonly value?: T;
}

function unwrap<T>(context: QuickJSContext, result: GuestResult<T>): T {
  if (result.error !== undefined) {
    const dumped: unknown = context.dump(result.error);
    result.error.dispose();
    throw new Error(`QuickJS: ${isRecord(dumped) && typeof dumped.message === "string" ? dumped.message : String(dumped)}`);
  }
  return result.value as T;
}

/** Turn a guest exception into a failure the model can act on, preferring a limit that fired. */
function classifyError(context: QuickJSContext, errorHandle: QuickJSHandle, stop: CodeRunFailure | undefined): CodeRunFailure {
  if (stop !== undefined) return stop;
  const dumped: unknown = context.dump(errorHandle);
  const record = isRecord(dumped) ? dumped : { message: dumped };
  const name = typeof record.name === "string" ? record.name : "Error";
  const message = typeof record.message === "string" ? record.message : String(dumped);
  const stack = typeof record.stack === "string" ? record.stack : "";
  const line = lineFromStack(stack);
  let kind: CodeRunFailureKind = "exception";
  if (name === "SyntaxError") kind = "syntax";
  else if (name === "InternalError" && /out of memory/i.test(message)) kind = "memory-limit";
  else if (name === "InternalError" && /interrupted/i.test(message)) kind = "abort";
  const text = name === "Error" || kind !== "exception" ? message : `${name}: ${message}`;
  return { kind, message: text, ...(line !== undefined ? { line } : {}) };
}

const STACK_LINE = new RegExp(`${PROGRAM_FILENAME.replace(".", "\\.")}:(\\d+)`);

function lineFromStack(stack: string): number | undefined {
  const match = STACK_LINE.exec(stack);
  if (match === null) return undefined;
  const line = Number(match[1]) - WRAPPER_LINES;
  return line >= 1 ? line : undefined;
}

// ── limits ────────────────────────────────────────────────────────────────────────────────────

/** Time spent inside the engine, measured around every entry into it. */
class ComputeClock {
  private used = 0;
  private sliceStart: number | undefined;
  private readonly budgetMs: number;
  constructor(budgetMs: number) {
    this.budgetMs = budgetMs;
  }
  measure<T>(fn: () => T): T {
    const outer = this.sliceStart;
    const start = Date.now();
    this.sliceStart = start;
    try {
      return fn();
    } finally {
      this.used += Date.now() - start;
      this.sliceStart = outer;
    }
  }
  exhausted(): boolean {
    const running = this.sliceStart === undefined ? 0 : Date.now() - this.sliceStart;
    return this.used + running > this.budgetMs;
  }
}

interface LimitWatch {
  /** Resolves when the wall clock or the caller's signal ends the run before the program does. */
  readonly promise: Promise<{ readonly kind: "limit"; readonly failure: CodeRunFailure }>;
  /** Stop watching: the program settled first. */
  cancel(): void;
}

function waitForLimit(signal: AbortSignal | undefined, deadline: number, halt: (failure: CodeRunFailure) => void): LimitWatch {
  let cancel = (): void => undefined;
  const promise = new Promise<{ readonly kind: "limit"; readonly failure: CodeRunFailure }>((resolve) => {
    const settle = (failure: CodeRunFailure): void => {
      halt(failure);
      resolve({ kind: "limit", failure });
    };
    const timer = setTimeout(
      () => settle({ kind: "timeout", message: "the program exceeded its wall-clock budget" }),
      Math.max(0, deadline - Date.now()),
    );
    const onAbort = (): void => settle({ kind: "abort", message: "the run was aborted" });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
  });
  return { promise, cancel };
}

/** Sentinel for a return value that cannot cross the boundary at all. */
const INVALID_VALUE: unique symbol = Symbol("invalid-value");

/**
 * Captured output under one byte cap shared by the logs and the return value. The return value
 * has priority: when it fits the cap on its own, logs are dropped from the end to make room,
 * because the value is what the program was asked for and logs are commentary.
 */
class OutputLedger {
  readonly logs: string[] = [];
  truncated = false;
  private used = 0;
  private readonly capBytes: number;
  constructor(capBytes: number) {
    this.capBytes = capBytes;
  }
  log(line: string): void {
    if (this.truncated) return;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (this.used + bytes > this.capBytes) {
      const room = Math.max(0, this.capBytes - this.used - 1);
      if (room > 0) this.logs.push(Buffer.from(line, "utf8").subarray(0, room).toString("utf8"));
      this.used = this.capBytes;
      this.truncated = true;
      return;
    }
    this.logs.push(line);
    this.used += bytes;
  }
  finish(value: unknown): CodeRunResult {
    if (value === undefined) return { logs: this.logs, truncated: this.truncated };
    if (value === INVALID_VALUE) {
      return { logs: this.logs, truncated: this.truncated, error: { kind: "invalid-output", message: "the return value is not plain data (a function or a symbol)" } };
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      return { logs: this.logs, truncated: this.truncated, error: { kind: "invalid-output", message: `the return value is not plain data: ${messageOf(error)}` } };
    }
    if (json === undefined) {
      return { logs: this.logs, truncated: this.truncated, error: { kind: "invalid-output", message: "the return value is not plain data (a function or a symbol)" } };
    }
    const valueBytes = Buffer.byteLength(json, "utf8");
    if (valueBytes > this.capBytes) {
      const cut = Buffer.from(json, "utf8").subarray(0, Math.max(0, this.capBytes - 1)).toString("utf8");
      return { logs: [], truncated: true, value: `${cut}…` };
    }
    while (this.used + valueBytes > this.capBytes && this.logs.length > 0) {
      const dropped = this.logs.pop() ?? "";
      this.used = Math.max(0, this.used - Buffer.byteLength(dropped, "utf8") - 1);
      this.truncated = true;
    }
    return { logs: this.logs, truncated: this.truncated, value: JSON.parse(json) as unknown };
  }
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────

function formatLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
