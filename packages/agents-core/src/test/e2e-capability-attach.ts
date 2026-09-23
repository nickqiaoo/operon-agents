/**
 * `Session.attachCapability` / `detachCapability` — a capability added to or removed from a
 * session that is already open, which is what reloading a file capability is built on.
 *
 * Covers:
 *  - idle: applied at once; the next run assembles the capability (its tool is callable);
 *  - mid-run: queued until the run has stopped its capabilities, so a run never sees its set
 *    change under it — for attach and for detach;
 *  - refusals: invariant, duplicate, non-slug name, unknown detach, closed session; a throwing
 *    `openSession` rejects and leaves nothing behind;
 *  - detach closes the capability and withdraws its service; its state outlives it;
 *  - a run whose teardown throws still stops its capabilities and releases the session.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineAgent, MemoryStore, type Capability, type SessionContext, type Tool } from "../index.ts";
import { openTestSession, testRunner } from "../internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (error) {
    return pattern.test((error as Error).message);
  }
}

function probeTool(calls: string[]): Tool {
  return {
    schema: { name: "Probe", description: "probe", parameters: { type: "object", properties: {} } },
    resolve: () => ({
      approvalRule: "Probe",
      run: async () => {
        calls.push("probe");
        return { content: [{ type: "text", text: "probed" }] };
      },
    }),
  };
}

/** A capability whose `beforeStep` holds the run until `release()` — a run caught mid-flight. */
function gate(): { capability: Capability; entered: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    capability: {
      name: "gate",
      contract: "invariant",
      hooks: {
        beforeStep: async () => {
          enter();
          await released;
          return undefined;
        },
      },
    },
    entered,
    release,
  };
}

/** A store whose appends can be switched to fail — a run's journal flush then throws. */
class FailingStore extends MemoryStore {
  failAppends = false;
  override appendRecord(...args: Parameters<MemoryStore["appendRecord"]>): ReturnType<MemoryStore["appendRecord"]> {
    if (this.failAppends) return Promise.reject(new Error("append refused")) as ReturnType<MemoryStore["appendRecord"]>;
    return super.appendRecord(...args);
  }
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "attach", model, instructions: "x" });
  const runner = testRunner({});

  // ── idle: applied at once, and the next run assembles it ──
  {
    const store = new MemoryStore();
    const session = await openTestSession({ store, permission: { mode: "yolo" } });
    const calls: string[] = [];
    let opened: SessionContext | undefined;
    const service = { kind: "probe-service" };
    const probe: Capability = {
      name: "probe",
      contract: "detachable",
      tools: [probeTool(calls)],
      service,
      openSession: (ctx) => {
        opened = ctx;
      },
    };
    await session.attachCapability(probe);
    check("idle attach: openSession ran with the session's context", opened?.sessionId === session.id);
    check("idle attach: its service is published", session.service("probe") === service);
    check("idle attach: it is one of the session's capabilities", session.capabilities.some((c) => c.name === "probe"));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Probe", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    await runner.run(agent, "use the probe", { session });
    check("idle attach: the next run can call its tool", calls.length === 1);
    await session.close();
  }

  // ── mid-run: attach and detach wait for the run to stop ──
  {
    const store = new MemoryStore();
    const g = gate();
    let closed = false;
    const leaving: Capability = {
      name: "leaving",
      contract: "detachable",
      closeSession: () => {
        closed = true;
      },
    };
    const session = await openTestSession({ store, permission: { mode: "yolo" }, capabilities: [g.capability, leaving] });
    faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const run = runner.run(agent, "hold", { session });
    await g.entered;
    let lateOpened = false;
    const late: Capability = {
      name: "late",
      contract: "detachable",
      openSession: () => {
        lateOpened = true;
      },
    };
    const attaching = session.attachCapability(late);
    const detaching = session.detachCapability("leaving");
    await delay(20);
    check("mid-run attach: not opened while the run is in flight", !lateOpened);
    check("mid-run detach: not closed while the run is in flight", !closed);
    check("mid-run: the running session's capability set is unchanged", session.capabilities.some((c) => c.name === "leaving") && !session.capabilities.some((c) => c.name === "late"));
    g.release();
    await run;
    await attaching;
    await detaching;
    check("mid-run attach: applied once the run stopped", lateOpened && session.capabilities.some((c) => c.name === "late"));
    check("mid-run detach: closed and removed once the run stopped", closed && !session.capabilities.some((c) => c.name === "leaving"));
    await session.close();
  }

  // ── refusals, and a throwing openSession leaves nothing behind ──
  {
    const session = await openTestSession({
      permission: { mode: "yolo" },
      capabilities: [{ name: "core-part", contract: "invariant" }, { name: "taken", contract: "detachable" }],
    });
    check("refuse: an invariant capability cannot be attached", await rejects(session.attachCapability({ name: "inv", contract: "invariant" }), /invariant/));
    check("refuse: an invariant capability cannot be detached", await rejects(session.detachCapability("core-part"), /invariant/));
    check("refuse: a name already open", await rejects(session.attachCapability({ name: "taken", contract: "detachable" }), /already open/));
    check("refuse: a name with a colon", await rejects(session.attachCapability({ name: "a:b", contract: "detachable" }), /slug/));
    check("refuse: detaching a name that is not open", await rejects(session.detachCapability("nobody"), /no capability named/));
    const broken: Capability = {
      name: "broken",
      contract: "detachable",
      service: {},
      openSession: () => {
        throw new Error("open boom");
      },
    };
    check("refuse: a throwing openSession rejects the attach", await rejects(session.attachCapability(broken), /open boom/));
    check("refuse: ...and leaves no trace", !session.capabilities.some((c) => c.name === "broken") && session.service("broken") === undefined);
    await session.close();
    check("refuse: a closed session", await rejects(session.attachCapability({ name: "after", contract: "detachable" }), /closed/));
  }

  // ── detach withdraws the service; the capability's state outlives it ──
  {
    const store = new MemoryStore();
    const session = await openTestSession({ store, permission: { mode: "yolo" } });
    const make = (seen: unknown[]): Capability => ({
      name: "keeper",
      contract: "detachable",
      service: { live: true },
      openSession: async (ctx) => {
        seen.push(await ctx.state.get("count"));
        await ctx.state.set("count", 1);
      },
    });
    const first: unknown[] = [];
    await session.attachCapability(make(first));
    await session.detachCapability("keeper");
    check("detach: the service is withdrawn", session.service("keeper") === undefined);
    const second: unknown[] = [];
    await session.attachCapability(make(second));
    check("detach: state written before detach is there on re-attach", first[0] === null && second[0] === 1);
    await session.close();
  }

  // ── a run whose teardown fails still stops its capabilities and releases the session ──
  {
    let stopped = false;
    const watched: Capability = {
      name: "watched",
      contract: "detachable",
      stop: () => {
        stopped = true;
      },
    };
    const store = new FailingStore();
    const session = await openTestSession({ store, permission: { mode: "yolo" }, capabilities: [watched] });
    store.failAppends = true;
    faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    check("failed flush: the run rejects", await rejects(runner.run(agent, "x", { session }), /persist|append refused/));
    check("failed flush: its capabilities were still stopped", stopped);
    store.failAppends = false;
    let opened = false;
    await Promise.race([
      session.attachCapability({ name: "after-failure", contract: "detachable", openSession: () => void (opened = true) }),
      delay(500),
    ]);
    check("failed flush: the session is quiet again — an attach applies at once", opened);
    await session.close();
  }

  faux.unregister();
  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — capabilities attached and detached on a live session");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
