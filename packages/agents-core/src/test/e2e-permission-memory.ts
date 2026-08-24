// Session-lived permission manager:
//  - approve-for-session grants survive across runs of the same Session
//  - grants are journaled (permission.record_approval) and folded back on cold reopen
//  - setPermissionMode takes effect mid-turn (step-level) and is journaled (permission.set_mode)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  defineTool,
  Runner,
  Session,
  LocalMachine,
  MemoryStore,
  INTERRUPTION_STATE_KEY,
  parseInterruptionState,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function makeDeployTool(counter: { runs: number }) {
  return defineTool({
    name: "deploy",
    description: "deploy the service",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "deploy",
      run: async () => {
        counter.runs++;
        return { content: [{ type: "text" as const, text: "deployed" }] };
      },
    }),
  });
}

async function testApproveForSessionAcrossRuns(machine: LocalMachine, store: MemoryStore): Promise<void> {
  const counter = { runs: 0 };
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("deploy", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Deployed once.", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("deploy", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Deployed again.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "deployer", model, instructions: "x", tools: [makeDeployTool(counter)] });

  const session = await Session.open({ machine, store, permission: { mode: "manual" } });
  const runner = new Runner({});

  // Run 1: manual mode, no rule, no responder → durable interrupt on deploy.
  const first = await runner.run(agent, "deploy it", { session });
  check("grant: first deploy asks (durable interrupt)", first.status === "interrupted");
  check("grant: nothing deployed before approval", counter.runs === 0);

  const persisted = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
  const resumed = await runner.resume(
    agent,
    {
      interruption: persisted,
      answers: { [first.interruptions![0]!.approvalId]: { kind: "approval", decision: "approved", scope: "session" } },
    },
    { session },
  );
  check("grant: resume with scope=session completes", resumed.status === "completed" && counter.runs === 1);

  // Run 2 on the SAME session: the memorized pattern approves without asking.
  const second = await runner.run(agent, "deploy it again", { session });
  faux.unregister();
  check("grant: second run does NOT ask (session memory)", second.status === "completed");
  check("grant: second deploy executed", counter.runs === 2);
}

async function testGrantSurvivesColdReopen(machine: LocalMachine, store: MemoryStore): Promise<void> {
  const counter = { runs: 0 };
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("deploy", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Deployed after reopen.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "deployer", model, instructions: "x", tools: [makeDeployTool(counter)] });

  // A brand-new Session over the same store: the grant folds back from the journal.
  const reopened = await Session.open({ machine, store, permission: { mode: "manual" } });
  const runner = new Runner({});
  const result = await runner.run(agent, "deploy once more", { session: reopened });
  faux.unregister();
  check("cold-reopen: grant folded from log, no ask", result.status === "completed");
  check("cold-reopen: deploy executed", counter.runs === 1);
}

async function testStepLevelModeChange(machine: LocalMachine, store: MemoryStore): Promise<void> {
  const counter = { runs: 0 };
  const session = await Session.open({ machine, store, permission: { mode: "manual" } });

  const switchTool = defineTool({
    name: "switch_yolo",
    description: "switch permission mode to yolo",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "switch_yolo",
      controlFlow: true, // framework control flow → approved even in manual mode
      run: async () => {
        session.setPermissionMode("yolo");
        return { content: [{ type: "text" as const, text: "mode switched" }] };
      },
    }),
  });

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("switch_yolo", {}), { stopReason: "toolUse" }),
    // Same TURN, next step: deploy would fallback-ask under manual — must pass under yolo.
    fauxAssistantMessage(fauxToolCall("deploy", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Switched and deployed in one turn.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "switcher", model, instructions: "x", tools: [switchTool, makeDeployTool(counter)] });

  const runner = new Runner({});
  const result = await runner.run(agent, "switch to yolo then deploy", { session });
  faux.unregister();

  check("step-mode: mid-turn mode change takes effect on the next step", result.status === "completed");
  check("step-mode: deploy ran without asking", counter.runs === 1);
  check("step-mode: session reports the new mode", session.permissionModeSetting === "yolo");
}

async function testModeSurvivesColdReopen(machine: LocalMachine, store: MemoryStore): Promise<void> {
  const reopened = await Session.open({ machine, store, permission: { mode: "manual" } });
  check("mode-reopen: journaled set_mode wins over configured mode", reopened.permission.mode === "yolo");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "operon-perm-memory-"));
  const machine = new LocalMachine({ cwd: dir });
  try {
    const grantStore = new MemoryStore();
    await testApproveForSessionAcrossRuns(machine, grantStore);
    await testGrantSurvivesColdReopen(machine, grantStore);
    const modeStore = new MemoryStore();
    await testStepLevelModeChange(machine, modeStore);
    await testModeSurvivesColdReopen(machine, modeStore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("❌ PERMISSION-MEMORY E2E FAIL");
    process.exit(1);
  }
  console.log("✅ PERMISSION-MEMORY E2E PASS — session-lived grants + cold-reopen fold + step-level mode + durable mode");
}

await main();
