/**
 * Code Mode end to end: a faux model writes a program, RunCode runs it in QuickJS, and every
 * `tools.X()` inside it goes through the engine's own tool pipeline — events, permissions and
 * all. The runtime's own behaviour is `e2e-runtime.ts`; this is the seam between the two.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "operon-agents";
import type { AgentEvent, ExtensionDefinition, PermissionManagerOptions, ToolSchema } from "operon-agents";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { codeMode, DEFAULT_DIRECT_TOOLS, RUN_CODE_NAME } from "../src/index.ts";
import type { CodeModeOptions, RunCodeDetails } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** Registered AFTER codeMode, so it sees the request codeMode rewrote. */
function requestSpy(seen: { tools?: readonly ToolSchema[] }): ExtensionDefinition {
  return {
    id: "request-spy",
    setup(api) {
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

  // ── No live approver: a call that needs approval fails inside the program instead of pausing the run ──
  {
    const s = await scenario(
      {},
      { mode: "manual" },
      // A command that writes: read-only commands are approved without asking, this one must ask.
      `try { await tools.Bash({ command: "echo hi > out.txt" }); return "ran" } catch (e) { return e.message }`,
    );
    const text = s.parentResult === undefined ? "" : textOf(s.parentResult);
    check("no approver: the program is told the call needs approval and to call the tool directly", text.includes("requires the user's approval") && text.includes("Call the tool directly"));
    check("no approver: the run finishes instead of pausing", s.result.output === "done" && !s.events.some((event) => event.type === "turn.paused"));
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
