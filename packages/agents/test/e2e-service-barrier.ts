/**
 * The reshape barrier behind `harness.replaceExtension` (design: docs/architecture.md §5.5):
 * all affected sessions rendezvous at their run boundaries, old consumers + provider + new
 * consumers swap in the quiet moment, then everyone resumes. In-flight runs are never aborted; a straggler fails the reshape
 * (BarrierTimeout) instead of being killed, and a failed reshape changes NOTHING.
 */
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { BarrierTimeout, createHarness, tool, type ExtensionDefinition, type Message } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function toolResultText(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingAfter = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  const MARKER = Symbol("pending");
  return (await Promise.race([promise.then(() => "settled"), sleep(ms).then(() => MARKER)])) === MARKER;
};

interface ShapeService {
  render(): string;
}

const consumer = (label: string): ExtensionDefinition<unknown, unknown, { shape: ShapeService }> => ({
  id: "consumer",
  uses: ["shape"],
  setup(api, { services }) {
    const svc = services.shape;
    api.registerTool(tool({
      name: "Shape",
      description: "Render via the shared service.",
      parameters: z.object({}),
      execute: () => `${label}:${svc.render()}`,
    }));
  },
});

/** Happy path: rendezvous around one slow run; parked prompts and newborns resume after. */
async function reshapeHappyPath(): Promise<void> {
  const faux = registerFauxProvider();
  let v1Closed = false;
  const v1 = { render: () => "v1", close: () => { v1Closed = true; } };
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    services: { shape: { instance: v1, replaceable: true } },
    extensions: [consumer("old")],
  });
  const a = await harness.createSession();
  const b = await harness.createSession();

  let releaseRun!: () => void;
  const runBlocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  faux.setResponses([
    async () => { await runBlocked; return fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }); },
    fauxAssistantMessage("slow finished", { stopReason: "stop" }),
  ]);
  const slow = a.prompt("slow one");
  await sleep(20); // the run is now in flight, parked inside the model call

  const reshape = harness.replaceExtension(consumer("new"), {
    services: { shape: { render: () => "v2" } },
    timeoutMs: 5_000,
  });
  check("barrier: reshape waits while a run is in flight", await pendingAfter(reshape, 60));

  const parked = b.prompt("parked during barrier");
  check("barrier: a prompt during the hold parks instead of failing", await pendingAfter(parked, 60));

  let mutexRejected = false;
  await harness.replaceExtension(consumer("dup")).catch(() => { mutexRejected = true; });
  check("barrier: a concurrent reshape is rejected (mutex)", mutexRejected);

  const newborn = await harness.createSession();
  const newbornPrompt = newborn.prompt("newborn during barrier");
  check("barrier: a session born during the hold is gated too", await pendingAfter(newbornPrompt, 60));

  // Queue the responses the post-release runs will consume, then let the slow run finish.
  faux.appendResponses([
    fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("b done", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("newborn done", { stopReason: "stop" }),
  ]);
  releaseRun();
  const slowResult = await slow;
  check("barrier: the in-flight run finished untouched, on the OLD world", toolResultText(slowResult.messages).includes("old:v1"));
  await reshape;
  check("reshape: completed once every session reached its boundary", true);
  check("reshape: the old provider was disposed", v1Closed);

  const parkedResult = await parked;
  check("reshape: the parked prompt resumed in the NEW world (new consumer + v2)", toolResultText(parkedResult.messages).includes("new:v2"));
  const newbornResult = await newbornPrompt;
  check("reshape: the newborn's prompt resumed and swapped too", toolResultText(newbornResult.messages).includes("new:v2"));

  await harness.close();
  faux.unregister();
}

/** Timeout path: a straggler fails the reshape; nothing changed; the run is not harmed. */
async function reshapeTimeout(): Promise<void> {
  const faux = registerFauxProvider();
  const v1 = { render: () => "v1" };
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    services: { shape: { instance: v1, replaceable: true } },
    extensions: [consumer("old")],
  });
  const a = await harness.createSession();

  let releaseRun!: () => void;
  const runBlocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  faux.setResponses([
    async () => { await runBlocked; return fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }); },
    fauxAssistantMessage("straggler finished", { stopReason: "stop" }),
  ]);
  const straggler = a.prompt("wedged");
  await sleep(20);

  let timeout: BarrierTimeout | undefined;
  await harness
    .replaceExtension(consumer("new"), { services: { shape: { render: () => "v2" } }, timeoutMs: 100 })
    .catch((error) => { timeout = error instanceof BarrierTimeout ? error : undefined; });
  check("timeout: BarrierTimeout names the stuck session", timeout?.stuckSessionIds.includes(a.id) === true);

  releaseRun();
  const result = await straggler;
  check("timeout: the straggler's run finished normally afterward, on the OLD world", toolResultText(result.messages).includes("old:v1"));
  check("timeout: nothing changed — the consumer is still the old one", a.attachedExtensionIds().includes("consumer"));

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("after timeout", { stopReason: "stop" }),
  ]);
  const after = await a.prompt("still old world?");
  check("timeout: the service is still v1 (failed reshape left the world intact)", toolResultText(after.messages).includes("old:v1"));

  await harness.close();
  faux.unregister();
}

