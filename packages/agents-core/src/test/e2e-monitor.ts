/**
 * Monitor + mid-turn background delivery, aligned with Claude Code 2.1.321:
 * - a background settle and a monitor's events are queued on the steering channel, so they
 *   reach the model at the next step boundary of the turn in flight;
 * - a monitor's stdout lines become events (trimmed, blank dropped, cut at 500 chars, batched
 *   over 200ms, a batch cut at 3000 chars), rate-limited by a token bucket, stopped after
 *   sustained suppression, expired at its deadline; stderr never becomes an event;
 * - a foreground Bash command that opens with `sleep N` (N ≥ 2) is blocked.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { testRunner, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineAgent,
  defineTool,
  LocalEnvironment,
  SteerBus,
  BackgroundManager,
  backgroundCapability,
  backgroundStopTool,
  bashTool,
  monitorTool,
  ToolAccesses,
  ListenerSink,
  type AgentEvent,
  type Capability,
  type Message,
  type SteerMessage,
  type Tool,
  type ToolResult,
} from "../index.ts";
import { EventLimiter, LineBatcher, MONITOR_DEFAULT_TIMING } from "../capabilities/background/index.ts";
import { leadingSleep } from "../tool/builtin/bash.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Task logs go under a throwaway home, not the real `~/.operon/tasks`. */
class TempHomeEnvironment extends LocalEnvironment {
  readonly home: string;
  constructor(cwd: string, home: string) {
    super(cwd);
    this.home = home;
  }
  override gethome(): string {
    return this.home;
  }
}

let ENVIRONMENT: TempHomeEnvironment;

/** Fast timing for tests; the rate-limit test passes its own. */
const FAST = { pollMs: 25, batchMs: 60 } as const;

