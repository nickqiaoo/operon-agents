/**
 * cron as an extension — the mechanism carried over from core's e2e-cron (expr / tools / fire →
 * steer / idle gate / resume no-replay / one-shot / coalesce / stale), now against the narrow
 * CronManagerRuntime, plus the four seams end to end: the extension's tools, its /cron command
 * (dynamic registry), its exposed handle, its emitted events, and state persistence across a
 * session resume.
 */
import {
  createExtensionCommandRegistry,
  createHarness,
  cronCreateTool,
  cronDeleteTool,
  cronExtension,
  cronListTool,
  CronManager,
  computeNextCronRun,
  DEFAULT_CRON_JITTER_CONFIG,
  LocalMachine,
  mutableClock,
  parseCronExpression,
  type AgentEvent,
  type ClockSources,
  type CronHandle,
  type CronManagerRuntime,
  type CronTask,
  type Message,
  type Tool,
  type ToolResult,
} from "../src/index.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const NO_JITTER = { ...DEFAULT_CRON_JITTER_CONFIG, noJitter: true };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
let MACHINE: LocalMachine;

interface Fired {
  readonly prompt: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

/** The narrow runtime, stubbed: fires collect, idleness toggles, persistence is a variable. */
function stubRuntime() {
  const fired: Fired[] = [];
  let saved: CronTask[] = [];
  let idle = true;
  const runtime: CronManagerRuntime = {
    steer: (prompt, metadata) => {
      fired.push({ prompt, metadata });
      return { buffered: false };
    },
    isIdle: () => idle,
    persistence: {
      load: async () => [...saved],
      save: async (tasks) => {
        saved = [...tasks];
      },
    },
  };
  return { fired, runtime, setIdle: (v: boolean) => (idle = v), seed: (tasks: CronTask[]) => (saved = tasks) };
}

function mgrWith(clock: ClockSources, runtime: CronManagerRuntime): CronManager {
  const mgr = new CronManager({ clocks: clock, pollIntervalMs: null, jitter: NO_JITTER });
  mgr.attach(runtime);
  mgr.start();
  return mgr;
}

async function runTool(tool: Tool, args: unknown): Promise<ToolResult> {
  const sig = new AbortController().signal;
  const plan = await tool.resolve(args, { turnId: "t", toolCallId: "c", signal: sig, machine: MACHINE });
  return plan.run({ turnId: "t", toolCallId: "c", signal: sig, machine: MACHINE });
}

function testCronExpr(): void {
  const base = new Date(2026, 5, 10, 12, 0, 0, 0).getTime();
  check("cron-expr: * * * * * → next minute", computeNextCronRun(parseCronExpression("* * * * *"), base) === base + MINUTE);
  check("cron-expr: 0 0 31 2 * never fires → null", computeNextCronRun(parseCronExpression("0 0 31 2 *"), base) === null);
}

async function testTools(): Promise<void> {
  const clock = mutableClock(new Date(2026, 5, 10, 12, 0, 0, 0).getTime());
  const mgr = mgrWith(clock, stubRuntime().runtime);
  const created = await runTool(cronCreateTool(mgr), { cron: "*/15 * * * *", prompt: "sync inbox", recurring: true });
  const createdText = (created.content[0] as { text: string }).text;
  const idMatch = /id: ([0-9a-f]{8})/.exec(createdText);
  check("tools: CronCreate returns an 8-hex id + human schedule", idMatch !== null && createdText.includes("every 15 minutes"));
  const listed = await runTool(cronListTool(mgr), {});
  check("tools: CronList shows the task", (listed.content[0] as { text: string }).text.includes(idMatch?.[1] ?? "NONE"));
  const del = await runTool(cronDeleteTool(mgr), { id: idMatch?.[1] ?? "00000000" });
  check("tools: CronDelete empties the store", (del.content[0] as { text: string }).text.includes("Deleted") && mgr.store.list().length === 0);
}

function testFireIdleGateAndMetadata(): void {
  const base = new Date(2026, 5, 10, 12, 0, 0, 0).getTime();
  const clock = mutableClock(base);
  const stub = stubRuntime();
  const mgr = mgrWith(clock, stub.runtime);
  mgr.addTask({ cron: "* * * * *", prompt: "run the report", recurring: true });

  mgr.tick();
  check("fire: not due at creation minute", stub.fired.length === 0);

  clock.set(base + MINUTE + 5_000);
  stub.setIdle(false);
  mgr.tick();
  check("idle gate: no fire while a run is active", stub.fired.length === 0);
  stub.setIdle(true);
  mgr.tick();
  check("fire: due task delivered with schedule metadata", stub.fired.length === 1 && stub.fired[0]!.metadata["cron"] === "* * * * *" && stub.fired[0]!.metadata["coalescedCount"] === 1);
}

async function testResumeNoReplay(): Promise<void> {
  const base = new Date(2026, 5, 10, 12, 0, 0, 0).getTime();
  const stub = stubRuntime();
  stub.seed([{ id: "aaaa0001", cron: "* * * * *", prompt: "heartbeat", createdAt: base - 60 * MINUTE, recurring: true, lastFiredAt: base }]);
  const mgr = new CronManager({ clocks: mutableClock(base + 30_000), pollIntervalMs: null, jitter: NO_JITTER });
  mgr.attach(stub.runtime);
  await mgr.loadPersisted();
  mgr.start();
  mgr.tick();
  check("resume no-replay: lastFiredAt cursor suppresses the missed hour", stub.fired.length === 0 && mgr.store.list().length === 1);
}

function testOneShotCoalesceStale(): void {
  const base = new Date(2026, 5, 10, 12, 0, 0, 0).getTime();
  {
    const clock = mutableClock(base);
    const stub = stubRuntime();
    const mgr = mgrWith(clock, stub.runtime);
    mgr.addTask({ cron: "* * * * *", prompt: "once", recurring: false });
    clock.set(base + MINUTE + 5_000);
    mgr.tick();
    check("one-shot: fires once then auto-deletes", stub.fired.length === 1 && stub.fired[0]!.metadata["recurring"] === false && mgr.store.list().length === 0);
  }
  {
    const clock = mutableClock(base);
    const stub = stubRuntime();
    const mgr = mgrWith(clock, stub.runtime);
    mgr.addTask({ cron: "* * * * *", prompt: "tick", recurring: true });
    clock.set(base + 5 * MINUTE + 5_000);
    mgr.tick();
    check("coalesce: one delivery, coalescedCount=5", stub.fired.length === 1 && stub.fired[0]!.metadata["coalescedCount"] === 5);
  }
}

async function testStaleExpiry(): Promise<void> {
  const noonToday = new Date(2026, 5, 10, 12, 1, 0, 0).getTime();
  const stub = stubRuntime();
  stub.seed([{ id: "bbbb0002", cron: "0 12 * * *", prompt: "digest", createdAt: noonToday - 8 * DAY, recurring: true }]);
  const mgr = new CronManager({ clocks: mutableClock(noonToday), pollIntervalMs: null, jitter: NO_JITTER });
  mgr.attach(stub.runtime);
  await mgr.loadPersisted();
  mgr.start();
  mgr.tick();
  check("stale: >7-day recurring fires once with stale=true then expires", stub.fired.length === 1 && stub.fired[0]!.metadata["stale"] === true && mgr.store.list().length === 0);
}

/** The seams, end to end: attach ⇒ tools + /cron + handle + events, state survives resume. */
async function testExtensionSeams(): Promise<void> {
  const faux = registerFauxProvider();
  const clock = mutableClock(new Date(2026, 5, 10, 12, 0, 0, 0).getTime());
  const cronDef = () => cronExtension({ clocks: clock, pollIntervalMs: null, jitter: NO_JITTER });
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, extensions: [cronDef()] });
  const session = await harness.createSession();

  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  // Agent-side: the tool set carries CronCreate the moment the extension is attached.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("CronCreate", { cron: "* * * * *", prompt: "poke the build", recurring: true }), { stopReason: "toolUse" }),
    fauxAssistantMessage("scheduled", { stopReason: "stop" }),
  ]);
  const first = await session.prompt("schedule a heartbeat");
  check("seams: the agent scheduled through the extension's tool", JSON.stringify(first.messages).includes("every minute"));

  // Host-side: the exposed handle replaces the old session.createCronTask facade.
  const handle = session.extensionHandle<CronHandle>("cron");
  check("seams: extensionHandle('cron') exposes the control surface", handle !== undefined && handle.listTasks().length === 1);

  // Command-side: /cron rides the dynamic registry — no host wiring.
  const commands = createExtensionCommandRegistry();
  const listed = await commands.run("/cron list", { session: session.core });
  check("seams: /cron works because the extension is attached", listed.ok && Array.isArray(listed.data) && (listed.data as CronTask[]).length === 1);
  const added = await commands.run("/cron add 0 9 * * 1 send the weekly digest", { session: session.core });
  check("seams: /cron add schedules via the extension's command", added.ok && (added.data as CronTask).cron === "0 9 * * 1");
  check("seams: dynamic commands appear in list(session)", commands.list(session.core).some((c) => c.name === "cron"));
  const viaRpcSurface = await session.runCommand("/cron list");
  check("seams: HarnessSession.runCommand (the app-server RPC surface) reaches /cron", viaRpcSurface.ok && Array.isArray(viaRpcSurface.data));

  // Fire: tick past the minute — the prompt arrives framed as <extension-message from="cron">,
  // and a generic extension event is emitted.
  faux.appendResponses([fauxAssistantMessage("heartbeat handled", { stopReason: "stop" })]);
  clock.set(clock.wallNow() + MINUTE + 5_000);
  handle!.tick();
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 10));
  const appended = events.filter((e) => e.type === "message.appended");
  const framedArrived = JSON.stringify(appended).includes("poke the build");
  check("seams: the fire's prompt reached the conversation", framedArrived);
  const extEvents = events.filter((e) => e.type === "extension" && (e as { name?: string }).name === "cron.fired");
  check("seams: emitEvent surfaced a generic extension event named cron.fired", extEvents.length === 1);

  // State: tasks survive close + resume (the extension reloads its registry from api.state).
  const sessionId = session.id;
  await session.close();
  const resumed = await harness.resumeSession(sessionId);
  const resumedHandle = resumed.extensionHandle<CronHandle>("cron");
  check("seams: the registry survived resume through extension state", resumedHandle !== undefined && resumedHandle.listTasks().length === 2);

  await harness.close();
  faux.unregister();
}

/** Pillar 3 (disposal completeness) for the NEW registration kinds: a detached extension's
 *  command and exposed handle die with it, exactly like its tools and handlers. */
async function testSeamTeardown(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  await session.attachExtension(cronExtension({ pollIntervalMs: null, jitter: NO_JITTER }));
  check("teardown: while attached, /cron resolves and the handle exists",
    (await session.runCommand("/cron list")).ok && session.extensionHandle("cron") !== undefined);
  await session.detachExtension("cron");
  const gone = await session.runCommand("/cron list");
  check("teardown: after detach the command is unknown again", !gone.ok && gone.message.includes("Unknown command"));
  check("teardown: after detach the handle is gone", session.extensionHandle("cron") === undefined);
  await harness.close();
  faux.unregister();
}

async function main(): Promise<void> {
  MACHINE = new LocalMachine(process.cwd());
  testCronExpr();
  await testTools();
  testFireIdleGateAndMetadata();
  await testResumeNoReplay();
  testOneShotCoalesceStale();
  await testStaleExpiry();
  await testExtensionSeams();
  await testSeamTeardown();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

await main();
