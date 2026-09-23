/**
 * Code Mode end to end: a faux model writes a program, RunCode runs it in QuickJS, and every
 * `tools.X()` inside it goes through the engine's own tool pipeline — events, permissions and
 * all. The runtime's own behaviour is `e2e-runtime.ts`; this is the seam between the two.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, createLocalHarness } from "operon-agents";
import type { AgentEvent, ExtensionDefinition, PermissionManagerOptions, ToolSchema } from "operon-agents";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { codeMode, DEFAULT_DIRECT_TOOLS, RUN_CODE_NAME } from "../src/index.ts";
import type { CodeModeOptions, RunCodeApprovalRequest, RunCodeDetails } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** Registered AFTER codeMode, so it sees the request codeMode rewrote. */
function requestSpy(seen: { tools?: readonly ToolSchema[] }): ExtensionDefinition {
  return {
    id: "request-spy",
    session(api) {
      api.on("model.request", (event) => {
        seen.tools = event.request.tools;
        return undefined;
      });
    },
  };
}

const textOf = (event: Extract<AgentEvent, { type: "tool.result" }>): string =>
  event.result.content.filter((part) => part.type === "text").map((part) => part.text).join("");

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const work = mkdtempSync(join(tmpdir(), "code-mode-"));
  writeFileSync(join(work, "a.txt"), "hello world\n");
  writeFileSync(join(work, "b.txt"), "nothing here\n");
  writeFileSync(join(work, "c.txt"), "hello again\n");

  /** One harness per scenario: a program, the events it produced, the request the model saw. */
  const scenario = async (
    options: CodeModeOptions,
    permission: PermissionManagerOptions,
    program: string,
    setup?: (session: Awaited<ReturnType<ReturnType<typeof createHarness>["createSession"]>>) => void,
  ) => {
    const seen: { tools?: readonly ToolSchema[] } = {};
    const harness = createHarness({
      model: faux.getChatModel(),
      workDir: work,
      permission,
      extensions: [codeMode(options), requestSpy(seen)],
    });
    const session = await harness.createSession();
    setup?.(session);
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(RUN_CODE_NAME, { code: program, description: "Run the program" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const result = await session.prompt("go");
    await harness.close();
    const parent = events.find(
      (event): event is Extract<AgentEvent, { type: "tool.call.started" }> =>
        event.type === "tool.call.started" && event.toolName === RUN_CODE_NAME && event.parentToolCallId === undefined,
    );
    const parentResult = events.find(
      (event): event is Extract<AgentEvent, { type: "tool.result" }> => event.type === "tool.result" && event.toolCallId === parent?.toolCallId,
    );
    const nested = events.filter((event) => "parentToolCallId" in event && event.parentToolCallId === parent?.toolCallId);
    const runCode = seen.tools?.find((tool) => tool.name === RUN_CODE_NAME);
    return { result, events, parent, parentResult, nested, seen, runCode };
  };

  // ── A program sweeps three files in one call ──
  {
    const s = await scenario({}, { mode: "yolo" }, `const files = ["a.txt", "b.txt", "c.txt"];
const texts = await Promise.all(files.map((f) => tools.Read({ path: f })));
const hits = files.filter((_, i) => texts[i].includes("hello"));
console.log(\`checked \${files.length}\`);
return { hits };`);
    const text = s.parentResult === undefined ? "" : textOf(s.parentResult);
    const details = s.parentResult?.result.details as RunCodeDetails | undefined;
    check("sweep: the turn completes and the model answers", s.result.output === "done");
    check("sweep: the program's logs and return value come back as the tool result", text.includes("checked 3") && text.includes('"a.txt"') && text.includes('"c.txt"') && !text.includes('"b.txt"'));
    check("sweep: the result is not an error", s.parentResult?.isError === false);
    const starts = s.nested.filter((event) => event.type === "tool.call.started");
    const results = s.nested.filter((event) => event.type === "tool.result");
    check("sweep: each tools.Read() is a nested tool.call.started under the RunCode call", starts.length === 3 && starts.every((event) => event.type === "tool.call.started" && event.toolName === "Read"));
    check("sweep: each nested call gets its own tool.result", results.length === 3 && results.every((event) => event.type === "tool.result" && !event.isError));
    check("sweep: nested call ids derive from the parent's", starts.every((event) => event.toolCallId.startsWith(`${s.parent?.toolCallId ?? "?"}:code:`)));
    check("sweep: details carry the dispatch trace", details?.dispatches.length === 3 && details.dispatches.every((d) => d.name === "Read" && d.ok) && details.toolCalls === 3 && !details.truncated);
    check("request: RunCode's description carries declarations for this turn's tools", (s.runCode?.description.includes("declare const tools: {") ?? false) && (s.runCode?.description.includes("Read(args: {") ?? false) && (s.runCode?.description.includes("Bash(args: {") ?? false));
    check("request: RunCode does not declare itself", !(s.runCode?.description.includes("RunCode(args") ?? true));
    check("request: under `both`, the direct tools are still offered", (s.seen.tools?.some((tool) => tool.name === "Read") ?? false) && (s.seen.tools?.some((tool) => tool.name === "Bash") ?? false));
  }

  // ── A denied tool is a catchable ToolCallError inside the program ──
  {
    const s = await scenario(
      {},
      { mode: "manual", rules: [{ decision: "deny", scope: "project", pattern: "Bash", reason: "no shell" }] },
      `try { await tools.Bash({ command: "echo hi" }); return "ran" } catch (e) { return { name: e.name, tool: e.toolName, msg: e.message } }`,
      (session) => session.setApprovalHandler(async () => ({ decision: "approved" })),
    );
    const text = s.parentResult === undefined ? "" : textOf(s.parentResult);
    check("deny: the nested call is refused by the permission rule and the program catches it", text.includes('"name": "ToolCallError"') && text.includes('"tool": "Bash"'));
    check("deny: the nested tool.result is an error", s.nested.some((event) => event.type === "tool.result" && event.isError));
    check("deny: the RunCode call itself succeeds", s.parentResult?.isError === false && s.result.output === "done");
    check("deny: RunCode is control flow — the approver was never asked about it", !s.events.some((event) => event.type === "turn.paused"));
  }

  // ── No live approver: the program pauses; the user answers later, from another process; the
  //    program continues without repeating what it already did ──
  {
    const home = mkdtempSync(join(tmpdir(), "code-mode-home-"));
    const open = () =>
      createLocalHarness({ model: faux.getChatModel(), homeDir: home, workDir: work, permission: { mode: "manual" }, extensions: [codeMode()] });
    let harness = await open();
    const session = await harness.createSession();
    const sessionId = session.id;
    const before: AgentEvent[] = [];
    session.onEvent((event) => before.push(event));
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(RUN_CODE_NAME, {
          code: `const a = await tools.Read({ path: "a.txt" });
await tools.Bash({ command: "echo approved > out.txt" });
const c = await tools.Read({ path: "c.txt" });
return { a: a.includes("hello"), c: c.includes("again") };`,
          description: "Read, write, read",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    let result = await session.prompt("go");
    const pending = result.interruptions?.[0];
    const request = pending?.kind === "input" ? (pending.request as { kind?: string; display?: RunCodeApprovalRequest }) : undefined;
    check("pause: the run interrupts instead of failing the call", result.status === "interrupted" && result.interruptions?.length === 1);
    check(
      "pause: the pending item is an input request shaped as the nested call's approval",
      request?.kind === "approval" && request.display?.toolName === "Bash" && request.display.sequence === 2 && request.display.approvalRule.startsWith("Bash(") && request.display.program === "Read, write, read",
    );
    check("pause: the call before it ran once, the call after it not at all", before.filter((event) => event.type === "tool.call.started" && event.toolName === "Read").length === 1 && !existsSync(join(work, "out.txt")));
    check("pause: the RunCode call is reported suspended", before.some((event) => event.type === "tool.suspended" && event.toolName === RUN_CODE_NAME));

    // "Process 2": a fresh harness over the same home, the session reopened from disk.
    await session.close();
    await harness.close();
    harness = await open();
    const reopened = await harness.resumeSession(sessionId);
    const after: AgentEvent[] = [];
    reopened.onEvent((event) => after.push(event));
    faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    result = await reopened.resume({ [pending!.approvalId]: { kind: "input", data: { decision: "approved" } } });
    const finished = after.find(
      (event): event is Extract<AgentEvent, { type: "tool.result" }> => event.type === "tool.result" && event.toolName === RUN_CODE_NAME && event.parentToolCallId === undefined,
    );
    const details = finished?.result.details as RunCodeDetails | undefined;
    const text = finished === undefined ? "" : textOf(finished);
    check("resume: the run completes and the model answers", result.status === "completed" && result.output === "done");
    check("resume: the approved call ran", existsSync(join(work, "out.txt")));
    check("resume: the call before the pause was replayed, not repeated", details?.replayed === 1 && details.dispatches[0]?.replayed === true && after.filter((event) => event.type === "tool.call.started" && event.toolName === "Read").length === 1);
    check("resume: the program's result is complete", text.includes('"a": true') && text.includes('"c": true') && details?.divergedAt === undefined);
    await reopened.close();
    await harness.close();
    rmSync(home, { recursive: true, force: true });
  }

  // ── A rejection reaches the program as a catchable error, and the call never runs ──
  {
    const home = mkdtempSync(join(tmpdir(), "code-mode-home-"));
    const harness = await createLocalHarness({ model: faux.getChatModel(), homeDir: home, workDir: work, permission: { mode: "manual" }, extensions: [codeMode()] });
    const session = await harness.createSession();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(RUN_CODE_NAME, {
          code: `try { await tools.Bash({ command: "echo no > rejected.txt" }); return "ran" } catch (e) { return { name: e.name, msg: e.message } }`,
          description: "Try a write",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    let result = await session.prompt("go");
    const pending = result.interruptions?.[0];
    check("reject: the run paused for the approval", result.status === "interrupted" && pending !== undefined);
    const after: AgentEvent[] = [];
    session.onEvent((event) => after.push(event));
    result = await session.resume({ [pending!.approvalId]: { kind: "input", data: { decision: "rejected", feedback: "not on this box" } } });
    const finished = after.find(
      (event): event is Extract<AgentEvent, { type: "tool.result" }> => event.type === "tool.result" && event.toolName === RUN_CODE_NAME && event.parentToolCallId === undefined,
    );
    const text = finished === undefined ? "" : textOf(finished);
    check("reject: the program catches a ToolCallError carrying the user's feedback", result.status === "completed" && text.includes('"name": "ToolCallError"') && text.includes("not on this box"));
    check("reject: the rejected call never ran", !existsSync(join(work, "rejected.txt")));
    await session.close();
    await harness.close();
    rmSync(home, { recursive: true, force: true });
  }

  // ── A long program runs in the background: its console lines and result land in a task log ──
  {
    const harness = createHarness({ model: faux.getChatModel(), workDir: work, permission: { mode: "yolo" }, extensions: [codeMode()] });
    const session = await harness.createSession();
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(RUN_CODE_NAME, {
          code: `console.log("starting");\nconst out = await tools.Bash({ command: "sleep 0.3 && echo slow-result" });\nconsole.log("finished");\nreturn out.trim();`,
          description: "A slow program",
          run_in_background: true,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const result = await session.prompt("go");
    const parentResult = events.find(
      (event): event is Extract<AgentEvent, { type: "tool.result" }> => event.type === "tool.result" && event.toolName === RUN_CODE_NAME && event.parentToolCallId === undefined,
    );
    const details = parentResult?.result.details as RunCodeDetails | undefined;
    check("background: the call returns at once with a task id", result.output === "done" && details?.movedToBackground === true && typeof details.taskId === "string");
    const taskId = details?.taskId ?? "";
    let task = (session.core.requireService("background").list(false)).find((t) => t.taskId === taskId);
    for (let i = 0; i < 100 && (task === undefined || task.status === "running"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = (session.core.requireService("background").list(false)).find((t) => t.taskId === taskId);
    }
    check("background: the task is a code task that completes on its own", task?.kind === "code" && task.status === "completed");
    const output = await session.core.requireService("background").readOutput(taskId, 16 * 1024);
    check("background: the task log carries console lines, nested call outcomes and the result", output.content.includes("starting") && output.content.includes("tools.Bash -> ok") && output.content.includes("finished") && output.content.includes("--- result ---") && output.content.includes("slow-result"));
    check("background: nested calls still went through the engine", events.some((event) => event.type === "tool.call.started" && event.toolName === "Bash" && event.parentToolCallId !== undefined));
    await harness.close();
  }

  // ── A running program can be moved to the background; console lines stream as progress meanwhile ──
  {
    const harness = createHarness({ model: faux.getChatModel(), workDir: work, permission: { mode: "yolo" }, extensions: [codeMode()] });
    const session = await harness.createSession();
    const events: AgentEvent[] = [];
    let detachedAt: string | undefined;
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "tool.detachable" && event.toolName === RUN_CODE_NAME && detachedAt === undefined) {
        detachedAt = event.toolCallId;
        // Let the program get going, then move it: the same thing a UI's "move to background" does.
        setTimeout(() => session.core.requireService("background").detach(event.toolCallId), 120);
      }
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(RUN_CODE_NAME, {
          code: `console.log("tick");\nawait tools.Bash({ command: "sleep 0.6" });\nconsole.log("tock");\nreturn "late";`,
          description: "A program that outlives the turn",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const result = await session.prompt("go");
    const parentResult = events.find(
      (event): event is Extract<AgentEvent, { type: "tool.result" }> => event.type === "tool.result" && event.toolName === RUN_CODE_NAME && event.parentToolCallId === undefined,
    );
    const details = parentResult?.result.details as RunCodeDetails | undefined;
    check("detach: the tool announced it could be detached, and was", detachedAt !== undefined && details?.movedToBackground === true && result.output === "done");
    check("detach: console lines streamed as progress while attached", events.some((event) => event.type === "tool.progress" && event.toolName === RUN_CODE_NAME && event.update.kind === "stdout" && event.update.text === "tick"));
    const taskId = details?.taskId ?? "";
    let task = (session.core.requireService("background").list(false)).find((t) => t.taskId === taskId);
    for (let i = 0; i < 100 && (task === undefined || task.status === "running"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = (session.core.requireService("background").list(false)).find((t) => t.taskId === taskId);
    }
    const output = await session.core.requireService("background").readOutput(taskId, 16 * 1024);
    check("detach: the program kept running after the turn ended and its result reached the log", task?.status === "completed" && output.content.includes("tock") && output.content.includes("late"));
    await harness.close();
  }

  // ── `only`: the direct surface shrinks; everything else is reachable through the program ──
  {
    const s = await scenario({ mode: "only" }, { mode: "yolo" }, `return (await tools.Read({ path: "a.txt" })).includes("hello")`);
    const text = s.parentResult === undefined ? "" : textOf(s.parentResult);
    const offered = s.seen.tools?.map((tool) => tool.name) ?? [];
    check("only: the model is offered RunCode and the keep-set, nothing else", offered.includes(RUN_CODE_NAME) && offered.every((name) => DEFAULT_DIRECT_TOOLS.includes(name)) && !offered.includes("Read"));
    check("only: hidden tools are still callable from a program", text.trim() === "true");
    check("only: declarations carry full descriptions, parameters included", (s.runCode?.description.includes("Relative paths resolve") ?? false) && (s.runCode?.description.includes("reachable ONLY through this program") ?? false));
  }

  // ── `exclude`: a tool kept out of programs is neither declared nor bound ──
  {
    const s = await scenario({ exclude: ["Bash"] }, { mode: "yolo" }, `return { bash: typeof tools.Bash, listed: ALL_TOOLS.some((t) => t.name === "Bash") }`);
    const text = s.parentResult === undefined ? "" : textOf(s.parentResult);
    check("exclude: the tool is absent from the program's world", text.includes('"bash": "undefined"') && text.includes('"listed": false'));
    check("exclude: and from the declarations", !(s.runCode?.description.includes("Bash(args") ?? true));
  }

  // ── A broken program is an error result the model can repair ──
  {
    const s = await scenario({}, { mode: "yolo" }, `const a = 1\nconst b = ;\nreturn a`);
    const text = s.parentResult === undefined ? "" : textOf(s.parentResult);
    check("syntax: the failure names the kind and the line", s.parentResult?.isError === true && text.startsWith("RunCode failed (syntax at line 2)"));
    check("syntax: the turn goes on", s.result.output === "done");
  }

  rmSync(work, { recursive: true, force: true });
  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ CODE MODE E2E PASS");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