async function runTool(tool: Tool, args: unknown, background?: BackgroundManager): Promise<ToolResult> {
  const signal = new AbortController().signal;
  const ctx = { turnId: "t", toolCallId: "c", signal, environment: ENVIRONMENT, ...(background !== undefined ? { background } : {}) };
  const plan = await tool.resolve(args, ctx);
  return plan.run(ctx);
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function messageText(m: SteerMessage | Message): string {
  const message = "message" in m ? m.message : m;
  const content = message.content;
  return typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** A manager whose monitors use fast timing: spawnMonitor is wrapped to inject it. */
function fastManager(bus: SteerBus, timing: Record<string, number> = FAST): BackgroundManager {
  const mgr = new BackgroundManager();
  mgr.attach({ steer: bus });
  const spawn = mgr.spawnMonitor.bind(mgr);
  mgr.spawnMonitor = (start, command, description, options) => spawn(start, command, description, { ...options, timing: { ...options.timing, ...timing } });
  return mgr;
}

function taskIdOf(result: ToolResult): string {
  return /task (monitor-[\w-]+)/.exec(textOf(result))?.[1] ?? "";
}

function events(drained: readonly SteerMessage[]): SteerMessage[] {
  return drained.filter((m) => m.origin.kind === "extension" && (m.origin as { metadata?: { event?: string } }).metadata?.event === "monitor_event");
}
function notices(drained: readonly SteerMessage[]): SteerMessage[] {
  return drained.filter((m) => m.origin.kind === "extension" && (m.origin as { metadata?: { event?: string } }).metadata?.event === "monitor_notice");
}
function settles(drained: readonly SteerMessage[]): SteerMessage[] {
  return drained.filter((m) => m.origin.kind === "background_task");
}

async function testEventsStreamAndSettle(): Promise<void> {
  const bus = new SteerBus();
  const mgr = fastManager(bus);
  const started = await runTool(
    monitorTool(),
    { command: "echo first; sleep 0.4; echo second; echo third; echo '   '; echo oops >&2", description: "test lines" },
    mgr,
  );
  const startedText = textOf(started);
  const taskId = taskIdOf(started);
  check("monitor: the tool starts a task and names both logs", taskId.length > 0 && startedText.includes("output_log:") && startedText.includes("stderr_log:"));
  check("monitor: the start result says not to poll", startedText.includes("do not poll"));

  await mgr.wait(taskId, 5000);
  await tick(50);
  const drained = bus.drainSteering();
  check("monitor: nothing goes to the follow-up channel", !bus.hasFollowUps());
  const ev = events(drained).map(messageText);
  check("monitor: first line arrives as its own event", ev[0]?.includes("<event>\nfirst\n</event>") === true);
  check("monitor: lines within the batch window share one event", ev.some((t) => t.includes("second\nthird")));
  check("monitor: blank lines are dropped", ev.every((t) => !/<event>\n\s*\n/.test(t)));
  check("monitor: stderr never becomes an event", ev.every((t) => !t.includes("oops")));
  check("monitor: events are stamped as not from the user", ev.every((t) => t.includes("NOT a message from the user")));
  check("monitor: events name the description and the task", ev.every((t) => t.includes(`Monitor event: "test lines" (task ${taskId})`)));

  const settle = settles(drained);
  const settleText = settle.map(messageText).join("");
  check("monitor: one settle after the events", settle.length === 1 && drained.indexOf(settle[0]!) > drained.indexOf(events(drained).at(-1)!));
  check("monitor: settle says the stream ended", settleText.includes('Monitor "test lines" stream ended'));
  const info = mgr.getTask(taskId) as { status: string; monitor?: { eventsDelivered: number; stderrPath: string } } | undefined;
  check("monitor: task completed and counts its events", info?.status === "completed" && info.monitor?.eventsDelivered === ev.length);
  const stderrPath = info?.monitor?.stderrPath ?? "";
  check("monitor: stderr is kept in its own log", settleText.includes(`stderr_log: ${stderrPath}`) && readFileSync(stderrPath, "utf8").includes("oops"));
}

async function testExitOutcomes(): Promise<void> {
  const bus = new SteerBus();
  const mgr = fastManager(bus);
  const failed = taskIdOf(await runTool(monitorTool(), { command: "echo before; exit 3", description: "failing" }, mgr));
  const silent = taskIdOf(await runTool(monitorTool(), { command: "true", description: "silent" }, mgr));
  await mgr.wait(failed, 5000);
  await mgr.wait(silent, 5000);
  await tick(50);
  const text = settles(bus.drainSteering()).map(messageText).join("\n");
  check("monitor: a non-zero exit reports the script failed with its code", text.includes('Monitor "failing" script failed (exit 3)'));
  check("monitor: a run with no output says so", text.includes('Monitor "silent" ended without producing output (exit 0)'));
}

async function testExpiry(): Promise<void> {
  const bus = new SteerBus();
  const mgr = fastManager(bus);
  const taskId = taskIdOf(await runTool(monitorTool(), { command: "while true; do sleep 0.1; done", description: "quiet loop", timeout_ms: 1000 }, mgr));
  const info = await mgr.wait(taskId, 5000);
  await tick(50);
  const text = settles(bus.drainSteering()).map(messageText).join("\n");
  check("monitor: the deadline ends the watch as timed_out", info?.status === "timed_out");
  check("monitor: expiry with no events says so and suggests widening the filter", text.includes("[Monitor expired after 1s with no events delivered.") && text.includes("widen the filter"));
}

async function testRateLimit(): Promise<void> {
  const bus = new SteerBus();
  const mgr = fastManager(bus, { pollMs: 20, batchMs: 5, bucketCapacity: 2, bucketRefillMs: 1000, sustainedSuppressionMs: 600 });
  const taskId = taskIdOf(await runTool(monitorTool(), { command: "i=0; while true; do i=$((i+1)); echo line $i; sleep 0.05; done", description: "firehose" }, mgr));
  const info = (await mgr.wait(taskId, 8000)) as { status: string; stopReason?: string; monitor?: { eventsSuppressed: number } } | undefined;
  await tick(50);
  const drained = bus.drainSteering();
  const noticeText = notices(drained).map(messageText).join("\n");
  check("rate limit: the bucket lets a burst through", events(drained).length >= 2);
  check("rate limit: dropped batches are counted", (info?.monitor?.eventsSuppressed ?? 0) > 0);
  check("rate limit: sustained suppression stops the monitor", info?.status === "killed" && info.stopReason === "too much output");
  check("rate limit: and says why", noticeText.includes("[Monitor stopped — too much output"));
}

async function testStop(): Promise<void> {
  const bus = new SteerBus();
  const mgr = fastManager(bus);
  const taskId = taskIdOf(await runTool(monitorTool(), { command: "while true; do sleep 0.1; done", description: "to stop" }, mgr));
  await tick(100);
  const stopped = textOf(await runTool(backgroundStopTool(mgr), { task_id: taskId }));
  check("stop: BackgroundStop kills a monitor", stopped.includes("status: killed"));
}

function testBatcherAndLimiter(): void {
  const out: string[] = [];
  const batcher = new LineBatcher(1_000_000, (t) => out.push(t));
  batcher.push(`${"x".repeat(600)}\n\n  padded  \nno newline`);
  batcher.flush(false);
  check("batcher: a long line is cut at 500 chars", out[0]?.startsWith(`${"x".repeat(500)}...(truncated)`) === true);
  check("batcher: lines are trimmed and blanks dropped", out[0]?.endsWith("\npadded") === true);
  batcher.flush(true);
  check("batcher: the final flush takes the unterminated tail", out[1] === "no newline");
  out.length = 0;
  batcher.push(`${Array.from({ length: 10 }, () => "y".repeat(400)).join("\n")}\n`);
  batcher.flush(false);
  check("batcher: a batch is cut at 3000 chars", out[0]?.length === 3000 + "\n...(truncated)".length && out[0].endsWith("...(truncated)"));
  batcher.dispose();

  let now = 0;
  const delivered: string[] = [];
  const said: string[] = [];
  let tooMuch = false;
  const limiter = new EventLimiter({ ...MONITOR_DEFAULT_TIMING, bucketCapacity: 2 }, () => now, {
    deliver: (t) => delivered.push(t),
    notice: (t) => said.push(t),
    onSuppressed: () => undefined,
    tooMuch: () => {
      tooMuch = true;
    },
  });
  limiter.offer("a");
  limiter.offer("b");
  limiter.offer("c");
  check("limiter: capacity events pass, the next is dropped", delivered.join() === "a,b");
  now += 2_000;
  limiter.offer("d");
  check("limiter: a refill lets one through, preceded by a suppression notice", delivered.at(-1) === "d" && said[0]?.startsWith("[1 events suppressed") === true);
  check("limiter: an isolated drop is not a firehose", !tooMuch);
  now += 60_000;
  limiter.offer("e");
  limiter.offer("f");
  limiter.offer("g");
  check("limiter: a drop long after the last one starts a fresh stretch", !tooMuch);
}

async function testSleepBlock(): Promise<void> {
  check("sleep: `sleep 5` is caught", leadingSleep("sleep 5") === "sleep 5");
  check("sleep: `sleep 2 && ls` is caught", leadingSleep("sleep 2 && ls") === "sleep 2");
  check("sleep: `sleep 1m` is caught", leadingSleep("sleep 1m; echo") === "sleep 1m");
  check("sleep: `sleep 1.5` is short enough", leadingSleep("sleep 1.5") === undefined);
  check("sleep: a later sleep is a poll interval, not a wait", leadingSleep("ls; sleep 5") === undefined);
  check("sleep: `sleeper 5` is another command", leadingSleep("sleeper 5") === undefined);

  const bus = new SteerBus();
  const mgr = fastManager(bus);
  const blocked = await runTool(bashTool, { command: "sleep 5" }, mgr);
  check("sleep: a foreground leading sleep is blocked with a pointer to Monitor", blocked.isError === true && textOf(blocked).includes("Blocked: sleep 5") && textOf(blocked).includes("Monitor"));
  const noMonitor = await runTool(bashTool, { command: "sleep 2 && echo ran" });
  check("sleep: without a background spawner nothing is blocked", noMonitor.isError !== true && textOf(noMonitor).includes("ran"));
}

/** End to end through the runner: an event lands between steps of the turn that started it. */
async function testDeliveredMidTurn(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Monitor", { command: "echo READY-EVENT", description: "readiness" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Wait", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("saw the event", { stopReason: "stop" }),
    fauxAssistantMessage("should not happen", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });
  const wait: Capability = {
    name: "wait",
    tools: [
      defineTool({
        name: "Wait",
        description: "Wait a little.",
        parameters: z.object({}),
        resolve: () => ({
          approvalRule: "Wait",
          accesses: ToolAccesses.none(),
          run: async () => {
            await tick(800);
            return { content: [{ type: "text", text: "waited" }] };
          },
        }),
      }),
    ],
  };
  const mgr = new BackgroundManager();
  const spawn = mgr.spawnMonitor.bind(mgr);
  mgr.spawnMonitor = (start, command, description, options) => spawn(start, command, description, { ...options, timing: FAST });
  const sink = new ListenerSink();
  let turnStarts = 0;
  sink.subscribe((e: AgentEvent) => {
    if (e.type === "turn.started") turnStarts += 1;
  });
  const runner = testRunner({ environment: ENVIRONMENT, events: sink, capabilities: [backgroundCapability(mgr), wait], permission: { mode: "yolo" }, maxTurns: 10 });
  const result = await runner.run(agent, "watch it");
  faux.unregister();

  const texts = result.messages.map((m) => ({ role: m.role, text: messageText(m) }));
  const eventAt = texts.findIndex((m) => m.role === "user" && m.text.includes("READY-EVENT"));
  const waitedAt = texts.findIndex((m) => m.role === "toolResult" && m.text.includes("waited"));
  const answerAt = texts.findIndex((m) => m.role === "assistant" && m.text.includes("saw the event"));
  check("mid-turn: the event entered the conversation after the step that was running", eventAt > waitedAt && waitedAt >= 0);
  check("mid-turn: and before the model's next step", answerAt > eventAt);
  check("mid-turn: all within one turn", turnStarts === 1);
  check("mid-turn: the settle arrived in the same turn too", texts.some((m) => m.role === "user" && m.text.includes('Monitor "readiness" stream ended')));
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "monitor-e2e-"));
  ENVIRONMENT = new TempHomeEnvironment(process.cwd(), home);
  try {
    testBatcherAndLimiter();
    await testEventsStreamAndSettle();
    await testExitOutcomes();
    await testExpiry();
    await testRateLimit();
    await testStop();
    await testSleepBlock();
    await testDeliveredMidTurn();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${String(passed)}/${String(checks.length)} checks passed`);
  if (passed !== checks.length) {
    console.log("❌ MONITOR E2E FAIL");
    process.exit(1);
  }
  console.log("✅ MONITOR E2E PASS");
}

void main();
