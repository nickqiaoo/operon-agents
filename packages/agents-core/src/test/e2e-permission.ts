import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type ToolCall } from "./faux.ts";
import { bashTool, ConversationContext, defineModel, LocalMachine, PermissionManager, writeTool } from "../index.ts";
import { runTurn } from "../internal.ts";
import type { Message, PermissionRule, Responder, ToolResultMessage } from "../index.ts";

async function runScenario(
  opts: { rules?: PermissionRule[]; mode?: "manual" | "workspace" | "yolo"; responder?: Responder; gitInit?: boolean },
  call: ToolCall,
  tools = [bashTool, writeTool],
): Promise<{ text: string; isError: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-perm-"));
  const { gitInit, ...pmOpts } = opts;
  if (gitInit) mkdirSync(join(dir, ".git")); // a bare `.git` dir marks the work tree
  // Machine lets the git-control / git-cwd-write policies probe the work-tree marker.
  const pm = new PermissionManager({ ...pmOpts, cwd: dir, machine: new LocalMachine(dir) });
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("done", { stopReason: "stop" })]);
  const context = new ConversationContext();
  context.seed([{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }]);
  const messages = context.messages;
  await runTurn({
    turnId: "t",
    signal: new AbortController().signal,
    model: faux.getChatModel()!,
    machine: new LocalMachine(dir),
    context,
    tools,
    hooks: { authorizeToolExecution: pm.authorize },
    maxSteps: 5,
  });
  faux.unregister();
  rmSync(dir, { recursive: true, force: true });
  const tr = messages.find((m): m is ToolResultMessage => m.role === "toolResult");
  return { text: tr?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "", isError: tr?.isError ?? true };
}

const bash = (cmd: string): ToolCall => fauxToolCall("Bash", { command: cmd });
/** Writes, so it reaches the ask instead of being cleared by bash-read-only-approve, while
 *  still printing BASH_OK for the "did it run" assertions. */
const NEEDS_ASK = "touch .perm-probe && echo BASH_OK";
const write = (path: string): ToolCall => fauxToolCall("Write", { path, content: "x" });

