import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  createHarness,
  deadServiceHandle,
  ServiceRegistry,
  ServiceUnavailableError,
  tool,
  type Message,
} from "../src/index.ts";

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

interface Greeter {
  greet(name: string): string;
}

/** Registration rules, handle shape discipline, unregister. */
async function registryBasics(): Promise<void> {
  const registry = new ServiceRegistry({ warn: () => undefined });

  const handle = registry.handle<Greeter>("greeter");
  let missing = false;
  try {
    handle.greet("a");
  } catch (error) {
    missing = error instanceof ServiceUnavailableError && error.reason === "missing";
  }
  check("basics: calling a handle before registration throws ServiceUnavailableError(missing)", missing);

  registry.register("greeter", { greet: (name: string) => `hi ${name}`, version: 1 });
  check("basics: handle routes a method call to the instance", handle.greet("ada") === "hi ada");
  check("basics: the same pre-registration handle works after registration (stable handle)", registry.handle<Greeter>("greeter") === handle);

  let duplicate = false;
  try {
    registry.register("greeter", {});
  } catch {
    duplicate = true;
  }
  check("basics: duplicate registration fails closed", duplicate);

  let nonMethod = false;
  try {
    void (handle as unknown as { version: number }).version;
  } catch (error) {
    nonMethod = error instanceof TypeError;
  }
  check("basics: non-method property access throws TypeError (methods only)", nonMethod);

  const awaited = await Promise.resolve(handle);
  check("basics: `then` reads as undefined so a handle survives await un-unwrapped", awaited === handle);

  // Probe safety (cordis's tuition, adopted wholesale): generic JS pokes at handles — none of
  // these may throw or receive a fake method.
  let stringified = "";
  try {
    stringified = JSON.stringify(handle);
  } catch {
    stringified = "THREW";
  }
  check("probe: JSON.stringify(handle) is safe (toJSON absent → undefined)", stringified === "{}");
  check("probe: _-prefixed / prototype / numeric reads are undefined",
    (handle as Record<string, unknown>)["_isMockFunction"] === undefined &&
    (handle as Record<string, unknown>)["prototype"] === undefined &&
    (handle as Record<string, unknown>)["0"] === undefined);
  check("probe: a typo'd (absent) method reads undefined, not a fake wrapper", (handle as Record<string, unknown>)["greetTypo"] === undefined);
  let deadStringified = "";
  try {
    deadStringified = JSON.stringify(deadServiceHandle("x"));
  } catch {
    deadStringified = "THREW";
  }
  check("probe: a dead handle survives JSON.stringify too", deadStringified === "{}");

  let notReplaceable = false;
  await registry.replace("greeter", {}).catch(() => {
    notReplaceable = true;
  });
  check("basics: replace on an undeclared service rejects", notReplaceable);

  let closed = false;
  const registry2 = new ServiceRegistry({ warn: () => undefined });
  registry2.register("db", { ping: () => "pong", close: () => { closed = true; } });
  await registry2.unregister("db");
  check("basics: unregister falls back to instance.close() for disposal", closed);
  let gone = false;
  try {
    registry2.handle<{ ping(): string }>("db").ping();
  } catch (error) {
    gone = error instanceof ServiceUnavailableError;
  }
  check("basics: calls after unregister throw ServiceUnavailableError", gone);
}

