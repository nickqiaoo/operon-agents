import { T } from "operon-agents-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineModel, DiskSessionRepository, type Message } from "operon-agents-core";
import { createHarness } from "../src/index.ts";

// What this proves: the batteries-included Harness wires the builtin coder/explore/plan subagents by
// default, so the Runner exposes the `Agent` + `Workflow` orchestration tools out of the box — with
// `subagentProvider: null` as the opt-out. (Both tools only appear when a run has subagents to spawn.)

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, extra = ""): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label} ${extra}`);
}

/** Minimal structural view of the model request — just the offered tool names. */
type ToolsCtx = { tools?: ReadonlyArray<{ name: string }> };

/** Pull the Workflow tool-result JSON payload out of the run transcript. Tool results fold into
 *  history as text, so scan every text item for the one object carrying a `runId`. */
function workflowPayload(messages: readonly Message[]): { ok?: boolean; result?: Record<string, unknown> } | undefined {
  const texts: string[] = [];
  for (const m of messages) {
    for (const c of m.content as Array<Record<string, unknown>>) {
      if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
      if (c.type === "toolResult" || c.type === "tool_result") {
        const inner = ((c.content as Array<Record<string, unknown>>) ?? [])
          .map((p) => (p?.type === "text" ? (p.text as string) : ""))
          .join("");
        if (inner) texts.push(inner);
      }
    }
  }
  for (const text of texts) {
    const start = text.indexOf("{");
    if (start < 0) continue;
    try {
      const obj = JSON.parse(text.slice(start));
      if (obj && typeof obj === "object" && "runId" in obj) return obj;
    } catch {
      // not the workflow result
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "af-wf-home-"));
  const work = mkdtempSync(join(tmpdir(), "af-wf-work-"));

  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  // Captures the tool names offered to the model on each call (reset per case).
  let offered: string[][] = [];
  const captureThen = (msg: ReturnType<typeof fauxAssistantMessage>) => (ctx: ToolsCtx) => {
    offered.push([...(ctx.tools ?? [])].map((t) => t.name));
    return msg;
  };

  try {
    // ── Case 1: default Harness exposes the Agent + Workflow tools ──
    offered = [];
    faux.setResponses([captureThen(fauxAssistantMessage("ok", { stopReason: "stop" }))]);
    const h1 = createHarness({ model, harness: (s) => s.register(T.SessionRepository, new DiskSessionRepository(home), { owned: false }), workDir: work, permission: { mode: "yolo" } });
    const s1 = await h1.createSession();
    s1.setModel(model); // real consumers (e.g. operon) set the session model; subagents inherit it
    await s1.prompt("hello");
    const tools1 = offered[0] ?? [];
    check("default harness offers the Workflow tool to the model", tools1.includes("Workflow"), tools1.join(","));
    check("default harness offers the Agent tool to the model", tools1.includes("Agent"), tools1.join(","));
    await h1.close();

    // ── Case 2: a Workflow runs end-to-end and agent() spawns the builtin `coder` subagent ──
    const script = [
      "export const meta = { name: 'demo', description: 'demo workflow' }",
      "const out = await agent('summarize the repo', { agentType: 'coder', label: 'sum' })",
      "return { out }",
    ].join("\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Workflow", { script }), { stopReason: "toolUse" }), // parent → Workflow
      fauxAssistantMessage("CODER-DID-IT", { stopReason: "stop" }), // the coder subagent's answer
      fauxAssistantMessage("done", { stopReason: "stop" }), // parent closing text
    ]);
    const h2 = createHarness({ model, harness: (s) => s.register(T.SessionRepository, new DiskSessionRepository(home), { owned: false }), workDir: work, permission: { mode: "yolo" } });
    const s2 = await h2.createSession();
    s2.setModel(model); // so the modelless builtin coder profile inherits the session model
    const r2 = await s2.prompt("run the demo workflow");
    check("workflow run completes through the harness", r2.status === "completed", r2.status);
    const payload = workflowPayload(r2.messages);
    check("workflow produced an ok result payload", payload?.ok === true, JSON.stringify(payload)?.slice(0, 200));
    check(
      "agent() spawned the builtin `coder` subagent and returned its text",
      payload?.result?.out === "CODER-DID-IT",
      JSON.stringify(payload?.result),
    );
    await h2.close();

    // ── Case 3: `subagentProvider: null` hides the Agent + Workflow tools ──
    offered = [];
    faux.setResponses([captureThen(fauxAssistantMessage("ok", { stopReason: "stop" }))]);
    const h3 = createHarness({ model, harness: (s) => s.register(T.SessionRepository, new DiskSessionRepository(home), { owned: false }), workDir: work, permission: { mode: "yolo" }, subagentProvider: null });
    const s3 = await h3.createSession();
    s3.setModel(model);
    await s3.prompt("hello");
    const tools3 = offered[0] ?? [];
    check("subagentProvider:null hides the Workflow tool", !tools3.includes("Workflow"), tools3.join(","));
    check("subagentProvider:null hides the Agent tool", !tools3.includes("Agent"), tools3.join(","));
    check("subagentProvider:null keeps the filesystem tools", tools3.includes("Read"), tools3.join(","));
    await h3.close();

    // ── Case 4: `workflowTool: false` drops ONLY Workflow ──
    // The narrow switch, for a host with its own orchestration. Unlike Case 3 it
    // must leave subagents (and therefore the Agent tool) fully intact.
    offered = [];
    faux.setResponses([captureThen(fauxAssistantMessage("ok", { stopReason: "stop" }))]);
    const h4 = createHarness({ model, harness: (s) => s.register(T.SessionRepository, new DiskSessionRepository(home), { owned: false }), workDir: work, permission: { mode: "yolo" }, workflowTool: false });
    const s4 = await h4.createSession();
    s4.setModel(model);
    await s4.prompt("hello");
    const tools4 = offered[0] ?? [];
    check("workflowTool:false hides the Workflow tool", !tools4.includes("Workflow"), tools4.join(","));
    check("workflowTool:false KEEPS the Agent tool", tools4.includes("Agent"), tools4.join(","));
    check("workflowTool:false keeps the filesystem tools", tools4.includes("Read"), tools4.join(","));
    await h4.close();
  } finally {
    faux.unregister();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ HARNESS WORKFLOW E2E PASS — default subagents light up Agent/Workflow; null opts out");
  } else {
    console.log("❌ HARNESS WORKFLOW E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ HARNESS WORKFLOW E2E ERROR:", error);
  process.exit(1);
});