/** promptStream lazily starts behind the gate; resumeSession during a barrier is gated at birth. */
async function streamAndReopen(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    services: { shape: { instance: { render: () => "v1" }, replaceable: true } },
    extensions: [consumer("old")],
  });
  const a = await harness.createSession();
  const b = await harness.createSession();
  const bId = b.id;
  await b.close();

  let releaseRun!: () => void;
  const runBlocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  faux.setResponses([
    async () => { await runBlocked; return fauxAssistantMessage("slow done", { stopReason: "stop" }); },
  ]);
  const slow = a.prompt("slow");
  await sleep(20);
  const reshape = harness.replaceExtension(consumer("new"), {
    services: { shape: { render: () => "v2" } },
    timeoutMs: 5_000,
  });
  await sleep(20);

  // promptStream on a HELD session: the handle must return immediately, the run start lazily.
  const reopened = await harness.resumeSession(bId);
  const stream = reopened.promptStream("streamed during barrier");
  check("stream: the handle returns synchronously while held", typeof stream.completed?.then === "function");
  check("stream: but the run has not started (completed still pending)", await pendingAfter(stream.completed, 60));

  faux.appendResponses([fauxAssistantMessage("stream done", { stopReason: "stop" })]);
  releaseRun();
  await slow;
  await reshape;
  const streamed = await stream.completed;
  check("stream: the lazy run started after release and completed", JSON.stringify(streamed.messages ?? streamed).includes("stream done"));
  check("reopen: the session reopened during the barrier was swapped by the reshape", reopened.attachedExtensionIds().includes("consumer"));

  await harness.close();
  faux.unregister();
}

/** Idle wake stands down while held: no run is created during the hold; ONE run drains the
 *  whole queue after release. (Change 8, item 4 — queued messages are neither lost nor double-run.
 *  Fed via steer: session.followUp is a no-op on an idle session by design.) */
async function idleWakeStandDown(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    services: { shape: { instance: { render: () => "v1" }, replaceable: true } },
    extensions: [consumer("old")],
  });
  const a = await harness.createSession();
  const b = await harness.createSession();

  const bRunStarts: number[] = [];
  const bAppended: string[] = [];
  b.onEvent((event) => {
    if (event.type === "agent.started" && event.address === "main") bRunStarts.push(Date.now());
    if (event.type === "message.appended") bAppended.push(JSON.stringify(event));
  });

  let releaseRun!: () => void;
  const runBlocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  faux.setResponses([
    async () => { await runBlocked; return fauxAssistantMessage("slow done", { stopReason: "stop" }); },
  ]);
  const slow = a.prompt("slow");
  await sleep(20);
  const reshape = harness.replaceExtension(consumer("new"), {
    services: { shape: { render: () => "v2" } },
    timeoutMs: 5_000,
  });
  await sleep(20);

  // Three messages land while b is held (steer: with nothing in flight it is simply the next
  // input, and each enqueue triggers an idle wake); every wake must stand down.
  b.steer("MSG_ONE");
  b.steer("MSG_TWO");
  b.steer("MSG_THREE");
  await sleep(60);
  check("wake: no run was created during the hold (wakes stood down)", bRunStarts.length === 0 && b.status.state === "idle");
  check("wake: the messages are queued, not dropped", b.status.hasQueuedMessages === true);

  faux.appendResponses([fauxAssistantMessage("drained", { stopReason: "stop" })]);
  releaseRun();
  await slow;
  await reshape;
  await sleep(300);
  const seen = bAppended.join("|");
  check("wake: ONE run after release drained the whole queue", bRunStarts.length === 1);
  check("wake: all three follow-ups reached the conversation", seen.includes("MSG_ONE") && seen.includes("MSG_TWO") && seen.includes("MSG_THREE"));
  check("wake: queue is empty afterwards", b.status.hasQueuedMessages === false);

  await harness.close();
  faux.unregister();
}

await reshapeHappyPath();
await reshapeTimeout();
await streamAndReopen();
await idleWakeStandDown();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
