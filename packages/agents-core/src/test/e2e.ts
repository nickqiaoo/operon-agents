import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineModel, LocalMachine, ConversationContext, writeTool, editTool, readTool, globTool, bashTool, grepTool } from "../index.ts";
import { runTurn } from "../internal.ts";
import type { Message, ToolResultMessage } from "../index.ts";

function toolOutput(messages: Message[], name: string): { text: string; isError: boolean } {
  const m = messages.find((x): x is ToolResultMessage => x.role === "toolResult" && x.toolName === name);
  return {
    text: m?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "",
    isError: m?.isError ?? true,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-e2e-"));
  const file = join(dir, "note.txt");

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "line one\nline two\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Edit", { path: file, old_string: "line two", new_string: "LINE TWO" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Read", { path: file }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Glob", { pattern: "*.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Bash", { command: "echo BASH_OK && cat note.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Grep", { pattern: "LINE", output_mode: "content" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);

  const model = faux.getChatModel()!;
  const machine = new LocalMachine(dir);
  const context = new ConversationContext();
  context.seed([{ role: "user", content: [{ type: "text", text: "create, edit, read, then glob" }], timestamp: Date.now() }]);
  const messages = context.messages; // live array the loop appends to

  const result = await runTurn({
    turnId: "t1",
    signal: new AbortController().signal,
    model,
    machine,
    context,
    tools: [writeTool, editTool, readTool, globTool, bashTool, grepTool],
    maxSteps: 12,
  });

  faux.unregister();

  const onDisk = readFileSync(file, "utf8");
  rmSync(dir, { recursive: true, force: true });

  const read = toolOutput(messages, "Read");
  const glob = toolOutput(messages, "Glob");
  const bash = toolOutput(messages, "Bash");
  const grep = toolOutput(messages, "Grep");

  const diskOk = onDisk === "line one\nLINE TWO\n";
  const readOk = !read.isError && read.text.includes("1\tline one") && read.text.includes("2\tLINE TWO");
  const globOk = !glob.isError && glob.text.includes("note.txt");
  const bashOk = !bash.isError && bash.text.includes("BASH_OK") && bash.text.includes("LINE TWO");
  const grepOk = !grep.isError && grep.text.includes("LINE TWO");
  const loopOk = result.stopReason === "end_turn" && result.steps === 7;
  const ok = diskOk && readOk && globOk && bashOk && grepOk && loopOk;

  console.log("steps:", result.steps, "| stopReason:", result.stopReason);
  console.log("file on disk:", JSON.stringify(onDisk));
  console.log("Bash output:", JSON.stringify(bash.text));
  console.log("Grep output:", JSON.stringify(grep.text));
  console.log("checks → disk:", diskOk, "| read:", readOk, "| glob:", globOk, "| bash:", bashOk, "| grep:", grepOk, "| loop:", loopOk);
  console.log(ok ? "✅ E2E PASS — write + edit + read + glob + bash + grep through the full loop" : "❌ E2E FAIL");
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
