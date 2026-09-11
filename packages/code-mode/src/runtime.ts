/**
 * The code runtime: what Code Mode needs from "something that runs a program". The tool builds
 * the bindings and the limits; the runtime executes and reports. Neither knows the other's
 * internals, so a runtime is swappable — QuickJS ships (`runtime-quickjs.ts`); a worker or a
 * remote host could stand behind the same interface.
 *
 * The contract a runtime must keep, whatever it is built on: the program can reach NOTHING but
 * the bindings and globals it was given. No filesystem, no network, no process, no module
 * loading. Every effect a program has goes through a binding, and every binding is a tool call
 * that faces the same permissions as a direct one.
 */

/** A function the program calls as `tools.<name>(args)`; `args` arrives as plain data. */
export type CodeBinding = (args: unknown) => Promise<unknown>;

export interface CodeRunLimits {
  /** Wall-clock budget for the whole run, time spent awaiting tools included. */
  readonly maxWallMs: number;
  /** Budget for time spent executing the program's own JavaScript: a hot loop dies here, a slow tool does not. */
  readonly maxComputeMs: number;
  /** Heap the program may allocate inside the runtime. */
  readonly maxMemoryBytes: number;
  /** Combined size of captured logs plus the serialized return value; beyond it, output is cut. */
  readonly maxOutputBytes: number;
}

export interface CodeRunRequest {
  /** The program: the body of an async function, in erasable TypeScript. */
  readonly program: string;
  /** Functions exposed as `tools.<name>`. */
  readonly bindings: Readonly<Record<string, CodeBinding>>;
  /** Plain-data globals installed (frozen) before the program runs — `ALL_TOOLS`, for one. */
  readonly globals?: Readonly<Record<string, unknown>>;
  readonly limits: CodeRunLimits;
  readonly signal?: AbortSignal;
  /** Called with each `console.log` line as the program produces it (the same lines `logs` collects). */
  readonly onLog?: (line: string) => void;
}

export type CodeRunFailureKind =
  /** The program did not parse (TypeScript that is not erasable counts). */
  | "syntax"
  /** The program threw, or a tool call it did not catch rejected. */
  | "exception"
  /** `maxWallMs` elapsed. */
  | "timeout"
  /** `maxComputeMs` of JavaScript execution elapsed. */
  | "compute-limit"
  /** The program exhausted `maxMemoryBytes`. */
  | "memory-limit"
  /** The return value cannot be represented as plain data (a function, a BigInt, …). */
  | "invalid-output"
  /** The caller's `signal` fired. */
  | "abort";

export interface CodeRunFailure {
  readonly kind: CodeRunFailureKind;
  readonly message: string;
  /** 1-based line in the program as the model wrote it, when the runtime could tell. */
  readonly line?: number;
}

export interface CodeRunResult {
  /** `console.log` output, one entry per call, in order. */
  readonly logs: readonly string[];
  /** The program's return value as plain data; absent when it returned `undefined` or failed. */
  readonly value?: unknown;
  readonly error?: CodeRunFailure;
  /** True when logs or the value were cut to fit `maxOutputBytes`. */
  readonly truncated: boolean;
}

export interface CodeRuntime {
  /** What programs must be written in. */
  readonly language: "typescript";
  /** How programs are contained — informational, for a host choosing a runtime. */
  readonly isolation: string;
  run(request: CodeRunRequest): Promise<CodeRunResult>;
  /** Release what the runtime holds (a loaded WebAssembly module). Idempotent. */
  dispose(): Promise<void>;
}

/**
 * How a binding reports a failed tool call to the program. The runtime turns it into a
 * program-visible `ToolCallError` (with `.toolName`); any other rejection becomes a plain
 * `Error` carrying only its message.
 */
export class ToolCallFailure extends Error {
  readonly toolName: string;
  constructor(toolName: string, message: string) {
    super(message);
    this.name = "ToolCallFailure";
    this.toolName = toolName;
  }
}
