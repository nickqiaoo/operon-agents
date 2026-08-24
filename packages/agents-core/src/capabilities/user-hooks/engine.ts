import type { Machine } from "../../tool/machine.ts";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookBlockResult,
  type HookDef,
  type HookEventType,
  type HookRunResult,
  type HookTriggerArgs,
} from "./types.ts";

export class HookEngine {
  private readonly hooks: readonly HookDef[];
  private machine: Machine | null = null;

  constructor(hooks: readonly HookDef[]) {
    this.hooks = hooks;
  }

  attachMachine(machine: Machine): void {
    this.machine = machine;
  }

  has(event: HookEventType): boolean {
    return this.hooks.some((h) => h.event === event);
  }

  async triggerBlock(event: HookEventType, args: HookTriggerArgs = {}): Promise<HookBlockResult> {
    for (const hook of this.matching(event, args.matcherValue)) {
      const result = await this.runHook(hook, args).catch(() => undefined);
      if (result?.block) return { block: true, reason: result.reason };
    }
    return undefined;
  }

  async trigger(event: HookEventType, args: HookTriggerArgs = {}): Promise<string> {
    const out: string[] = [];
    for (const hook of this.matching(event, args.matcherValue)) {
      const result = await this.runHook(hook, args).catch(() => undefined);
      if (result?.stdout) out.push(result.stdout);
    }
    return out.join("\n");
  }

  fireAndForgetTrigger(event: HookEventType, args: HookTriggerArgs = {}): void {
    for (const hook of this.matching(event, args.matcherValue)) {
      void this.runHook(hook, args).catch(() => undefined);
    }
  }

  private matching(event: HookEventType, matcherValue: string | undefined): HookDef[] {
    const seen = new Set<string>();
    const out: HookDef[] = [];
    for (const hook of this.hooks) {
      if (hook.event !== event) continue;
      if (hook.matcher !== undefined && !this.matches(hook.matcher, matcherValue)) continue;
      if (seen.has(hook.command)) continue;
      seen.add(hook.command);
      out.push(hook);
    }
    return out;
  }

  private matches(pattern: string, value: string | undefined): boolean {
    if (value === undefined) return false;
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false; // a malformed matcher never matches (fail closed on the matcher only)
    }
  }

  /**
   * The hook's input data goes in on stdin and its timeout/cancellation are stated as
   * intent, so the backend enforces both with its own kill. A timeout still THROWS rather
   * than returning a verdict: every caller treats a thrown hook as "no opinion", and a
   * timed-out hook has no opinion to report.
   */
  private async runHook(hook: HookDef, args: HookTriggerArgs): Promise<HookRunResult> {
    if (!this.machine) throw new Error("HookEngine has no machine attached.");
    const timeoutMs = hook.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
    const shell = this.machine.osEnv.shellPath || "/bin/sh";
    const result = await this.machine.run([shell, "-c", hook.command], {
      stdin: JSON.stringify(args.inputData ?? {}),
      timeoutMs,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    if (result.timedOut) throw new Error(`hook timed out after ${timeoutMs}ms`);
    // No exit status = killed (abort) or a backend that cannot report one. Neither is a
    // verdict, so treat it the same as a throw rather than inventing a code.
    if (result.exitCode === undefined) throw new Error("hook did not report an exit status");
    return interpret(result.stdout, result.exitCode);
  }
}

function interpret(stdout: string, exitCode: number): HookRunResult {
  let block = exitCode !== 0;
  let reason: string | undefined = exitCode !== 0 ? stdout.trim() || `hook exited ${exitCode}` : undefined;

  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { block?: unknown; action?: unknown; decision?: unknown; reason?: unknown };
      if (parsed.block === true || parsed.action === "block" || parsed.decision === "block") {
        block = true;
        if (typeof parsed.reason === "string") reason = parsed.reason;
      }
    } catch {
      /* not JSON — treat as plain stdout */
    }
  }
  return { block, reason, stdout, exitCode };
}
