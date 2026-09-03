/**
 * Unit-style coverage for capabilities/assembler.ts (assembleCapabilities /
 * AssembledCapabilities) — previously zero test coverage despite being the fault
 * isolation boundary every capability's start/stop/toolProvider goes through.
 *
 * Covers:
 *  - start() fault isolation: one capability throwing doesn't stop the others, and its
 *    contributions are not absorbed.
 *  - start() now has a timeout (regression test for the bug where a hung start() blocked
 *    the whole session from ever opening — stop() had a timeout, start() didn't).
 *  - stop() fault isolation + timeout, reverse order.
 *  - duplicate capability names are rejected with a diagnostic, not a silent overwrite.
 *  - listTools() isolates a failing toolProvider from the others.
 */
import { NullMachine, type Tool } from "../index.ts";
import { assembleCapabilities, type AssembleCapabilitiesOptions } from "../internal.ts";
import type { Capability, RunContext } from "../capabilities/capability.ts";
import { testRunContext } from "./faux.ts";
import type { ToolProvider } from "../capabilities/tool-provider.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function baseCtx(): RunContext {
  return testRunContext({ machine: new NullMachine() });
}

function fakeTool(name: string): Tool {
  return {
    schema: { name, description: name, parameters: {} },
    resolve: () => ({ approvalRule: name, run: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assemble(caps: Capability[], options?: AssembleCapabilitiesOptions) {
  return assembleCapabilities(caps, baseCtx(), options);
}

async function main(): Promise<void> {
  // ── start() fault isolation ──
  {
    const good: Capability = { name: "good", tools: [fakeTool("Good")] };
    const bad: Capability = {
      name: "bad",
      tools: [fakeTool("Bad")],
      start: () => {
        throw new Error("boom");
      },
    };
    const assembled = await assemble([bad, good]);
    const tools = await assembled.listTools();
    check("start() fault isolation: failing capability produces a diagnostic", assembled.diagnostics.some((d) => d.capability === "bad" && d.phase === "start" && d.level === "error"));
    check("start() fault isolation: failing capability's tools are NOT absorbed", !tools.some((t) => t.schema.name === "Bad"));
    check("start() fault isolation: other capability still starts and its tools ARE absorbed", tools.some((t) => t.schema.name === "Good"));
  }

  // ── start() timeout: a hung start() must not block assembly forever ──
  {
    const hung: Capability = { name: "hung", start: () => new Promise(() => {}) };
    const good: Capability = { name: "good", tools: [fakeTool("Good")] };
    const startedAt = Date.now();
    const assembled = await assemble([hung, good], { startTimeoutMs: 30 });
    const elapsed = Date.now() - startedAt;
    check("start() timeout: assembly completes instead of hanging forever", elapsed < 5000);
    check(
      "start() timeout: hung capability produces a timeout diagnostic",
      assembled.diagnostics.some((d) => d.capability === "hung" && d.phase === "start" && /timed out/.test(d.message)),
    );
    const tools = await assembled.listTools();
    check("start() timeout: later capability after a hung one still starts", tools.some((t) => t.schema.name === "Good"));
  }

  // ── duplicate capability names ──
  {
    const first: Capability = { name: "dup", tools: [fakeTool("First")] };
    const second: Capability = { name: "dup", tools: [fakeTool("Second")] };
    const assembled = await assemble([first, second]);
    const tools = await assembled.listTools();
    check(
      "duplicate name: second registration produces a register-phase diagnostic",
      assembled.diagnostics.some((d) => d.capability === "dup" && d.phase === "register"),
    );
    check("duplicate name: only the first registration's tools are absorbed", tools.some((t) => t.schema.name === "First") && !tools.some((t) => t.schema.name === "Second"));
  }

  // ── stop() fault isolation + timeout, reverse order ──
  {
    const order: string[] = [];
    const a: Capability = {
      name: "a",
      stop: () => {
        order.push("a");
      },
    };
    const b: Capability = {
      name: "b",
      stop: () => {
        throw new Error("stop boom");
      },
    };
    const c: Capability = { name: "c", stop: () => new Promise(() => {}) };
    const assembled = await assemble([a, b, c], { stopTimeoutMs: 30 });
    await assembled.stop();
    check("stop(): non-throwing capabilities still run despite a throwing sibling", order.includes("a"));
    check("stop(): throwing capability produces a stop-phase diagnostic", assembled.diagnostics.some((d) => d.capability === "b" && d.phase === "stop"));
    check("stop(): hung capability times out and produces a diagnostic instead of hanging stop()", assembled.diagnostics.some((d) => d.capability === "c" && d.phase === "stop" && /timed out/.test(d.message)));
  }

  // ── start()/stop() cancellation: the timeout ABORTS the straggler, not just races it ──
  {
    let startAborted = false;
    let stopAborted = false;
    const slowStart: Capability = {
      name: "slow-start",
      start: (_ctx, signal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => {
            startAborted = true;
            reject(signal.reason as Error);
          });
        }),
    };
    const slowStop: Capability = {
      name: "slow-stop",
      stop: (signal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => {
            stopAborted = true;
            reject(signal.reason as Error);
          });
        }),
    };
    const assembled = await assemble([slowStart, slowStop], { startTimeoutMs: 30, stopTimeoutMs: 30 });
    await assembled.stop();
    // Give the abort listeners a tick to run (the race resolves before the reject lands).
    await delay(10);
    check("start() timeout aborts the straggling start (signal fired)", startAborted);
    check("stop() timeout aborts the straggling stop (signal fired)", stopAborted);
  }

  // ── listTools(): a failing toolProvider is isolated from the others ──
  {
    const failingProvider: ToolProvider = {
      id: "failing",
      listTools: () => {
        throw new Error("list boom");
      },
    };
    const okProvider: ToolProvider = {
      id: "ok",
      listTools: async () => {
        await delay(1);
        return [fakeTool("FromProvider")];
      },
    };
    const withProviders: Capability = { name: "providers", toolProviders: [failingProvider, okProvider] };
    const assembled = await assemble([withProviders]);
    const tools = await assembled.listTools();
    check("listTools(): failing provider produces a diagnostic instead of throwing", assembled.diagnostics.some((d) => d.capability === "failing"));
    check("listTools(): other provider's tools still come through", tools.some((t) => t.schema.name === "FromProvider"));
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — capability assembler fault isolation + timeouts");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
