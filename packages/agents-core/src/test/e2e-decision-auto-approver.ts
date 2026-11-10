import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { DecisionAutoApprover, DecisionModel, LlmAutoApprover, createAutoApprover } from "../index.ts";
import type { AutoApprovalInput, AutoApprovalReport, ModelRuntime } from "../index.ts";

function decisionModel(respond: (context: ClassifierContext) => Partial<ClassifierResult>): DecisionModel {
  const runtime = {
    models: {
      classify: async (_model: unknown, context: ClassifierContext) => ({ stopReason: "stop", answers: {}, ...respond(context) }),
    },
  } as unknown as ModelRuntime;
  return new DecisionModel({ runtime, descriptor: { id: "jev" } as never });
}

/** A request that never comes back until its signal aborts. */
function hungModel(): DecisionModel {
  const runtime = {
    models: {
      classify: (_m: unknown, _c: unknown, call: { signal: AbortSignal }) =>
        new Promise((resolve) => call.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", answers: {} }))),
    },
  } as unknown as ModelRuntime;
  return new DecisionModel({ runtime, descriptor: { id: "hung" } as never });
}

const yes = (probability: number): Partial<ClassifierResult> => ({ answers: { safe: { type: "bool", probability } } });

function input(toolName: string, args: unknown, signal = new AbortController().signal): AutoApprovalInput {
  return {
    ctx: { toolCall: { id: "a1", name: toolName }, args, tool: undefined, signal },
    transcript: [],
    approvalRule: toolName,
    tools: [],
  } as unknown as AutoApprovalInput;
}

async function main(): Promise<void> {
  const checks: Array<[string, boolean]> = [];

  {
    const reports: AutoApprovalReport[] = [];
    const judge = new DecisionAutoApprover({ model: decisionModel(() => yes(0.97)), onOutcome: (r) => reports.push(r) });
    const verdict = await judge.classify(input("alerting_rules_read", { operation: "list" }));
    checks.push(["a confident yes allows", verdict.decision === "allow" && reports[0]?.outcome === "allow" && reports[0]?.stage === "decision"]);
  }

  {
    const judge = new DecisionAutoApprover({ model: decisionModel(() => yes(0.6)) });
    const verdict = await judge.classify(input("alerting_rules_read", {}));
    checks.push(["an unsure answer asks a person", verdict.decision === "escalate"]);
  }

  {
    const reports: AutoApprovalReport[] = [];
    const judge = new DecisionAutoApprover({
      model: decisionModel(() => ({ stopReason: "error", errorMessage: "429" })),
      onOutcome: (r) => reports.push(r),
    });
    const verdict = await judge.classify(input("alerting_rules_read", {}));
    checks.push(["an error is reported and asks a person", verdict.decision === "escalate" && reports[0]?.outcome === "error" && reports.length === 1]);
  }

  {
    const reports: AutoApprovalReport[] = [];
    const judge = new DecisionAutoApprover({ model: hungModel(), timeoutMs: 20, onOutcome: (r) => reports.push(r) });
    // AbortSignal.timeout's timer is unref'd: with nothing else pending, Node would exit before it fires.
    const keepAlive = setInterval(() => undefined, 5);
    const verdict = await judge.classify(input("alerting_rules_read", {}));
    clearInterval(keepAlive);
    checks.push([
      "a request that hangs times out as an error",
      verdict.decision === "escalate" && reports[0]?.outcome === "error" && (reports[0]?.reason ?? "").includes("timed out"),
    ]);
  }

  {
    const reports: AutoApprovalReport[] = [];
    const controller = new AbortController();
    const judge = new DecisionAutoApprover({ model: hungModel(), onOutcome: (r) => reports.push(r) });
    const pending = judge.classify(input("alerting_rules_read", {}, controller.signal));
    controller.abort();
    await pending;
    checks.push(["a cancelled turn is reported as aborted, not a timeout", reports[0]?.outcome === "aborted"]);
  }

  {
    let asked = 0;
    const judge = new DecisionAutoApprover({ model: decisionModel(() => (asked++, yes(0.1))) });
    await judge.classify(input("Bash", { command: "rm -rf /" }));
    await judge.classify(input("Write", { path: "/repo/a.ts" }));
    await judge.classify(input("RunCode", { code: "1" }));
    await judge.classify(input("read_file", { path: "~/.ssh/id_rsa" }));
    checks.push(["every kind of call is left to the model", asked === 4]);
  }

  {
    let sent = "";
    const judge = new DecisionAutoApprover({ model: decisionModel((context) => ((sent = JSON.stringify(context.state)), yes(1))) });
    await judge.classify(input("fetch", { key: "sk-abcdefghijklmnopqrstuvwx", header: "Authorization: Bearer abcdefgh12345678", q: "keep me" }));
    checks.push(["known secret shapes are removed before sending", !sent.includes("sk-abcdefghij") && !sent.includes("abcdefgh12345678") && sent.includes("keep me")]);
  }

  {
    checks.push([
      "the factory builds the judge that fits the model",
      createAutoApprover({ model: decisionModel(() => yes(1)) }) instanceof DecisionAutoApprover &&
        createAutoApprover() instanceof LlmAutoApprover,
    ]);
  }

  const ok = checks.every(([, pass]) => pass);
  for (const [label, pass] of checks) console.log(pass ? "✅" : "❌", label);
  console.log(ok ? "\n✅ DECISION AUTO-APPROVER E2E PASS" : "\n❌ DECISION AUTO-APPROVER E2E FAIL");
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error("❌ ERROR:", error);
  process.exit(1);
});
