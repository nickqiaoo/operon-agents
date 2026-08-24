import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  DiskSessionStore,
  defineAgent,
  defineModel,
  type AgentEvent,
  type Message,
  Runner,
  Session,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, extra = ""): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label} ${extra}`);
}
function blob(messages: readonly Message[]): string {
  return JSON.stringify(messages);
}
/** Pull the Workflow tool-result JSON payload out of the run transcript. Tool
 *  results are folded into history as text content, so scan every text item. */
function workflowPayload(messages: readonly Message[]): any {
  const candidates: string[] = [];
  for (const m of messages) {
    for (const c of m.content as any[]) {
      if (c.type === "text" && typeof c.text === "string") candidates.push(c.text);
      if (c.type === "toolResult" || c.type === "tool_result") {
        const inner = (c.content ?? []).map((p: any) => (p?.type === "text" ? p.text : "")).join("");
        if (inner) candidates.push(inner);
      }
    }
  }
  for (const text of candidates) {
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
  const root = mkdtempSync(join(tmpdir(), "wf-e2e-"));
  try {
    const store = new DiskSessionStore(join(root, "s"));
    const session = await Session.open({ store });
    const runner = new Runner({});
    const faux = registerFauxProvider();
    const model = faux.getChatModel()!;
    const worker = defineAgent({ name: "worker", model, instructions: "Do the task." });
    const mainAgent = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [worker] });
    const events: AgentEvent[] = [];
    const unsubscribe = session.events.subscribe((event) => events.push(event));

    const script = [
      "export const meta = { name: 'demo', description: 'demo workflow', phases: [{ title: 'Work' }] }",
      "phase('Work')",
      "const plain = await agent('summarize the repo', { label: 'sum' })",
      "const structured = await agent('extract the answer', { label: 'ext', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } })",
      "return { plain, structured }",
    ].join("\n");

    // Faux response queue, consumed in order across parent + subagents:
    //  1) parent emits the Workflow tool call
    //  2) plain worker answers with text (stop)
    //  3) structured worker calls StructuredOutput (stopTurn ends the turn — no extra response)
    //  4) parent's closing text
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Workflow", { script }), { stopReason: "toolUse" }),
      fauxAssistantMessage("PLAIN-OK", { stopReason: "stop" }),
      fauxAssistantMessage(fauxToolCall("StructuredOutput", { answer: "STRUCTURED-OK" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("workflow done", { stopReason: "stop" }),
    ]);

    const r = await runner.run(mainAgent, "run the demo workflow", { session });
    unsubscribe();
    faux.unregister();

    check("run completes", r.status === "completed", r.status);
    const transcript = blob(r.messages);
    check("Workflow tool was invoked", transcript.includes('"Workflow"') || transcript.includes("Workflow"));

    const payload = workflowPayload(r.messages);
    check("workflow produced a result payload", payload !== undefined, transcript.slice(0, 200));
    if (payload !== undefined) {
      check("workflow ok", payload.ok === true, JSON.stringify(payload).slice(0, 200));
      check("plain agent() returned text", payload.result?.plain === "PLAIN-OK", JSON.stringify(payload.result));
      check(
        "structured agent() returned a PARSED OBJECT (not a string)",
        payload.result?.structured && typeof payload.result.structured === "object" && payload.result.structured.answer === "STRUCTURED-OK",
        JSON.stringify(payload.result?.structured),
      );
      check("agentCount == 2", payload.agentCount === 2, String(payload.agentCount));
      check("no failures", Array.isArray(payload.failures) && payload.failures.length === 0, JSON.stringify(payload.failures));
    }

    const running = events.flatMap((event) =>
      event.type === "workflow.progress" && event.progress.type === "agent" && event.progress.record.state === "running"
        ? [{ event, record: event.progress.record }]
        : [],
    );
    const done = events.flatMap((event) =>
      event.type === "workflow.progress" && event.progress.type === "agent" && event.progress.record.state === "done"
        ? [event.progress.record]
        : [],
    );
    const childStarts = events.filter((event) => event.type === "agent.started" && event.address !== "main");
    check("workflow progress identifies both concrete child agents", running.length === 2 && new Set(running.map(({ record }) => record.address)).size === 2);
    check(
      "workflow progress address joins each child agent.started event",
      running.every(({ event, record }) =>
        typeof record.agentId === "string" &&
        typeof record.address === "string" &&
        childStarts.some((started) =>
          started.address === record.address &&
          started.type === "agent.started" &&
          started.parentToolCallId === event.toolCallId,
        )),
    );
    check(
      "workflow done keeps the same identity used by the full agent stream",
      done.length === 2 && done.every((record) => running.some(({ record: active }) => active.index === record.index && active.address === record.address)),
    );
    const workflowRecords = [];
    for await (const record of store.readRecords()) {
      if (record.type === "custom" && record.name === "wf_journal") workflowRecords.push(record);
    }
    const runRecord = workflowRecords.find((record) => (record.data as { type?: string }).type === "run");
    const runData = runRecord?.data as { runId?: string; parentAddress?: string; parentToolCallId?: string } | undefined;
    check(
      "workflow recovery origin: run journal names its id + parent tool call",
      typeof runData?.runId === "string" && runData.parentAddress === "main" && typeof runData.parentToolCallId === "string",
    );

    const failed = checks.filter(([, ok]) => !ok);
    console.log(`\n${failed.length === 0 ? "ALL PASS" : "FAILURES"}: ${checks.length - failed.length}/${checks.length}`);
    if (failed.length > 0) process.exit(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
