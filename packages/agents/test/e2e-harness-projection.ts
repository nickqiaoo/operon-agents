// HarnessSession × SessionProjection: attach-at-open, live fold, mid-turn seam, reopen seeding.
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import {
  MemoryStore,
  MemorySessionRepository,
  type AgentEvent,
  type ReadRecordsFilter,
  type SessionHandle,
  type SessionRepository,
} from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first", { stopReason: "stop" }),
    fauxAssistantMessage("second", { stopReason: "stop" }),
  ]);
  let gateActive = false;
  let enteredGate: (() => void) | undefined;
  let releaseGate: (() => void) | undefined;
  const gateEntered = new Promise<void>((resolve) => { enteredGate = resolve; });
  const gateRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [{
      id: "projection-gate",
      setup(api) {
        api.on("model.request", async () => {
          if (!gateActive) return;
          enteredGate?.();
          await gateRelease;
        });
      },
    }],
  });

  const session = await harness.createSession();
  check("fresh session: empty directory", session.directory().length === 0);

  // ── completed turn folds into messages, in-flight state self-clears ──
  await session.prompt("hello");
  const main = session.snapshot().agents.find((agent) => agent.address === "main");
  const roles = main?.messages.map((message) => message.role) ?? [];
  check(
    "after a turn: user prompt and assistant reply folded",
    roles.includes("user") && main?.messages.at(-1)?.role === "assistant",
  );
  check("after a turn: no in-flight state", main?.turn === undefined);
  check("directory reflects idle", session.directory().every((entry) => !entry.running));

  // ── mid-turn: snapshot sees the running turn; the seam is exact ──
  gateActive = true;
  const running = session.prompt("again");
  await gateEntered;
  const seen: AgentEvent[] = [];
  const observation = session.observeProjection((event) => seen.push(event));
  const snap = observation.snapshot;
  const midMain = snap.agents.find((agent) => agent.address === "main");
  check("mid-turn snapshot shows the running turn", midMain?.turn !== undefined);
  check("mid-turn directory shows running", snap.directory.some((entry) => entry.address === "main" && entry.running));
  const messagesInSnap = midMain?.messages.length ?? 0;
  gateActive = false;
  releaseGate?.();
  await running;
  const messagesFromEvents = seen.filter((event) => event.type === "message.appended" && event.address === "main").length;
  const finalCount = session.snapshot().agents.find((agent) => agent.address === "main")?.messages.length ?? 0;
  check(
    "seam: snapshot messages + subscribed appends == final state, no loss or dupes",
    messagesInSnap + messagesFromEvents === finalCount,
  );
  check("subscriber saw the turn end", seen.some((event) => event.type === "turn.ended"));
  observation.unsubscribe();

  // ── reopen: attach seeds the projection from the store ──
  const id = session.id;
  await session.close();
  const reopened = await harness.resumeSession(id);
  const seeded = reopened.snapshot().agents.find((agent) => agent.address === "main");
  check("reopened session: projection seeded from the log", seeded !== undefined && seeded.messages.length === finalCount);
  check("reopened session: nothing live", seeded?.turn === undefined && !(seeded?.live ?? true));

  await harness.close();

  // ── crash reopen: orphan lifecycle is closed durably, not hidden in Projection ──
  {
    const repository = new MemorySessionRepository();
    const crashHarness = createHarness({
      model: faux.getChatModel()!,
      permission: { mode: "yolo" },
      repository,
    });
    const crashed = await crashHarness.createSession();
    const id = crashed.id;
    await crashed.close();
    const store = (await repository.open(id))!.store;
    await store.appendRecord({
      type: "event.lifecycle",
      eventId: "evt_crash_agent_started",
      time: 1,
      address: "main",
      event: { type: "agent.started", agent: "root" },
    });
    await store.appendRecord({
      type: "event.lifecycle",
      eventId: "evt_crash_turn_started",
      time: 2,
      address: "main",
      event: { type: "turn.started", turnId: "t-crashed" },
    });

    const recovered = await crashHarness.resumeSession(id);
    const recoveredMain = recovered.snapshot().agents.find((agent) => agent.address === "main");
    check("crash reopen: Harness status is idle", recovered.status.state === "idle");
    check(
      "crash reopen: Projection has no ghost run or live frame",
      recoveredMain?.turn === undefined && recoveredMain.live === false,
    );
    const lifecycle = [];
    for await (const record of store.readRecords({ address: "main" })) {
      if (record.type === "event.lifecycle") lifecycle.push(record.event);
    }
    check(
      "crash reopen: journal records the failed turn",
      lifecycle.some((event) => event.type === "turn.ended" && event.turnId === "t-crashed" && event.reason === "failed"),
    );
    check(
      "crash reopen: journal closes the orphan agent frame",
      lifecycle.some((event) => event.type === "agent.ended" && event.agent === "root"),
    );
    const terminalCount = lifecycle.filter((event) => event.type === "turn.ended" || event.type === "agent.ended").length;
    await recovered.close();
    const reopenedAgain = await crashHarness.resumeSession(id);
    const lifecycleAgain = [];
    for await (const record of store.readRecords({ address: "main" })) {
      if (record.type === "event.lifecycle") lifecycleAgain.push(record.event);
    }
    check(
      "crash reopen: recovery is idempotent",
      lifecycleAgain.filter((event) => event.type === "turn.ended" || event.type === "agent.ended").length === terminalCount,
    );
    await reopenedAgain.close();
    await crashHarness.close();
  }

  // ── open reads the log exactly once (projection seed + Session.open share it) ──
  {
    class CountingStore extends MemoryStore {
      reads = 0;
      override readRecords(filter?: ReadRecordsFilter): AsyncIterable<import("operon-agents-core").AgentRecord> {
        this.reads += 1;
        return super.readRecords(filter);
      }
    }
    const stores = new Map<string, { handle: SessionHandle; store: CountingStore }>();
    const repo: SessionRepository = {
      async create(input) {
        const id = input.id ?? `count-${String(stores.size)}`;
        const store = new CountingStore();
        const handle: SessionHandle = { id, workDir: input.workDir ?? process.cwd(), createdAt: Date.now(), store };
        stores.set(id, { handle, store });
        return handle;
      },
      async open(id) {
        return stores.get(id)?.handle;
      },
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
      async fork() {
        throw new Error("not used");
      },
      async delete() {
        /* not used */
      },
    };
    faux.setResponses([fauxAssistantMessage("counted", { stopReason: "stop" })]);
    const harness2 = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, repository: repo });
    const counted = await harness2.createSession();
    const { store } = stores.get(counted.id)!;
    check("open: full-log readRecords happens exactly once", store.reads === 1);
    await counted.prompt("go");
    const readsAfterPrompt = store.reads;
    const midSnapshot = counted.snapshot().agents.find((agent) => agent.address === "main");
    check("prompt + snapshot add no further log reads", store.reads === readsAfterPrompt && (midSnapshot?.messages.length ?? 0) > 0);
    await harness2.close();
  }

  faux.unregister();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ HARNESS PROJECTION E2E PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