/** Replace semantics: atomic swap, in-flight drain, timeout, dispose routing. */
async function replaceFlow(): Promise<void> {
  const warnings: string[] = [];
  const registry = new ServiceRegistry({ warn: (message) => warnings.push(message) });

  const order: string[] = [];
  let releaseSlow!: () => void;
  const v1 = {
    label: () => "v1",
    slow: () =>
      new Promise<string>((resolve) => {
        releaseSlow = () => {
          order.push("slow-settled");
          resolve("slow-v1");
        };
      }),
    close: () => {
      order.push("v1-disposed");
    },
  };
  registry.register("svc", v1, { replaceable: true });

  const handle = registry.handle<typeof v1>("svc");
  const inFlight = handle.slow(); // lease taken on v1
  const v2 = { label: () => "v2", slow: () => Promise.resolve("slow-v2"), close: () => order.push("v2-disposed") };
  const replaced = registry.replace("svc", v2);
  await sleep(10);
  check("replace: while v1 drains, a new call on the SAME handle lands on v2", handle.label() === "v2");
  check("replace: dispose has not run while a lease is outstanding", !order.includes("v1-disposed"));
  releaseSlow();
  check("replace: the in-flight call completes on v1 with its own result", (await inFlight) === "slow-v1");
  await replaced;
  check("replace: v1 disposed only after its lease drained (order: settle then dispose)", order.join(",") === "slow-settled,v1-disposed");

  // Drain timeout: a call that never settles must not wedge replace forever.
  let wedgedDisposed = false;
  const wedged = { hang: () => new Promise(() => undefined), close: () => { wedgedDisposed = true; } };
  const registry3 = new ServiceRegistry({ warn: (message) => warnings.push(message) });
  registry3.register("w", wedged, { replaceable: true });
  void registry3.handle<typeof wedged>("w").hang();
  await registry3.replace("w", { hang: () => Promise.resolve() }, { drainTimeoutMs: 50 });
  check("replace: drain timeout warns and still disposes", wedgedDisposed && warnings.some((w) => w.includes("outstanding")));

  // Explicit dispose wins over close(); sync-throwing methods release their lease.
  let explicitDisposed = false;
  let closeCalled = false;
  const registry4 = new ServiceRegistry({ warn: () => undefined });
  const v3 = {
    boom: () => {
      throw new Error("sync");
    },
    close: () => {
      closeCalled = true;
    },
  };
  registry4.register("s", v3, { replaceable: true, dispose: () => { explicitDisposed = true; } });
  try {
    registry4.handle<typeof v3>("s").boom();
  } catch {
    // expected
  }
  await registry4.replace("s", { boom: () => undefined }, { drainTimeoutMs: 50 });
  check("replace: explicit dispose is used (close() not called)", explicitDisposed && !closeCalled);
  check("replace: a sync throw released its lease (no drain timeout warning path hit)", !warnings.some((w) => w.includes('"s"')));
}

/** `uses` through a real session: consumer untouched across replace; handle dies on detach. */
async function ctxIntegration(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Greet", { name: "ada" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("one", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("Greet", { name: "ada" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("two", { stopReason: "stop" }),
  ]);
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    services: {
      greeter: { instance: { greet: (name: string) => `hi ${name} v1` }, replaceable: true },
    },
  });
  const session = await harness.createSession();

  let stashed: Greeter | undefined;
  await session.attachExtension({
    id: "uses-service",
    uses: ["greeter"],
    session(api, { services }) {
      const svc = services.greeter as Greeter;
      stashed = svc;
      api.registerTool(tool({
        name: "Greet",
        description: "Greet via the shared service.",
        parameters: z.object({ name: z.string() }),
        execute: ({ name }) => svc.greet(name),
      }));
    },
  });

  const first = await session.prompt("go");
  check("ctx: extension tool consumes the host service through its handle", toolResultText(first.messages).includes("hi ada v1"));

  await harness.services.replace("greeter", { greet: (name: string) => `hi ${name} v2` });
  const second = await session.prompt("again");
  check("ctx: after harness.services.replace the SAME consumer lands on v2 (no detach/attach)", toolResultText(second.messages).includes("hi ada v2"));

  const stashedMethod = stashed!.greet.bind(undefined);
  await session.detachExtension("uses-service");
  let dead = false;
  try {
    stashed!.greet("x");
  } catch (error) {
    dead = error instanceof ServiceUnavailableError;
  }
  check("ctx: a stashed handle dies with its extension (detach collar)", dead);
  let deadMethod = false;
  try {
    stashedMethod("x");
  } catch (error) {
    deadMethod = error instanceof ServiceUnavailableError;
  }
  check("ctx: a METHOD stashed off the handle before detach dies too (call-time liveness)", deadMethod);

  let deadDirect = false;
  try {
    deadServiceHandle<Greeter>("nope").greet("x");
  } catch (error) {
    deadDirect = error instanceof ServiceUnavailableError;
  }
  check("ctx: deadServiceHandle throws on every call (no-services host path)", deadDirect);

  await harness.close();
  faux.unregister();
}

await registryBasics();
await replaceFlow();
await ctxIntegration();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
