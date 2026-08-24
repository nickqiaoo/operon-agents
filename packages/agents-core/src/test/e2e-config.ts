import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  Runner,
  LocalMachine,
  parseConfig,
  mergeConfigs,
  ModelCatalog,
  UNKNOWN_CAPABILITY,
  Flags,
  toCoreOptions,
  layeredResolver,
  resolveCoreOptions,
  writeTool,
  type Message,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function testLayeredMerge(): void {
  const merged = mergeConfigs(
    { defaultModel: "a", permission: { rules: [{ decision: "allow", scope: "user", pattern: "Read" }] }, flags: { x: true } },
    { defaultModel: "b", permission: { rules: [{ decision: "deny", scope: "project", pattern: "Bash" }] }, flags: { y: true } },
  );
  check("merge: later layer overrides scalar", merged.defaultModel === "b");
  check("merge: permission rules concatenate across layers", merged.permission.rules.length === 2);
  check("merge: flags deep-merge", merged.flags.x === true && merged.flags.y === true);
}

function testModelCatalog(): void {
  const config = parseConfig({
    models: { fast: { provider: "anthropic", model: "claude-x", maxContextSize: 200000, capabilities: ["vision"] } },
  });
  const cat = new ModelCatalog(config.models);
  check("catalog: maxContextSize lookup", cat.maxContextSize("fast") === 200000);
  check("catalog: capability tag lookup", cat.has("fast", "vision") && !cat.has("fast", "video"));
  check("catalog: lookup by provider/model", cat.maxContextSize("anthropic/claude-x") === 200000);
  const fast = cat.info("fast");
  check(
    "catalog: declared tags → structured capability",
    fast.capability.image_in === true && fast.capability.video_in === false && fast.capability.max_context_tokens === 200000,
  );
  const unknown = cat.info("nope");
  check("catalog: unknown → UNKNOWN_CAPABILITY, not a throw", !unknown.known && unknown.capability === UNKNOWN_CAPABILITY);
}

function testFlags(): void {
  const flags = new Flags({ micro_compaction: true });
  check("flags: override wins", flags.enabled("micro_compaction") === true);
  check("flags: declared default applies", flags.enabled("goal_command") === true);
  check("flags: unknown flag → false", flags.enabled("does_not_exist") === false);
}

async function testConfigDrivenRun(dir: string, machine: LocalMachine): Promise<void> {
  const target = join(dir, "denied.txt");
  const resolver = layeredResolver(
    { permission: { mode: "manual", rules: [{ decision: "deny", scope: "user", pattern: "Read" }] }, loopControl: { maxStepsPerTurn: 3 } },
    { permission: { rules: [{ decision: "deny", scope: "project", pattern: "Write", reason: "writes off in this project" }] } },
  );
  const opts = await resolveCoreOptions(resolver);
  check("options: merged deny rules projected", opts.permission.rules.length === 2);
  check("options: loopControl projected", opts.loopControl.maxStepsPerTurn === 3);
  check("options: hooks default empty", opts.hooks.length === 0);

  const withHooks = toCoreOptions(
    parseConfig({
      hooks: [
        { event: "PreToolUse", matcher: "Write", command: "echo no" },
        { event: "NotARealEvent", command: "echo skip" },
      ],
    }),
  );
  check(
    "options: config.hooks projected (unknown events dropped)",
    withHooks.hooks.length === 1 && withHooks.hooks[0]!.event === "PreToolUse" && withHooks.hooks[0]!.matcher === "Write",
  );

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: target, content: "x" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("acknowledged the denial", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x", tools: [writeTool] });

  const runner = new Runner({
    machine,
    permission: { mode: opts.permission.mode, rules: opts.permission.rules },
    maxStepsPerTurn: opts.loopControl.maxStepsPerTurn,
  });
  const result = await runner.run(agent, "write a file");
  faux.unregister();

  const writeResult = result.messages.find((m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult" && m.toolName === "Write");
  const text = writeResult?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
  check("config run: Write denied by config rule", (writeResult?.isError ?? false) && text.includes("denied by permission rule"));
  check("config run: file not written", !existsSync(target));
  check("config run: completes", result.status === "completed");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-config-e2e-"));
  const machine = new LocalMachine(dir);
  try {
    testLayeredMerge();
    testModelCatalog();
    testFlags();
    await testConfigDrivenRun(dir, machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ CONFIG E2E PASS — layered merge + model catalog (#9) + flags + config-driven run");
  } else {
    console.log("❌ CONFIG E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ CONFIG E2E ERROR:", error);
  process.exit(1);
});
