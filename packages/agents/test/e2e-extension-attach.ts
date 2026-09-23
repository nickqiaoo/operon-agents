import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness, tool, type AgentEvent, type ExtensionActions, type ExtensionDefinition, type Message } from "../src/index.ts";

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

/** Attach on an idle session: contributions live at the next run; detach unwinds them all. */
async function attachLifecycle(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("no tools yet", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("AttachedEcho", { value: "hot" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("used tool", { stopReason: "stop" }),
    fauxAssistantMessage("gone", { stopReason: "stop" }),
  ]);
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  await session.prompt("one");

  const lifecycle: string[] = [];
  let modelRequests = 0;
  let stashedActions: ExtensionActions | undefined;
  const extension: ExtensionDefinition = {
    id: "hot-ext",
    session(api) {
      stashedActions = api.actions;
      api.registerTool(tool({
        name: "AttachedEcho",
        description: "Echo a value.",
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => `executed:${value}`,
      }));
      api.on("session.start", ({ reason }) => { lifecycle.push(`start:${reason}`); });
      api.on("session.end", ({ reason }) => { lifecycle.push(`end:${reason}`); });
      api.on("model.request", () => { modelRequests += 1; });
      return () => { lifecycle.push("teardown"); };
    },
  };

  await session.attachExtension(extension);
  check("attach: session.start fires with reason 'attach'", lifecycle.includes("start:attach"));

  const withTool = await session.prompt("two");
  check("attach: tool registered mid-session executes on the next run", toolResultText(withTool.messages).includes("executed:hot"));
  check("attach: handlers observe the next run", modelRequests >= 1);

  const requestsBeforeDetach = modelRequests;
  await session.detachExtension("hot-ext");
  check("detach: session.end('detach') fires before teardown", lifecycle.join(",").includes("end:detach,teardown"));

  const after = await session.prompt("three");
  check("detach: handlers are gone on the next run", modelRequests === requestsBeforeDetach && after.output === "gone");

  const records = await session.getRecords();
  const names = records.filter((r) => r.type === "custom").map((r) => (r as { name: string }).name);
  check("journal: attach and detach are both recorded", names.includes("extensions.attached") && names.includes("extensions.detached"));

  const receipt = stashedActions?.steer("zombie steer");
  check("revocation: stashed actions.steer is a warn-noop after detach", receipt === undefined);
  check("revocation: stashed getAllTools reports nothing", stashedActions?.getAllTools().length === 0);
  // The warn is fire-and-forget from the noop wrapper; give its emit a tick to land.
  await new Promise((resolve) => setTimeout(resolve, 10));
  check("revocation: the noop warns into the event stream", events.some((e) => e.type === "warning" && e.message.includes("[extension hot-ext]") && e.message.includes("detached")));

  await harness.close();
  faux.unregister();
}

/** A mid-run attach waits for the run's stop boundary instead of mutating the run in flight. */
async function midRunDeferred(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("long turn done", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("LateTool", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("late tool used", { stopReason: "stop" }),
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
      id: "gate",
      session(api) {
        api.on("model.request", async () => {
          if (!gateActive) return;
          enteredGate?.();
          await gateRelease;
        });
      },
    }],
  });
  const session = await harness.createSession();

  gateActive = true;
  const running = session.prompt("begin long turn");
  await gateEntered;

  let setupRan = false;
  const attaching = session.attachExtension({
    id: "late-ext",
    session(api) {
      setupRan = true;
      api.registerTool(tool({
        name: "LateTool",
        description: "Arrives late.",
        parameters: z.object({}),
        execute: () => "late-result",
      }));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  check("mid-run: session() does not run while the run is in flight", !setupRan);

  gateActive = false;
  releaseGate?.();
  await running;
  await attaching;
  check("mid-run: session() ran at the run's stop boundary", setupRan);

  const next = await session.prompt("use it");
  check("mid-run: the late tool serves the next run", toolResultText(next.messages).includes("late-result"));

  await harness.close();
  faux.unregister();
}

/** Rejections: bad ids, duplicates, unknown detach, session() failure — and failure frees the id. */
async function errorPaths(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  const rejected = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

  check("errors: empty id rejects", await rejected(session.attachExtension({ id: "  ", session: () => undefined })));

  await session.attachExtension({ id: "dup", session: () => undefined });
  check("errors: duplicate id rejects", await rejected(session.attachExtension({ id: "dup", session: () => undefined })));
  check("errors: unknown detach rejects", await rejected(session.detachExtension("never-attached")));

  check("errors: throwing session() rejects the attach", await rejected(session.attachExtension({
    id: "flaky",
    session: () => { throw new Error("boom"); },
  })));
  check("errors: failed session() warns into the event stream", events.some((e) => e.type === "warning" && e.message.includes("[extension flaky]")));
  let secondTryRan = false;
  await session.attachExtension({ id: "flaky", session: () => { secondTryRan = true; } });
  check("errors: a failed attach frees its id for retry", secondTryRan);

  await harness.close();
  faux.unregister();
}

/**
 * Cache guard: the assembled tool registry must serialize identically across runs when nothing
 * changed — an unstable order would silently bust the provider's prompt cache every turn.
 */
async function registryStability(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first", { stopReason: "stop" }),
    fauxAssistantMessage("second", { stopReason: "stop" }),
  ]);
  const perRunToolLists: string[] = [];
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [{
      id: "stability-probe",
      session(api) {
        api.registerTool(tool({ name: "ZTool", description: "z", parameters: z.object({}), execute: () => "z" }));
        api.registerTool(tool({ name: "ATool", description: "a", parameters: z.object({}), execute: () => "a" }));
        api.on("model.request", ({ request }) => {
          perRunToolLists.push(JSON.stringify(request.tools ?? []));
        });
      },
    }],
  });
  const session = await harness.createSession();
  await session.prompt("one");
  await session.prompt("two");
  check("stability: two identical assemblies serialize byte-identically", perRunToolLists.length === 2 && perRunToolLists[0] === perRunToolLists[1]);
  check("stability: the registry actually carried the extension tools", perRunToolLists[0]?.includes("ZTool") === true && perRunToolLists[0]?.includes("ATool") === true);

  await harness.close();
  faux.unregister();
}

