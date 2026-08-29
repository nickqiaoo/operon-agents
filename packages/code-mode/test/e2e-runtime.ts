/**
 * The QuickJS runtime on its own: what a program can do, what it cannot reach, and how every
 * limit ends it. Bindings here are plain host functions — the engine's tool pipeline is the
 * harness test's business.
 */
import { createQuickJSRuntime, ToolCallFailure } from "../src/index.ts";
import type { CodeBinding, CodeRunLimits, CodeRunResult } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runtime = createQuickJSRuntime();
const LIMITS: CodeRunLimits = { maxWallMs: 5_000, maxComputeMs: 2_000, maxMemoryBytes: 32 * 1024 * 1024, maxOutputBytes: 4_096 };

function run(
  program: string,
  bindings: Record<string, CodeBinding> = {},
  limits: Partial<CodeRunLimits> = {},
  signal?: AbortSignal,
): Promise<CodeRunResult> {
  return runtime.run({
    program,
    bindings,
    globals: { ALL_TOOLS: [{ name: "Read", description: "Reads a file." }] },
    limits: { ...LIMITS, ...limits },
    signal,
  });
}

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled += 1;
  });

  // ── the language ──
  {
    const r = await run("return 1 + 1");
    check("returns the program's value", r.value === 2 && r.error === undefined);
  }
  {
    const r = await run('console.log("a", { b: 1 }, 2, undefined);\nconsole.warn("w");');
    check("console.* lines are captured in order, non-strings as JSON", r.logs.join("|") === 'a {"b":1} 2 undefined|w' && r.value === undefined);
  }
  {
    const r = await run("const x: number = 2;\nconst y = x as number;\ninterface I { a: string }\nreturn y * 2;");
    check("type annotations, `as` and interfaces are stripped", r.value === 4);
  }
  {
    const r = await run("class C { n: number; constructor(n: number) { this.n = n } double() { return this.n * 2 } }\nfunction* g() { yield 1; yield 2 }\nreturn [new C(3).double(), ...g()]");
    check("classes, generators and spread work (a real engine, not a subset)", JSON.stringify(r.value) === "[6,1,2]");
  }
  {
    const r = await run("enum E { A }\nreturn 1");
    check("`enum` (non-erasable TypeScript) is a syntax failure", r.error?.kind === "syntax");
  }
  {
    const r = await run("const a = 1\nconst b = ;\nreturn a");
    check("a syntax error reports the model's line number", r.error?.kind === "syntax" && r.error.line === 2);
  }
  {
    const r = await run('const a = 1\nthrow new Error("boom")\n');
    check("a thrown error reports its message and line", r.error?.kind === "exception" && r.error.message.includes("boom") && r.error.line === 2);
  }

  // ── bindings ──
  {
    const r = await run('return await tools.Read({ path: "a" })', { Read: async (args) => `read:${String((args as { path: string }).path)}` });
    check("a binding receives plain-data args and resolves to its value", r.value === "read:a");
  }
  {
    const r = await run('return await tools.Echo({ n: 1, list: [1, "x", null], nested: { ok: true } })', { Echo: async (args) => args });
    check("structured values cross the boundary both ways", JSON.stringify(r.value) === '{"n":1,"list":[1,"x",null],"nested":{"ok":true}}');
  }
  {
    const started = Date.now();
    const r = await run(
      "const r = await Promise.all([tools.Slow({ ms: 120 }), tools.Slow({ ms: 120 }), tools.Slow({ ms: 120 })]);\nreturn r",
      { Slow: async (args) => { const ms = (args as { ms: number }).ms; await sleep(ms); return ms; } },
    );
    const elapsed = Date.now() - started;
    check("Promise.all runs bindings concurrently", JSON.stringify(r.value) === "[120,120,120]" && elapsed < 300);
  }
  {
    const r = await run(
      "const a = await tools.Step({ n: 1 });\nconst b = await tools.Step({ n: a + 1 });\nreturn b",
      { Step: async (args) => (args as { n: number }).n * 10 },
    );
    check("sequential awaits thread results through", r.value === 110);
  }
  {
    const r = await run(
      "try { await tools.Read({}) } catch (e) { return { name: e.name, tool: e.toolName, msg: e.message, inst: e instanceof ToolCallError, err: e instanceof Error } }",
      { Read: async () => { throw new ToolCallFailure("Read", "nope"); } },
    );
    check("a failed binding throws a catchable ToolCallError with toolName", JSON.stringify(r.value) === '{"name":"ToolCallError","tool":"Read","msg":"nope","inst":true,"err":true}');
  }
  {
    const r = await run("await tools.Read({})", { Read: async () => { throw new ToolCallFailure("Read", "nope"); } });
    check("an uncaught binding failure fails the program with the tool's message", r.error?.kind === "exception" && r.error.message.includes("nope"));
  }
  {
    const r = await run("try { await tools.Plain({}) } catch (e) { return [e.name, e.message] }", { Plain: async () => { throw new Error("generic"); } });
    check("a non-tool rejection is a plain Error", JSON.stringify(r.value) === '["Error","generic"]');
  }
  {
    let resolvedLate = false;
    const r = await run('tools.Slow({}); return "early"', { Slow: async () => { await sleep(60); resolvedLate = true; return 1; } });
    await sleep(120);
    check("an unawaited promise is discarded; its late settlement is harmless", r.value === "early" && resolvedLate && unhandled === 0);
  }
  {
    const r = await run("return { keys: Object.keys(tools), ctor: typeof tools.constructor, proto: Object.getPrototypeOf(tools) === null }", { Read: async () => "", constructor: async () => "own" });
    check("`tools` is null-prototype: a tool named constructor is an own property", JSON.stringify(r.value) === '{"keys":["Read","constructor"],"ctor":"function","proto":true}');
  }
  {
    const r = await run("return { n: ALL_TOOLS.length, name: ALL_TOOLS[0].name, frozen: Object.isFrozen(ALL_TOOLS) }");
    check("ALL_TOOLS is installed and frozen", JSON.stringify(r.value) === '{"n":1,"name":"Read","frozen":true}');
  }

  // ── confinement ──
  {
    const r = await run(
      "return { process: typeof process, require: typeof require, fetch: typeof fetch, timers: typeof setTimeout, names: Object.getOwnPropertyNames(globalThis).filter((n) => /process|require|fetch|Deno|Bun|std|os|module|Worker/.test(n)) }",
    );
    check("no process, require, fetch or timers exist in the guest", JSON.stringify(r.value) === '{"process":"undefined","require":"undefined","fetch":"undefined","timers":"undefined","names":[]}');
  }
  {
    const r = await run('try { await import("node:fs"); return "loaded" } catch (e) { return "blocked" }');
    check("dynamic import cannot load anything", r.value === "blocked");
  }
  {
    const r = await run("try { return ({}).constructor.constructor('return typeof process')() } catch (e) { return 'threw' }");
    check("the Function constructor reaches only the guest's own globals", r.value === "undefined");
  }
  {
    const r = await run("globalThis.leak = 42; return 1");
    const again = await run("return typeof globalThis.leak");
    check("nothing survives from one run to the next", r.value === 1 && again.value === "undefined");
  }

  // ── limits ──
  {
    const r = await run("for (;;) {}", {}, { maxComputeMs: 150, maxWallMs: 5_000 });
    check("a hot loop is stopped by the compute budget", r.error?.kind === "compute-limit");
  }
  {
    const r = await run("const a = []; for (;;) a.push(new Array(100000).fill(1))", {}, { maxMemoryBytes: 8 * 1024 * 1024, maxComputeMs: 5_000 });
    check("allocating past the heap cap is a memory failure", r.error?.kind === "memory-limit");
  }
  {
    const started = Date.now();
    const r = await run("await tools.Hang({})", { Hang: () => new Promise(() => undefined) }, { maxWallMs: 150 });
    check("waiting forever on a binding is stopped by the wall clock", r.error?.kind === "timeout" && Date.now() - started < 1_000);
  }
  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await run("await tools.Hang({})", { Hang: () => new Promise(() => undefined) }, {}, controller.signal);
    check("the caller's signal aborts a waiting program", r.error?.kind === "abort");
  }
  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await run("for (;;) { await tools.Tick({}) }", { Tick: async () => 1 }, { maxComputeMs: 5_000 }, controller.signal);
    check("the caller's signal aborts a running program between its tool calls", r.error?.kind === "abort");
  }
  {
    const r = await run("for (;;) {}", {}, { maxComputeMs: 300, maxWallMs: 5_000 }, AbortSignal.timeout(50));
    check("a signal cannot preempt a hot loop; the compute budget ends it", r.error?.kind === "compute-limit" || r.error?.kind === "abort");
  }
  {
    const r = await run('for (let i = 0; i < 1000; i++) console.log("x".repeat(100));\nreturn "done"', {}, { maxOutputBytes: 1_000 });
    check("logs past the output cap are cut and flagged; the return value still comes back", r.truncated && r.logs.length <= 11 && r.value === "done");
  }
  {
    const r = await run('return "y".repeat(5000)', {}, { maxOutputBytes: 1_000 });
    check("a return value past the cap is cut and flagged", r.truncated && typeof r.value === "string" && r.value.length <= 1_001);
  }
  {
    const r = await run("return () => 1");
    const big = await run("return 1n");
    check("a value that is not plain data is an invalid-output failure", r.error?.kind === "invalid-output" && big.error?.kind === "invalid-output");
  }
  {
    const r = await run("return (await tools.Big({})).length", { Big: async () => "z".repeat(300_000) });
    check("a large binding result crosses whole (only the outer output is capped)", r.value === 300_000);
  }
  {
    const r = await run("function f() { return f() + 1 }\ntry { f() } catch (e) { return e.name }");
    check("stack overflow is an ordinary catchable error", r.value === "RangeError" || r.value === "InternalError");
  }

  await runtime.dispose();
  check("no unhandled rejections escaped the runtime", unhandled === 0);

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ RUNTIME E2E PASS");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
