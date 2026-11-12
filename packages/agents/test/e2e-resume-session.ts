/**
 * `resumeSession(id)` attaches to a loaded session, joins a load in flight, or restores from
 * storage. Given options it only restores: they cannot be applied to an instance that already
 * exists, so it refuses rather than drop them. Restoration never replaces configuration, closes
 * handles, or creates missing conversations.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness, defineAgent, HarnessConfigError, SessionAlreadyLoadedError, SessionAlreadyLoadingError, SessionClosedError, SessionRepositoryNotFoundError, type Tool, type ExtensionActions } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const rejectsWith = (promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<boolean> =>
  promise.then(() => false, (error: unknown) => error instanceof type);

function provider() {
  return registerFauxProvider({ provider: "faux", models: [{ id: "main" }, { id: "other" }] });
}

async function missingAndRunning(): Promise<void> {
  const faux = provider();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [{ id: "gate", session(api) { api.on("model.request", async () => { started.resolve(); await release.promise; }); } }],
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  check("missing: not found", await rejectsWith(harness.resumeSession("nope"), SessionRepositoryNotFoundError));

  const session = await harness.createSession();
  const running = session.prompt("hi");
  await started.promise;
  check("running: no options attaches to the instance in flight", await harness.resumeSession(session.id) === session);
  check("running: a setting is refused, not dropped", await rejectsWith(harness.resumeSession(session.id, {
    config: { model: "faux/other" }
  }), SessionAlreadyLoadedError));
  check("running: getSession still reaches it", harness.getSession(session.id) === session);
  release.resolve();
  await running;

  const fake = session as unknown as { background: unknown };
  Object.defineProperty(fake, "background", { configurable: true, get: () => ({ list: () => [{ id: "task" }], reconcileSubagents: async () => [] }) });
  let reconciled = 0;
  Object.defineProperty(fake, "background", { configurable: true, get: () => ({ list: () => [{ id: "task" }], reconcileSubagents: async () => { reconciled++; return []; } }) });
  check("background: attaching leaves live tasks alone", await harness.resumeSession(session.id) === session && reconciled === 0);
  delete fake.background;
  await harness.close();
  faux.unregister();
}

async function settingsRequireExplicitSetters(): Promise<void> {
  const faux = provider();
  const harness = createHarness({
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const session = await harness.createSession<unknown>({ bindings: { context: "first" } } as never);
  check("loaded: settings cannot implicitly mutate the instance", await rejectsWith(
    harness.resumeSession(session.id, {
    config: { model: "faux/other", permission: { mode: "manual" } },
    bindings: { context: "second" }
  }),
    SessionAlreadyLoadedError,
  ));
  check("loaded: original configuration remains", session.context === "first" && session.modelSetting !== "faux/other" && session.permissionMode !== "manual");
  check("loaded: no options attaches and changes nothing", await harness.resumeSession(session.id) === session && session.context === "first" && session.permissionMode !== "manual");
  session.setModel("faux/other");
  session.setContext("second");
  await session.setPermissionMode("manual");
  check("setters: explicit settings still work", session.context === "second" && session.modelSetting === "faux/other" && session.permissionMode === "manual");
  await harness.close();
  faux.unregister();
}

async function storedStateMatchesLoaded(): Promise<void> {
  const faux = provider();
  const harness = createHarness({
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const session = await harness.createSession({
    config: { model: "faux/other" }
  });
  await session.setPermissionMode("manual");
  await session.close();
  const reopened = await harness.resumeSession(session.id);
  check("reopen: the model id is remembered", reopened.modelSetting === "faux/other");
  check("reopen: the runtime mode is remembered", reopened.permissionMode === "manual");
  await reopened.close();
  const overridden = await harness.resumeSession(session.id, {
    config: { model: "faux/main", permission: { mode: "yolo" } }
  });
  check("reopen: explicit model beats stored model", overridden.modelSetting === "faux/main");
  check("reopen: an explicit mode beats the stored one", overridden.permissionMode === "yolo");
  await harness.close();
  faux.unregister();
}

async function assemblyRequiresExplicitClose(): Promise<void> {
  const faux = provider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("Bash", { command: "touch .probe && echo hi" }), { stopReason: "toolUse" })]);
  const harness = createHarness({
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "manual" } } }
  });
  const session = await harness.createSession();
  check("approval: the run paused", (await session.prompt("go")).status === "interrupted");
  session.core.steer.steer("task finished", { kind: "background_done", taskId: "t1" });

  const agent = defineAgent({ name: "replacement", model: faux.getChatModel()!, instructions: "x" });
  check("loaded: assembly options do not rebuild", await rejectsWith(
    harness.resumeSession(session.id, {
    config: { permission: { mode: "manual", rules: [] } },
    bindings: { agent: agent }
  }), SessionAlreadyLoadedError,
  ));
  check("loaded: original handle and queued messages survive", harness.getSession(session.id) === session && session.status.hasQueuedMessages);
  check("loaded: pending approval survives", session.status.state === "interrupted" && (await session.pendingInterruptions()).length === 1);

  await harness.closeSession(session.id);
  check("explicit close: old handle is closed", await rejectsWith(session.prompt("x"), SessionClosedError));
  const opening = harness.resumeSession(session.id, {
    config: { permission: { mode: "manual", rules: [] } },
    bindings: { agent: agent }
  });
  const joined = harness.resumeSession(session.id);
  check("opening: options beside a load in flight are refused", await rejectsWith(harness.resumeSession(session.id, {
    config: { permission: { mode: "yolo" } }
  }), SessionAlreadyLoadingError));
  const restored = await opening;
  check("opening: no options joins the load in flight", await joined === restored);
  check("explicit restore: a fresh instance is registered", restored !== session && harness.getSession(session.id) === restored);
  check("explicit restore: pending approval persists", restored.status.state === "interrupted" && (await restored.pendingInterruptions()).length === 1);
  await harness.close();
  faux.unregister();
}

async function conflictsAreRefused(): Promise<void> {
  const faux = provider();
  const agent = defineAgent({ name: "complete", model: faux.getChatModel()!, instructions: "x" });
  const tools: readonly Tool[] = [];
  const harness = createHarness({
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const session = await harness.createSession();
  check("conflict: agent beside its default-agent options is refused", await rejectsWith(harness.resumeSession(session.id, {
    bindings: { agent: agent, tools: tools }
  }), HarnessConfigError));
  await harness.close();
  faux.unregister();
}

async function failedRestorationCanRetry(): Promise<void> {
  const faux = provider();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let fail = false;
  const harness = createHarness({
    ...faux.harnessModel(),
    sessionCapabilities: async () => {
      if (fail) { entered.resolve(); await release.promise; throw new Error("restore setup failed"); }
      return [];
    },
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const original = await harness.createSession();
  await original.close();
  fail = true;
  const restoring = harness.resumeSession(original.id).then(() => undefined, (error: unknown) => error);
  await entered.promise;
  check("opening: getSession exposes no partial instance", harness.getSession(original.id) === undefined);
  check("opening: conflicting config cannot join silently", await rejectsWith(harness.resumeSession(original.id, {
    config: { model: "faux/other" }
  }), SessionAlreadyLoadingError));
  release.resolve();
  const failure = await restoring;
  check("failure: original setup error is reported", failure instanceof Error && failure.message === "restore setup failed");
  check("failure: no runtime remains registered", harness.getSession(original.id) === undefined);
  fail = false;
  const retried = await harness.resumeSession(original.id);
  check("failure: restoration can be retried", harness.getSession(original.id) === retried);
  await harness.close();
  faux.unregister();
}

async function extensionRestoration(): Promise<void> {
  const faux = provider();
  let actions: ExtensionActions | undefined;
  const resolved: string[] = [];
  const harness = createHarness<string>({
    ...faux.harnessModel(),
    resolveSession: ({ operation, session }) => {
      if (operation !== "restore") return;
      resolved.push(session.id);
      return { bindings: { context: "host restored" } };
    },
    extensions: [{ id: "host-probe", session(api) { actions = api.actions; } }],
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const target = await harness.createSession();
  await target.close();
  await harness.createSession();
  const resumed = await actions!.resumeSession(target.id);
  check("extension: restores through the harness, resolved by the host", resolved.length === 1 && resolved[0] === target.id && harness.getSession(target.id)?.context === "host restored");
  check("extension: repeated access reuses the instance without resolving again", await actions!.resumeSession(target.id) === resumed && resolved.length === 1);
  await harness.close();

  const plain = createHarness({
    ...faux.harnessModel(),
    extensions: [{ id: "host-probe", session(api) { actions = api.actions; } }],
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const source = await plain.createSession();
  check("extension: a loaded target needs no host configuration", await actions!.resumeSession(source.id) === source);
  await plain.createSession();
  await source.close();
  const reopened = await actions!.resumeSession(source.id);
  check("extension: a closed one is restored from what is stored with it", plain.getSession(source.id) === reopened && reopened !== source);
  await plain.close();
  faux.unregister();
}

async function concurrentRestoration(): Promise<void> {
  const faux = provider();
  let resolves = 0;
  let opens = 0;
  const harness = createHarness({
    ...faux.harnessModel(),
    resolveSession: async ({ operation }) => {
      if (operation === "restore") { resolves++; await new Promise((resolve) => setTimeout(resolve, 20)); }
    },
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  harness.onSessionOpened((_session, info) => { if (info.operation === "restore") opens++; });
  const original = await harness.createSession();
  await original.close();
  const all = await Promise.all(Array.from({ length: 10 }, () => harness.resumeSession(original.id)));
  check("concurrent: ten callers get one instance", all.every((session) => session === all[0]) && harness.getSession(original.id) === all[0]);
  check("concurrent: the host resolved and wired it once", resolves === 1 && opens === 1);

  // A close that lands while a load is in flight cancels it: nobody is handed a dead session.
  await all[0]!.close();
  const loading = harness.resumeSession(original.id);
  const closing = harness.closeSession(original.id);
  check("close during load: the waiter is refused", await rejectsWith(loading, SessionClosedError));
  await closing;
  check("close during load: nothing stays registered", harness.getSession(original.id) === undefined);
  const again = await harness.resumeSession(original.id);
  check("close during load: it can be restored afterwards", harness.getSession(original.id) === again);
  await harness.close();
  faux.unregister();
}

await missingAndRunning();
await settingsRequireExplicitSetters();
await storedStateMatchesLoaded();
await assemblyRequiresExplicitClose();
await conflictsAreRefused();
await failedRestorationCanRetry();
await extensionRestoration();
await concurrentRestoration();

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exit(1);