/** Each extension is its own capability: named by its id, one per extension, never displacing
 *  a capability the session already has. */
async function oneCapabilityPerExtension(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
  const handle = { ping: () => "pong" };
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [
      { id: "ext-one", session: (api) => void api.expose(handle) },
      { id: "ext-two", session: () => undefined },
    ],
  });
  const session = await harness.createSession();
  const names = session.core.capabilities.map((capability) => capability.name);
  check("per-extension: each extension is a capability named by its id", names.includes("ext-one") && names.includes("ext-two"));
  check("per-extension: extensions come first, in registration order", names.indexOf("ext-one") === 0 && names.indexOf("ext-two") === 1);
  check("per-extension: session.service(id) is what the extension exposed", session.core.service("ext-one") === handle);
  check("per-extension: extensionHandle(id) agrees", session.extensionHandle("ext-one") === handle);
  check("per-extension: attachedExtensionIds lists only extensions", session.attachedExtensionIds().join() === "ext-one,ext-two");
  let detachError = "";
  try {
    await session.detachExtension("goal");
  } catch (error) {
    detachError = (error as Error).message;
  }
  check("per-extension: detachExtension refuses a capability that is not an extension", /unknown extension "goal"/.test(detachError));
  await harness.close();

  const clashing = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [{ id: "goal", session: () => undefined }],
  });
  let openError = "";
  try {
    await clashing.createSession();
  } catch (error) {
    openError = (error as Error).message;
  }
  check("per-extension: an id that names a session capability is refused by name", /extension "goal" has the name of one of this session's capabilities/.test(openError));
  await clashing.close();
  faux.unregister();
}

await attachLifecycle();
await midRunDeferred();
await errorPaths();
await registryStability();
await oneCapabilityPerExtension();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