async function main(): Promise<void> {
  // name-only deny + yolo + ask(approve/reject)
  const deny = await runScenario({ mode: "manual", rules: [{ decision: "deny", scope: "user", pattern: "Bash" }] }, bash("echo BASH_OK"));
  const yolo = await runScenario({ mode: "yolo" }, bash("echo BASH_OK"));
  const approve = await runScenario({ mode: "manual", responder: { requestApproval: async () => ({ decision: "approved" }) } }, bash(NEEDS_ASK));
  const reject = await runScenario({ mode: "manual", responder: { requestApproval: async () => ({ decision: "rejected", feedback: "nope" }) } }, bash(NEEDS_ASK));

  // PARAMETERIZED glob rule on the command (matchesGlobRuleSubject), yolo so only deny can block
  const rmRules = [{ decision: "deny" as const, scope: "user" as const, pattern: "Bash(rm*)" }];
  const rmBlocked = await runScenario({ mode: "yolo", rules: rmRules }, bash("rm sensitive_thing"));
  const echoAllowed = await runScenario({ mode: "yolo", rules: rmRules }, bash("echo BASH_OK"));

  // PARAMETERIZED path-glob rule on Write (matchesPathRuleSubject), yolo
  const secretRules = [{ decision: "deny" as const, scope: "user" as const, pattern: "Write(**/*.secret)" }];
  const secretBlocked = await runScenario({ mode: "yolo", rules: secretRules }, write("config.secret"));
  const txtAllowed = await runScenario({ mode: "yolo", rules: secretRules }, write("config.txt"));

  // PATH-ACCESS guard: writing .env is hard-blocked at resolve regardless of mode
  const envBlocked = await runScenario({ mode: "yolo" }, write(".env"));

  // GIT-CWD-WRITE-APPROVE: a Write inside cwd inside a git work tree is auto-approved (recoverable),
  // so it runs WITHOUT consulting the responder. Without a `.git` marker the same write falls
  // through to fallback-ask — here the responder is consulted and rejects.
  const gitWriteApproved = await runScenario(
    { mode: "manual", gitInit: true, responder: { requestApproval: async () => ({ decision: "rejected", feedback: "should-not-be-asked" }) } },
    write("note.md"),
  );
  const noGitWriteAsked = await runScenario(
    { mode: "manual", responder: { requestApproval: async () => ({ decision: "rejected", feedback: "asked-not-approved" }) } },
    write("note.md"),
  );
  // GIT-CONTROL ask: writing into `.git/` asks even with the marker present (control path).
  const gitControlAsked = await runScenario(
    { mode: "manual", gitInit: true, responder: { requestApproval: async () => ({ decision: "rejected", feedback: "no .git writes" }) } },
    write(".git/hooks/evil"),
  );

  // ── Bash declares the paths its command reads/writes, so the file-access policies
  //    (sensitive-file / git-control-path / write-outside-cwd) apply to Bash the way they
  //    already applied to Write. Declaring nothing — which is what Bash did before — made all
  //    three skip it silently, since each starts by asking the plan what it touches.
  //
  //    `workspace` mode is the revealing setting: it approves everything inside the workspace,
  //    so anything that still asks did so because one of those policies fired first. The
  //    responder REJECTS, which both proves the ask happened and stops the command running.
  const outsideWrite = await runScenario(
    { mode: "workspace", responder: { requestApproval: async () => ({ decision: "rejected", feedback: "outside-cwd" }) } },
    bash("echo hi > /tmp/operon-should-not-be-written.txt"),
  );
  const insideWrite = await runScenario({ mode: "workspace" }, bash("echo hi > inside.txt"));
  const sensitiveRead = await runScenario(
    { mode: "workspace", responder: { requestApproval: async () => ({ decision: "rejected", feedback: "sensitive" }) } },
    bash("cat .env"),
  );
  const gitControlWrite = await runScenario(
    { mode: "workspace", gitInit: true, responder: { requestApproval: async () => ({ decision: "rejected", feedback: "git-control" }) } },
    bash("echo x > .git/hooks/pre-commit"),
  );
  // A command whose paths cannot be read from source text declares nothing and keeps the old
  // behaviour — the point of the extractor is to fail silent, never to guess.
  const opaqueCommand = await runScenario({ mode: "workspace" }, bash('eval "echo hi > inside2.txt"'));

  // Malformed rule patterns must not fail silently: a typo'd `deny` rule otherwise never
  // matches (fail-open) with no signal. The manager flags it at load time via the logger.
  const warns: string[] = [];
  const capturingLogger = {
    log: (level: string, message: string): void => {
      if (level === "warn") warns.push(message);
    },
  };
  new PermissionManager({ rules: [{ decision: "deny", scope: "user", pattern: "Bash(rm -rf /" }], logger: capturingLogger });
  const malformedWarned = warns.length === 1 && warns[0]!.includes("malformed pattern") && warns[0]!.toLowerCase().includes("fails open");
  warns.length = 0;
  new PermissionManager({ rules: [{ decision: "deny", scope: "user", pattern: "Bash(rm*)" }], logger: capturingLogger });
  const validQuiet = warns.length === 0;

  const checks: Array<[string, boolean]> = [
    ["deny(name-only)", deny.isError && deny.text.toLowerCase().includes("denied")],
    ["yolo allow", !yolo.isError && yolo.text.includes("BASH_OK")],
    ["ask→approve", !approve.isError && approve.text.includes("BASH_OK")],
    ["ask→reject", reject.isError && reject.text.includes("nope")],
    ["Bash(rm*) blocks rm", rmBlocked.isError && rmBlocked.text.toLowerCase().includes("denied")],
    ["Bash(rm*) allows echo", !echoAllowed.isError && echoAllowed.text.includes("BASH_OK")],
    ["Write(**/*.secret) blocks .secret", secretBlocked.isError && secretBlocked.text.toLowerCase().includes("denied")],
    ["Write(**/*.secret) allows .txt", !txtAllowed.isError && txtAllowed.text.includes("bytes")],
    ["path-access blocks .env", envBlocked.isError && envBlocked.text.toLowerCase().includes("sensitive")],
    ["git-cwd-write approves (no ask) inside work tree", !gitWriteApproved.isError && gitWriteApproved.text.includes("bytes")],
    ["non-git cwd write still asks", noGitWriteAsked.isError && noGitWriteAsked.text.includes("asked-not-approved")],
    ["git-control path write asks even with marker", gitControlAsked.isError && gitControlAsked.text.includes("no .git writes")],
    ["malformed rule pattern warned at load (not silent fail-open)", malformedWarned],
    ["valid rule pattern loads without a warning", validQuiet],
    ["bash redirect outside cwd asks", outsideWrite.isError && outsideWrite.text.includes("outside-cwd")],
    ["bash redirect inside cwd does not ask", !insideWrite.isError],
    ["bash reading a sensitive file asks", sensitiveRead.isError && sensitiveRead.text.includes("sensitive")],
    ["bash writing a .git control path asks", gitControlWrite.isError && gitControlWrite.text.includes("git-control")],
    ["bash command with unreadable paths declares nothing (no new ask)", !opaqueCommand.isError],
  ];
  const ok = checks.every(([, pass]) => pass);
  for (const [label, pass] of checks) console.log(pass ? "✅" : "❌", label);
  console.log(ok ? "\n✅ PERMISSION E2E PASS — chain + parameterized rules + path-access guard" : "\n❌ PERMISSION E2E FAIL");
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error("❌ ERROR:", error);
  process.exit(1);
});
