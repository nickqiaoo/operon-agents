import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli.ts";
import { ToolCallComponent } from "../src/components.ts";
import { createApprovalDialog, createQuestionDialog } from "../src/dialogs.ts";
import { jsonPreview, parseSlashCommand, toolResultText } from "../src/format.ts";

test("parseSlashCommand keeps multiline arguments", () => {
  assert.deepEqual(parseSlashCommand("/follow-up first\nsecond"), {
    name: "follow-up",
    args: "first\nsecond",
  });
  assert.equal(parseSlashCommand("hello"), null);
});

test("parseCliArgs resolves core startup controls", () => {
  const parsed = parseCliArgs(
    ["--", "--model", "openai/gpt-5", "--permission", "workspace", "--thinking", "high", "--continue", "-C", "."],
    {},
  );
  assert.equal(parsed.model, "openai/gpt-5");
  assert.equal(parsed.permission, "workspace");
  assert.equal(parsed.thinking, "high");
  assert.equal(parsed.continueLast, true);
});

test("format helpers bound noisy tool values", () => {
  assert.equal(jsonPreview({ command: "echo hi" }), '{"command":"echo hi"}');
  const output = toolResultText({ content: [{ type: "text", text: "x".repeat(1000) }] }, 20);
  assert.equal(output.length, 20);
  assert.ok(output.endsWith("…"));
});

test("tool component exposes lifecycle in rendered output", () => {
  const tool = new ToolCallComponent("call-1", "Bash", { command: "pwd" });
  assert.match(tool.render(80).join("\n"), /Bash/);
  tool.complete({ content: [{ type: "text", text: "done" }] }, false);
  assert.match(tool.render(80).join("\n"), /done/);
});

test("approval dialog maps the first choice to one-shot approval", async () => {
  const dialog = createApprovalDialog(
    { toolCallId: "call-1", toolName: "Bash", approvalRule: "Bash(pwd)" },
    () => undefined,
  );
  assert.match(dialog.component.render(80).join("\n"), /Approve Bash/);
  dialog.component.handleInput?.("\r");
  assert.deepEqual(await dialog.result, { decision: "approved" });
});

test("question dialog returns an option-keyed response", async () => {
  const dialog = createQuestionDialog(
    [{
      header: "Style",
      question: "Which style?",
      multiSelect: false,
      options: [
        { label: "Compact", description: "Short output" },
        { label: "Detailed", description: "More context" },
      ],
    }],
    () => undefined,
  );
  assert.match(dialog.component.render(80).join("\n"), /Which style/);
  dialog.component.handleInput?.("\r");
  assert.deepEqual(await dialog.result, {
    answers: { "Which style?": "Compact" },
    method: "option",
  });
});
