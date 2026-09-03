import type { BeforeRunHook, LoopHooks, ShouldContinueAfterStopHook } from "../loop/types.ts";
import type { Tool } from "../tool/types.ts";
import type { AssembledGates, Capability, RunContext, CapabilityDiagnostic, CompactionGate, ToolFilter } from "./capability.ts";
import { InjectionManager } from "./injection.ts";
import type { ToolProvider } from "./tool-provider.ts";

const STOP_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 10_000;

export interface AssembleCapabilitiesOptions {
  /** Max time to wait for a single capability's start(). Default 10s. */
  readonly startTimeoutMs?: number;
  /** Max time to wait for a single capability's stop(). Default 5s. */
  readonly stopTimeoutMs?: number;
}

export class AssembledCapabilities {
  readonly diagnostics: CapabilityDiagnostic[] = [];
  readonly loopHookParts: Array<Partial<LoopHooks>> = [];
  readonly boundaryContinuations: ShouldContinueAfterStopHook[] = [];
  readonly runStarts: BeforeRunHook[] = [];
  /**
   * Stable arrays handed to `RunContext.gates`. Capabilities are started and absorbed one
   * at a time, so a consumer that snapshotted at `start()` would miss every gate registered by a
   * capability ordered after it — reading through this live reference avoids depending on order.
   */
  readonly gates: AssembledGates = { compaction: [] as CompactionGate[] };
  readonly injection = new InjectionManager();

  private readonly staticTools: Tool[] = [];
  private readonly toolProviders: ToolProvider[] = [];
  private readonly toolFilters: ToolFilter[] = [];
  private readonly started: Capability[] = [];
  private readonly ctx: RunContext;
  private readonly stopTimeoutMs: number;

  constructor(base: Omit<RunContext, "injection" | "gates">, options: AssembleCapabilitiesOptions = {}) {
    this.ctx = { ...base, injection: this.injection, gates: this.gates };
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  }

  /** The run context handed to every capability's `start` and tool provider. */
  get context(): RunContext {
    return this.ctx;
  }

  async listTools(): Promise<Tool[]> {
    const tools = [...this.staticTools];
    for (const provider of this.toolProviders) {
      try {
        tools.push(...(await provider.listTools(this.ctx)));
      } catch (error) {
        this.diagnostics.push({
          capability: provider.id,
          phase: "start",
          level: "warn",
          message: `toolProvider "${provider.id}" listTools failed: ${messageOf(error)}`,
        });
      }
    }
    return tools;
  }

  /** Apply every capability's tool filter in registration order. A thrower is skipped. */
  applyToolFilters(tools: readonly Tool[]): readonly Tool[] {
    let current = tools;
    for (const filter of this.toolFilters) {
      try {
        current = filter(current);
      } catch (error) {
        this.diagnostics.push({
          capability: "toolFilter",
          phase: "start",
          level: "warn",
          message: `tool filter failed; toolset left unchanged: ${messageOf(error)}`,
        });
      }
    }
    return current;
  }

  private absorb(capability: Capability): void {
    for (const tool of capability.tools ?? []) this.staticTools.push(tool);
    for (const provider of capability.toolProviders ?? []) this.toolProviders.push(provider);
    for (const filter of capability.toolFilters ?? []) this.toolFilters.push(filter);
    if (capability.gates?.compaction) (this.gates.compaction as CompactionGate[]).push(capability.gates.compaction);

    // capability.policies are session-tier contributions — collected once by
    // Session.buildPermissionManager (the manager is session-lived), not per run.

    if (capability.hooks) {
      // Run-tier hooks are driven by the Runner itself, not composed into the step machine.
      const { shouldContinueAfterStop, beforeRun, ...loopHooks } = capability.hooks;
      if (Object.keys(loopHooks).length > 0) this.loopHookParts.push(loopHooks);
      if (shouldContinueAfterStop) this.boundaryContinuations.push(shouldContinueAfterStop);
      if (beforeRun) this.runStarts.push(beforeRun);
    }

    this.injection.registerAll(capability.injectors ?? []);
  }

  markStarted(capability: Capability): void {
    this.started.push(capability);
  }

  async stop(): Promise<void> {
    for (const capability of [...this.started].reverse()) {
      if (!capability.stop) continue;
      try {
        // The timeout races AND aborts: the run stops waiting at the deadline, and the
        // straggling stop() is told to release its resources instead of running on
        // unobserved in the background (cancellation is cooperative — see Capability.stop).
        const cancel = new AbortController();
        await withTimeout(Promise.resolve(capability.stop(cancel.signal)), this.stopTimeoutMs, cancel);
      } catch (error) {
        this.diagnostics.push({
          capability: capability.name,
          phase: "stop",
          level: "warn",
          message: `stop failed/timed out: ${messageOf(error)}`,
        });
      }
    }
  }

  // Internal: expose absorb to the assemble function.
  _absorb(capability: Capability): void {
    this.absorb(capability);
  }
}

export async function assembleCapabilities(
  capabilities: readonly Capability[],
  ctx: Omit<RunContext, "injection" | "gates">,
  options: AssembleCapabilitiesOptions = {},
): Promise<AssembledCapabilities> {
  const assembled = new AssembledCapabilities(ctx, options);
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const seenNames = new Set<string>();
  // The live injection manager + gate arrays ride along so a capability like compaction can
  // resync injector watermarks after collapsing the prefix.
  const startCtx = assembled.context;

  for (const capability of capabilities) {
    if (seenNames.has(capability.name)) {
      assembled.diagnostics.push({
        capability: capability.name,
        phase: "register",
        level: "error",
        message: `duplicate capability name "${capability.name}"; second registration skipped.`,
      });
      continue;
    }
    seenNames.add(capability.name);

    try {
      if (capability.start) {
        // Same contract as stop(): the deadline wins the race, and the losing start()
        // is aborted so it can release partially acquired resources.
        const cancel = new AbortController();
        await withTimeout(Promise.resolve(capability.start(startCtx, cancel.signal)), startTimeoutMs, cancel);
      }
    } catch (error) {
      assembled.diagnostics.push({
        capability: capability.name,
        phase: "start",
        level: "error",
        message: `start failed/timed out; capability absent: ${messageOf(error)}`,
      });
      continue; // fault isolation — none of its contributions register
    }

    assembled.markStarted(capability);
    assembled._absorb(capability);
  }

  return assembled;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, cancel?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`timed out after ${ms}ms`);
      cancel?.abort(error);
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
