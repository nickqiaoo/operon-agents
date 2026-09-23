/**
 * What a capability can reach beyond hooks and tools — the surface extensions used to get only
 * through their own runtime:
 *  - `ctx.state`: durable key/value state partitioned by capability name, under the
 *    `extension:<name>:` prefix so an extension's existing state reads back;
 *  - `ctx.records()` / `ctx.record()`: named records, earlier processes first, never doubled;
 *  - `commands`: slash commands a capability adds to the session;
 *  - `provider`: header/payload/response hooks, composed across capabilities (and after any
 *    callback already on the request), isolated when the capability is detachable.
 */
import { CommandRegistry, MemoryStore, readLog, type Capability, type SessionContext } from "../index.ts";
import { assembleCapabilities, openTestSession, testRunContext, withProviderHooks } from "../internal.ts";
import type { LlmRequest } from "../llm/model.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A capability that only captures the context it is opened with. */
function capturing(name: string, into: Map<string, SessionContext>, extra: Partial<Capability> = {}): Capability {
  return {
    name,
    contract: "detachable",
    openSession: (ctx) => {
      into.set(name, ctx);
    },
    ...extra,
  };
}

async function main(): Promise<void> {
  // ── state: partitioned by name, store-backed, compatible with the extension prefix ──
  {
    const store = new MemoryStore();
    await store.putState("extension:alpha:k", 1);
    const ctxs = new Map<string, SessionContext>();
    const session = await openTestSession({ store, capabilities: [capturing("alpha", ctxs), capturing("beta", ctxs)] });
    const alpha = ctxs.get("alpha")!;
    const beta = ctxs.get("beta")!;
    check("state: a key written under the extension prefix reads back", (await alpha.state.get("k")) === 1);
    check("state: another capability does not see it", (await beta.state.get("k")) === null);
    await beta.state.set("k", 2);
    check("state: writes stay in their own partition", (await alpha.state.get("k")) === 1 && (await beta.state.get("k")) === 2);
    check("state: persisted in the store under extension:<name>:", (await store.getState("extension:beta:k")) === 2);
    await beta.state.delete("k");
    check("state: delete removes the key", (await beta.state.get("k")) === null);
    await session.close();
  }

  // ── records: earlier processes first, this session's after, never doubled ──
  {
    const store = new MemoryStore();
    const first = new Map<string, SessionContext>();
    const s1 = await openTestSession({
      store,
      capabilities: [
        capturing("alpha", first, {
          openSession: (ctx) => {
            first.set("alpha", ctx);
            // Before any run: there is no live conversation yet, so this goes straight to the store.
            ctx.record("hit", { n: 1 });
          },
        }),
      ],
    });
    check("records: a write is visible to records() in the same session", (await first.get("alpha")!.records()).length === 1);
    await s1.close();

    // Opening a second session over the same store is a later process as far as records go.
    await delay(5);
    const second = new Map<string, SessionContext>();
    const s2 = await openTestSession({ store, capabilities: [capturing("alpha", second), capturing("beta", second)] });
    const alpha = second.get("alpha")!;
    alpha.record("hit", { n: 2 });
    // Let the append land, so the (lazy) log read below would see it — and must not count it twice.
    await delay(5);
    const records = await alpha.records();
    check("records: earlier process first, then this session's", records.length === 2 && (records[0]!.data as { n: number }).n === 1 && (records[1]!.data as { n: number }).n === 2);
    check("records: another capability's records are not mixed in", (await second.get("beta")!.records()).length === 0);
    await s2.close();

    const log = await readLog(store);
    check("records: journaled as custom records named extension:<name>:<record>", log.filter((r) => r.type === "custom" && (r as { name: string }).name === "extension:alpha:hit").length === 2);
  }

  // ── storeless: state and records still work, from memory ──
  {
    const ctxs = new Map<string, SessionContext>();
    const session = await openTestSession({ capabilities: [capturing("mem", ctxs)] });
    const mem = ctxs.get("mem")!;
    await mem.state.set("x", "y");
    mem.record("r", 7);
    check("storeless: state is kept in memory", (await mem.state.get("x")) === "y");
    check("storeless: records() sees the session's writes", (await mem.records()).map((r) => r.data).join() === "7");
    await session.close();
  }

  // ── commands: a capability's commands join the session's command set ──
  {
    const hello: Capability = {
      name: "greeter",
      contract: "detachable",
      commands: [{ name: "hello", description: "say hello", run: () => ({ ok: true, message: "hi" }) }],
    };
    const session = await openTestSession({ capabilities: [hello] });
    const registry = new CommandRegistry();
    check("commands: listed for the session", registry.list(session).some((c) => c.name === "hello"));
    check("commands: absent without a session", !registry.list().some((c) => c.name === "hello"));
    await session.close();
  }

  // ── provider hooks: composed in order, after any callback already on the request ──
  {
    const seen: string[] = [];
    const a: Capability = {
      name: "a",
      contract: "detachable",
      provider: {
        headers: (headers) => ({ ...headers, "x-a": "1", "x-order": `${headers["x-order"] ?? ""}a` }),
        payload: (payload) => ({ payload: { ...(payload as object), a: true } }),
        response: (response) => {
          seen.push(`a:${response.status}`);
        },
      },
    };
    const b: Capability = {
      name: "b",
      contract: "detachable",
      provider: {
        headers: (headers) => ({ ...headers, "x-order": `${headers["x-order"] ?? ""}b` }),
        // No change: the previous payload must survive.
        payload: () => undefined,
        response: (response) => {
          seen.push(`b:${response.status}`);
        },
      },
    };
    const assembled = await assembleCapabilities([a, b], testRunContext());
    const prior = (headers: Record<string, string | null>) => ({ ...headers, "x-order": "p" });
    const request = withProviderHooks({ messages: [], providerOptions: { transformHeaders: prior } } as unknown as LlmRequest, assembled.providerHooks, { turnId: "t", stepNumber: 1 });
    const options = request.providerOptions as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const headers = (await options.transformHeaders!({ base: "0" })) as Record<string, string>;
    check("provider: header hooks chain in capability order after the prior callback", headers["x-order"] === "pab");
    check("provider: each hook's change survives the next", headers["x-a"] === "1" && headers.base === "0");
    const payload = (await options.onPayload!({ body: 1 })) as Record<string, unknown>;
    check("provider: payload replaced by { payload }, kept on undefined", payload.a === true && payload.body === 1);
    await options.onResponse!({ status: 200, headers: {} });
    check("provider: every response observer runs", seen.join() === "a:200,b:200");
  }

  // ── provider hooks of a detachable capability are isolated ──
  {
    const diagnostics: string[] = [];
    const broken: Capability = {
      name: "broken",
      contract: "detachable",
      hookTimeoutMs: 40,
      provider: {
        headers: () => {
          throw new Error("header boom");
        },
        response: () => new Promise(() => undefined),
      },
    };
    const assembled = await assembleCapabilities([broken], testRunContext(), { report: (d) => diagnostics.push(`${d.capability}/${d.phase}: ${d.message}`) });
    const request = withProviderHooks({ messages: [] } as unknown as LlmRequest, assembled.providerHooks, { turnId: "t", stepNumber: 1 });
    const options = request.providerOptions as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const headers = (await options.transformHeaders!({ keep: "me" })) as Record<string, string>;
    check("provider isolation: a throwing header hook leaves the headers unchanged", headers.keep === "me");
    const startedAt = Date.now();
    await options.onResponse!({ status: 200, headers: {} });
    check("provider isolation: a stalled response observer is abandoned at its budget", Date.now() - startedAt < 1_000);
    check("provider isolation: both failures are reported as hook warnings", diagnostics.some((d) => d.includes("provider.headers")) && diagnostics.some((d) => d.includes("provider.response")));
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — capability surface: state, records, commands, provider hooks");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
