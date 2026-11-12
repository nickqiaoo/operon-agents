/**
 * One way to open a session, whichever entry point asks.
 *
 * A session's setup is data (`SessionConfig`) stored with it; the live objects it runs on
 * (`SessionBindings`) are provided again on every open, by the caller or by `resolveSession`. This
 * walks the whole contract on one harness: two sessions that see different MCP servers, closed,
 * restored and forked; what a failed open leaves behind (nothing); when a host's wiring runs
 * (before the first run); what a restore may not quietly widen or replace (permission, a sandbox);
 * and that configuration written in code and in a `config.toml` is the same configuration.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, offeredToolNames, registerFauxProvider, type Context } from "./faux.ts";
import {
  createHarness,
  createLocalHarness,
  defineAgent,
  HarnessConfigError,
  loadHarnessConfig,
  LocalEnvironment,
  normalizeHarnessConfig,
  parseSessionConfig,
  resolveSessionConfig,
  SessionDependencyMissingError,
  SessionPolicyViolationError,
  type AgentEvent,
  type ExtensionActions,
  type ExtensionDefinition,
  type HarnessConfig,
  type SessionConfig,
  type SessionOpenInfo,
} from "../src/index.ts";
import { createMcpServers, defaultCapabilities, MemorySessionRepository, type HarnessInfrastructure, type McpServerConfig } from "../src/advanced.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const rejectsWith = (promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<boolean> =>
  promise.then(() => false, (error: unknown) => error instanceof type);

/** A transport whose single tool is named per tier, so a tool name says who made the connection. */
function transport(toolName: string, counters: { connects: number; closes: number }) {
  return (name: string) => ({
    name,
    async connect() { counters.connects += 1; },
    async close() { counters.closes += 1; },
    async listTools() { return [{ name: toolName, description: toolName, inputSchema: { type: "object", properties: {} } }]; },
    async callTool() { return { content: [{ type: "text", text: "hi" }] }; },
  });
}

const names = (session: { readonly mcp?: { list(): readonly { readonly name: string }[] } | undefined }): string =>
  (session.mcp?.list() ?? []).map((view) => view.name).sort().join(",");

// ── Two sessions, two MCP sets: created, closed, restored, forked ────────────────────────────

async function differentMcpPerSession(): Promise<void> {
  const faux = registerFauxProvider();
  const shared = { connects: 0, closes: 0 };
  const own = { connects: 0, closes: 0 };
  // The harness's default set, in the shape every source of configuration normalizes to.
  const defaults = (parseSessionConfig({
    mcp: { servers: { docs: { transport: "http", url: "http://docs.example" }, search: { transport: "http", url: "http://search.example" } } },
  }).mcp as { servers: Record<string, McpServerConfig> }).servers;
  let infrastructure: HarnessInfrastructure = {};
  const harness = createHarness({
    ...faux.harnessModel(),
    infrastructure: async () => {
      const servers = createMcpServers(defaults, { transportFactory: transport("shared_tool", shared) });
      await servers.connect({ sessionId: "" });
      infrastructure = { mcpServers: servers, mcpServerConfigs: defaults, close: () => servers.shutdown() };
      return infrastructure;
    },
    sessionCapabilities: (ctx) => defaultCapabilities({
      shared: infrastructure,
      ownEnvironment: ctx.ownEnvironment,
      ...(ctx.config.mcp !== undefined ? { mcp: ctx.config.mcp } : {}),
      mcpTransportFactory: transport("own_tool", own),
    }),
    config: { ...{ defaults: { mcp: { servers: defaults } } }, defaults: { ...({ defaults: { mcp: { servers: defaults } } }).defaults, ...faux.harnessModel().config.defaults } }
  });

  const plain = await harness.createSession();
  check("mcp: a session that names nothing sees the harness's default set", names(plain) === "docs,search");
  check("mcp: …over the process's connections, not its own", shared.connects === 2 && own.connects === 0);

  const custom = await harness.createSession({
    config: { mcp: { servers: { docs: defaults["docs"]!, notes: { transport: "http", url: "http://notes.example" } } } },
  });
  check("mcp: a session that names its servers sees exactly those", names(custom) === "docs,notes");
  check("mcp: the server it shares with the harness is the shared connection", (await custom.mcp!.listTools("docs")).some((tool) => tool.name === "shared_tool"));
  check("mcp: the one it alone names is its own connection", own.connects === 1 && (await custom.mcp!.listTools("notes")).some((tool) => tool.name === "own_tool"));

  const renamed = await harness.createSession({ config: { mcp: { servers: { docs: { transport: "http", url: "http://other-docs.example" } } } } });
  check("mcp: the same name with another configuration is not the shared server", (await renamed.mcp!.listTools("docs")).some((tool) => tool.name === "own_tool"));
  const none = await harness.createSession({ config: { mcp: false } });
  const empty = await harness.createSession({ config: { mcp: { servers: {} } } });
  check("mcp: `false` and an empty set both mean no servers", names(none) === "" && names(empty) === "");
  check("mcp: one session's choice does not reach another", names(plain) === "docs,search");

  const ownBefore = own.closes;
  await custom.close();
  check("close: the session's own connection goes down with it", own.closes === ownBefore + 1);
  check("close: the shared connections stay up for everyone else", shared.closes === 0 && (await plain.mcp!.listTools("docs")).some((tool) => tool.name === "shared_tool"));

  const restored = await harness.resumeSession(custom.id);
  check("restore: no options, and the session sees its own set again", restored !== custom && names(restored) === "docs,notes");
  const fork = await harness.forkSession(custom.id);
  check("fork: the setup is copied with the history", names(fork) === "docs,notes");
  const narrowed = await harness.forkSession(custom.id, { config: { mcp: { servers: { notes: { transport: "http", url: "http://notes.example" } } } } });
  check("fork: a field given replaces the source's", names(narrowed) === "notes");
  await fork.close();
  await narrowed.close();
  await restored.close();
  check("restore/fork: closing them never touched the shared connections", shared.closes === 0 && names(plain) === "docs,search");
  await harness.close();
  check("harness close: the shared connections come down last", shared.closes === 2);
  faux.unregister();
}

// ── A failed open leaves nothing: no record, no instance, no held resource ───────────────────

async function failedOpenLeavesNothing(): Promise<void> {
  const faux = registerFauxProvider();
  let failAt: "resolver" | "capabilities" | "listener" | undefined;
  let resolverReleases = 0;
  const harness = createHarness({
    ...faux.harnessModel(),
    resolveSession: () => {
      if (failAt === "resolver") throw new Error("resolver refused");
      return { bindings: { release: () => { resolverReleases += 1; } } };
    },
    sessionCapabilities: () => {
      if (failAt === "capabilities") throw new Error("capabilities failed");
      return [];
    },
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  harness.onSessionOpened(() => {
    if (failAt === "listener") throw new Error("listener refused");
  });

  for (const stage of ["resolver", "capabilities", "listener"] as const) {
    failAt = stage;
    let released = 0;
    const before = (await harness.listSessions()).length;
    const resolverBefore = resolverReleases;
    const failed = await harness.createSession({ bindings: { release: () => { released += 1; } } }).then(() => undefined, (error: unknown) => error);
    check(`failure at ${stage}: the open is refused with that error`, failed instanceof Error && failed.message.includes(stage === "capabilities" ? "capabilities failed" : `${stage} refused`));
    check(`failure at ${stage}: the caller's resources are released exactly once`, released === 1);
    check(`failure at ${stage}: what the host resolved is released too`, resolverReleases === resolverBefore + (stage === "resolver" ? 0 : 1));
    check(`failure at ${stage}: no record and no instance remain`, (await harness.listSessions()).length === before && harness.sessions.size === 0);
  }

  failAt = undefined;
  let released = 0;
  const session = await harness.createSession({ bindings: { release: () => { released += 1; } } });
  check("success: nothing is released while the session is open", released === 0);
  failAt = "listener";
  const forksBefore = (await harness.listSessions()).length;
  check("failure on fork: refused", await harness.forkSession(session.id).then(() => false, () => true));
  check("failure on fork: the copy is removed, the source is untouched", (await harness.listSessions()).length === forksBefore && harness.getSession(session.id) === session);
  failAt = undefined;
  await session.close();
  await session.close();
  check("close: released exactly once", released === 1);

  failAt = "capabilities";
  check("failure on restore: refused", await harness.resumeSession(session.id).then(() => false, () => true));
  check("failure on restore: the record stays — it was not this open's to remove", (await harness.listSessions()).some((summary) => summary.id === session.id));
  check("failure on restore: a setup that could not be assembled does not replace the stored one", await harness.resumeSession(session.id, { config: { limits: { maxTurns: 2 } } }).then(() => false, () => true));
  failAt = undefined;
  const retried = await harness.resumeSession(session.id);
  check("failure on restore: it can be retried", retried.id === session.id && retried.config.limits?.maxTurns === undefined);
  await harness.close();
  faux.unregister();
}

// ── Wiring: every session, before its first run, whoever opened it ───────────────────────────

async function wiredBeforeTheFirstRun(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("took the queued message", { stopReason: "stop" })]);
  let actions: ExtensionActions | undefined;
  const probe: ExtensionDefinition = { id: "probe", session(api) { actions ??= api.actions; } };
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [probe],
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const opened: Array<{ readonly id: string; readonly info: SessionOpenInfo }> = [];
  const events = new Map<string, AgentEvent[]>();
  const cleaned: string[] = [];
  let ranBeforeWired = false;
  let visibleBeforeWired = false;
  harness.onSessionOpened(async (session, info) => {
    opened.push({ id: session.id, info });
    visibleBeforeWired ||= harness.sessions.has(session.id) || harness.getSession(session.id) !== undefined;
    if (info.operation === "create" && info.origin.kind === "host") {
      // A message accepted while the session is still being wired must wait for the wiring.
      session.followUp("queued during the open");
      await new Promise((resolve) => setTimeout(resolve, 20));
      ranBeforeWired = session.status.state === "running";
    }
    const seen: AgentEvent[] = [];
    events.set(session.id, seen);
    const off = session.onEvent((event) => { seen.push(event); });
    return () => { off(); cleaned.push(session.id); };
  });

  const session = await harness.createSession({ ownerKey: "tenant-a" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await session.whenIdle();
  check("wiring: an unfinished instance is not public", !visibleBeforeWired);
  check("wiring: no run starts before the open listeners are done", !ranBeforeWired);
  check("wiring: the listener saw the first event of the run that was waiting", events.get(session.id)!.some((event) => event.type === "agent.started"));

  await harness.resumeSession(session.id);
  check("wiring: attaching to a loaded session does not wire it again", opened.length === 1);

  const child = await actions!.createSession({ title: "child" });
  const created = opened.find((entry) => entry.id === child.id);
  check("wiring: a session an extension creates is wired like any other", created?.info.origin.kind === "extension" && created.info.origin.extensionId === "probe" && created.info.source?.id === session.id);
  const childSession = harness.getSession(child.id)!;
  check("extension create: it takes its creator's directory and owner", childSession.workDir === session.workDir && childSession.ownerKey === "tenant-a");
  const forked = await actions!.forkSession({ title: "fork" });
  check("wiring: so is one it forks", opened.some((entry) => entry.id === forked.id && entry.info.operation === "fork" && entry.info.origin.kind === "extension"));

  await session.close();
  check("wiring: the listener's cleanup runs when that instance closes", cleaned.length === 1 && cleaned[0] === session.id);
  const reopened = await harness.resumeSession(session.id);
  check("wiring: a reopened session is a new instance, wired again", opened.filter((entry) => entry.id === session.id).length === 2 && reopened !== session);
  await harness.close();
  check("wiring: every cleanup ran by the time the harness closed", new Set(cleaned).size === 3 && cleaned.length === 4);
  faux.unregister();
}

// ── Permission: a restore never widens, an override never drops the harness's rules ──────────

async function permissionIsNotWidened(): Promise<void> {
  const faux = registerFauxProvider();
  const repository = new MemorySessionRepository();
  const deny = { decision: "deny" as const, scope: "user" as const, pattern: "Bash(rm *)" };
  const pinned = { decision: "deny" as const, scope: "user" as const, pattern: "Bash(curl *)" };
  const harness = createHarness({
    ...faux.harnessModel(),
    infrastructure: () => ({ sessionRepository: repository }),
    config: { ...{
      defaults: { permission: { mode: "workspace", rules: [deny] } },
      policy: { permission: { allowedModes: ["manual", "workspace"], rules: [pinned] } },
    }, defaults: { ...({
      defaults: { permission: { mode: "workspace", rules: [deny] } },
      policy: { permission: { allowedModes: ["manual", "workspace"], rules: [pinned] } },
    }).defaults, ...faux.harnessModel().config.defaults } }
  });
  const session = await harness.createSession({ config: { permission: { mode: "manual" } } });
  check("permission: the session's mode applies", session.permissionMode === "manual");
  check("permission: overriding the mode keeps the harness's rules", session.config.permission?.rules?.some((rule) => rule.pattern === deny.pattern) === true);
  await session.close();
  const restored = await harness.resumeSession(session.id);
  check("permission: a restore with no options keeps the mode it was created with", restored.permissionMode === "manual");
  await restored.setPermissionMode("workspace");
  await restored.close();
  check("permission: a mode set at runtime is what the next restore uses", (await harness.resumeSession(session.id)).permissionMode === "workspace");

  const before = (await harness.listSessions()).length;
  const refused = await harness.createSession({ config: { permission: { mode: "yolo" } } }).then(() => undefined, (error: unknown) => error);
  check("policy: a mode outside the allowed ones is refused, not downgraded", refused instanceof SessionPolicyViolationError && refused.field === "permission.mode");
  check("policy: the refused session left no record", (await harness.listSessions()).length === before);
  const switched = await harness.resumeSession(session.id);
  check("policy: it holds for a running session too — a runtime switch outside it is refused", await rejectsWith(switched.setPermissionMode("yolo"), SessionPolicyViolationError) && switched.permissionMode === "workspace");
  const own = await harness.createSession({ config: { permission: { rules: [] } } });
  check("policy: a session can replace its rules, never the policy's", own.config.permission?.rules?.length === 0);
  await harness.close();

  // Only what a session was explicitly given is stored: everything else follows the harness.
  const later = createHarness({
    ...faux.harnessModel(),
    infrastructure: () => ({ sessionRepository: repository }),
    config: { ...{ defaults: { permission: { mode: "workspace" }, limits: { maxTurns: 9 } } }, defaults: { ...({ defaults: { permission: { mode: "workspace" }, limits: { maxTurns: 9 } } }).defaults, ...faux.harnessModel().config.defaults } }
  });
  const followed = await later.resumeSession(own.id);
  check("defaults: a field the session never set follows the harness's current value", followed.config.limits?.maxTurns === 9);
  check("defaults: a field it did set stays its own", followed.config.permission?.rules?.length === 0);
  await later.close();
  faux.unregister();
}

// ── Live objects: provided again, never silently replaced by a default ───────────────────────

async function liveObjectsAreProvidedAgain(): Promise<void> {
  const faux = registerFauxProvider();
  const dir = mkdtempSync(join(tmpdir(), "session-config-"));
  try {
    let actions: ExtensionActions | undefined;
    const probe: ExtensionDefinition = { id: "probe", session(api) { actions ??= api.actions; } };
    const bare = createHarness({
    ...faux.harnessModel(),
    extensions: [probe],
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
    const sandbox = new LocalEnvironment(dir);
    const session = await bare.createSession({ bindings: { environment: sandbox } });
    check("requires: a session remembers which kinds of live object it runs on", session.requires.includes("environment") && session.environment === sandbox);

    const before = (await bare.listSessions()).length;
    const fromExtension = await actions!.createSession().then(() => undefined, (error: unknown) => error);
    check("extension create: from a sandboxed session, without one, is refused", fromExtension instanceof SessionDependencyMissingError && fromExtension.missing.includes("environment"));
    check("extension fork: likewise — it never lands on the harness's own filesystem", await rejectsWith(actions!.forkSession(), SessionDependencyMissingError));
    check("fork: the host forking it without a sandbox is refused too", await rejectsWith(bare.forkSession(session.id), SessionDependencyMissingError));
    check("refused opens leave no record", (await bare.listSessions()).length === before);

    await session.close();
    check("restore: without the sandbox it is refused", await rejectsWith(bare.resumeSession(session.id), SessionDependencyMissingError));
    const again = await bare.resumeSession(session.id, { bindings: { environment: sandbox } });
    check("restore: with it, the session is back where it ran", again.environment === sandbox);
    await bare.close();

    // The same, with the host supplying live objects where the harness asks for them.
    actions = undefined;
    const resolved: string[] = [];
    const hosted = createHarness<{ readonly user: string }>({
    ...faux.harnessModel(),
    extensions: [probe],
    resolveSession: ({ operation, origin, session: identity, source }) => {
        resolved.push(`${operation}:${origin.kind}:${source?.id ?? "-"}`);
        return { bindings: { environment: new LocalEnvironment(identity.workDir), context: { user: identity.ownerKey ?? "nobody" } } };
      },
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
    const first = await hosted.createSession({ workDir: dir, ownerKey: "alice" });
    check("resolver: supplies the sandbox and the context on create", first.requires.includes("environment") && first.context?.user === "alice");
    const spawned = await actions!.createSession();
    check("resolver: is asked for what an extension creates, with its source", resolved.includes(`create:extension:${first.id}`) && hosted.getSession(spawned.id)?.context?.user === "alice");
    const forked = await actions!.forkSession();
    check("resolver: and for what it forks", resolved.includes(`fork:extension:${first.id}`) && hosted.getSession(forked.id) !== undefined);
    await first.close();
    const restored = await hosted.resumeSession(first.id);
    check("resolver: a restore needs no options", restored.context?.user === "alice" && resolved.includes("restore:host:-"));
    await hosted.close();

    const reentrant: { harness?: ReturnType<typeof createHarness> } = {};
    reentrant.harness = createHarness({
    ...faux.harnessModel(),
    resolveSession: async ({ session: identity }) => { await reentrant.harness!.resumeSession(identity.id); },
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
    check("resolver: it supplies, it does not open the session it is resolving", await rejectsWith(reentrant.harness.createSession(), HarnessConfigError));
    await reentrant.harness.close();

    const isolated = createHarness({
    ...faux.harnessModel(),
    sessionCapabilities: () => [],
    config: { ...{ defaults: {}, policy: { strictIsolation: true } }, defaults: { ...({ defaults: {}, policy: { strictIsolation: true } }).defaults, ...faux.harnessModel().config.defaults } }
  });
    check("policy: an isolating host refuses a session without its own environment", await rejectsWith(isolated.createSession(), SessionPolicyViolationError));
    check("policy: and opens one that brings it", (await isolated.createSession({ bindings: { environment: sandbox } })).environment === sandbox);
    await isolated.close();
  } finally {
    faux.unregister();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── One configuration, whichever way it was written ──────────────────────────────────────────

async function oneConfigurationDefinition(): Promise<void> {
  const faux = registerFauxProvider();
  const home = mkdtempSync(join(tmpdir(), "session-config-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "session-config-cwd-"));
  try {
    writeFileSync(join(home, "config.toml"), [
      'model = "faux/from-file"',
      'tools = ["Read"]',
      "",
      "[permission]",
      'mode = "manual"',
      "",
      "[loopControl]",
      "maxTurns = 4",
      "",
      "[mcpServers.docs]",
      'url = "http://docs.example"',
      "",
      "[extensions.seat]",
      "number = 1",
      "",
      "[policy]",
      "allowedMcpTransports = [\"http\"]",
      "",
    ].join("\n"));
    const fromFile = await loadHarnessConfig({ homeDir: home, cwd });
    const raw = {
      model: "faux/from-file",
      tools: ["Read"],
      permission: { mode: "manual" },
      loopControl: { maxTurns: 4 },
      mcpServers: { docs: { url: "http://docs.example" } },
      extensions: { seat: { number: 1 } },
      policy: { allowedMcpTransports: ["http"] },
    };
    const fromData = normalizeHarnessConfig(raw);
    const inCode: HarnessConfig = {
      defaults: {
        model: "faux/from-file",
        tools: ["Read"],
        permission: { mode: "manual" },
        limits: { maxTurns: 4 },
        mcp: { servers: { docs: { transport: "http", url: "http://docs.example" } as McpServerConfig } },
        extensions: { seat: { number: 1 } },
      },
      policy: { allowedMcpTransports: ["http"] },
    };
    const built = (config: HarnessConfig) => {
      const harness = createHarness({ modelManager: faux.harnessModel().modelManager, config });
      return JSON.stringify({ defaults: harness.defaults, policy: harness.policy });
    };
    check("sources: a config.toml and the same data from anywhere else normalize alike", JSON.stringify(fromFile) === JSON.stringify(fromData));
    check("sources: a harness built from the file and one built in code run on the same configuration", built(fromFile) === built(inCode));

    const defaults: SessionConfig = inCode.defaults;
    const omitted = resolveSessionConfig(defaults, {});
    const off = resolveSessionConfig(defaults, { mcp: false });
    const none = resolveSessionConfig(defaults, { mcp: { servers: {} }, tools: [] });
    check("override: left out inherits, `false` turns off, empty means none", omitted.mcp !== false && omitted.mcp !== undefined && off.mcp === false && none.mcp !== false && Object.keys((none.mcp as { servers: object }).servers).length === 0 && none.tools?.length === 0);
    const mode = resolveSessionConfig({ permission: { mode: "workspace", rules: [{ decision: "deny", scope: "user", pattern: "Bash(rm *)" }] } }, { permission: { mode: "manual" } });
    check("override: settings change one key at a time, collections whole", mode.permission?.mode === "manual" && mode.permission.rules?.length === 1);
    let unknownKey = false;
    try { parseSessionConfig({ modle: "x" }); } catch { unknownKey = true; }
    check("validation: a misspelt key is an error, not a silent no-op", unknownKey);
  } finally {
    faux.unregister();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── Names resolve against what the harness registered; what identifies a session is not forked ─

async function namesAndForkedParameters(): Promise<void> {
  const faux = registerFauxProvider();
  let offered: string[] = [];
  faux.setResponses([
    (context: Context) => { offered = offeredToolNames(context); return fauxAssistantMessage("ok", { stopReason: "stop" }); },
    fauxAssistantMessage("reviewed", { stopReason: "stop" }),
  ]);
  const reviewer = defineAgent({ name: "reviewer", model: faux.getChatModel()!, instructions: "review" });
  const params = new Map<string, Record<string, unknown>>();
  const record = (id: string): ExtensionDefinition => ({
    id,
    ...(id === "seat" ? { forkParams: "drop" as const } : {}),
    session(api, ctx) {
      api.on("session.start", ({ actions }) => {
        const sessionId = (actions as unknown as { readonly sessionId?: string }).sessionId ?? "";
        params.set(`${id}:${sessionId}`, { value: ctx.params });
      });
    },
  });
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [record("seat"), record("label")],
    config: { defaults: { ...faux.harnessModel().config.defaults } },
    registry: { agents: { reviewer } }
  });

  // The default agent's profile names its tools; a session's `tools` narrows what those resolve to.
  const picked = await harness.createSession({ config: { tools: ["Read"], extensions: { seat: { number: 7 }, label: { text: "blue" } } } });
  await picked.prompt("hi");
  check("names: a session's tools are the registered ones it names", offered.includes("Read") && !offered.includes("Bash"));
  check("names: an unregistered tool is an error that says which", await harness.createSession({ config: { tools: ["Gamma"] } }).then(() => false, (error: unknown) => error instanceof HarnessConfigError && error.message.includes("Gamma")));
  const reviewing = await harness.createSession({ config: { agent: "reviewer" } });
  check("names: an agent is run by its registered name", (await reviewing.prompt("look")).finalAgent === "reviewer");
  check("names: an unregistered agent is an error", await rejectsWith(harness.createSession({ config: { agent: "nobody" } }), HarnessConfigError));
  check("names: an agent beside options that only shape the default one is refused", await rejectsWith(harness.createSession({ config: { agent: "reviewer", tools: ["Read"] } }), HarnessConfigError));

  const fork = await harness.forkSession(picked.id);
  check("fork: parameters that identify one session are not copied", fork.config.extensions?.["seat"] === undefined);
  check("fork: ordinary parameters are", JSON.stringify(fork.config.extensions?.["label"]) === JSON.stringify({ text: "blue" }));
  await picked.close();
  const restored = await harness.resumeSession(picked.id);
  check("restore: the session's own parameters come back with it", JSON.stringify(restored.config.extensions?.["seat"]) === JSON.stringify({ number: 7 }));

  const secret = { mcp: { servers: { vault: { transport: "http", url: "http://vault.example", headers: { Authorization: "Bearer s3cret" } } } } } satisfies SessionConfig as SessionConfig;
  const strictHarness = createHarness({
    ...faux.harnessModel(),
    sessionCapabilities: () => [],
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const stored = await strictHarness.createSession({ config: secret }).then(() => undefined, (error: unknown) => error);
  check("secrets: a session's setup is not stored with a secret written into it", stored instanceof HarnessConfigError && stored.message.includes("mcp.servers.vault.headers"));
  const trusting = createHarness({
    ...faux.harnessModel(),
    sessionCapabilities: () => [],
    config: { ...{ defaults: {}, policy: { allowInlineMcpSecrets: true } }, defaults: { ...({ defaults: {}, policy: { allowInlineMcpSecrets: true } }).defaults, ...faux.harnessModel().config.defaults } }
  });
  check("secrets: unless the host says its session store is as trusted as its config file", (await trusting.createSession({ config: secret })).config.mcp !== undefined);

  // A configuration the host resolves is final, and is the host's to keep: nothing is stored.
  let turns = 5;
  const managed = createHarness({
    ...faux.harnessModel(),
    resolveSession: () => ({ config: { limits: { maxTurns: turns } } }),
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const first = await managed.createSession({ config: { limits: { maxTurns: 99 } } });
  check("resolver config: what the host returns is what the session runs on", first.config.limits?.maxTurns === 5);
  await first.close();
  turns = 6;
  check("resolver config: the next open asks again — the harness kept no copy", (await managed.resumeSession(first.id)).config.limits?.maxTurns === 6);

  await Promise.all([harness.close(), strictHarness.close(), trusting.close(), managed.close()]);
  void params;
  faux.unregister();
}

async function lifecycleRegressions(): Promise<void> {
  const faux = registerFauxProvider();
  let entered!: () => void;
  let unblock!: () => void;
  const enteredResolver = new Promise<void>((resolve) => { entered = resolve; });
  const resolverGate = new Promise<void>((resolve) => { unblock = resolve; });
  let pause = false;
  const harness = createHarness({
    ...faux.harnessModel(),
    resolveSession: async () => {
    if (pause) { entered(); await resolverGate; }
  },
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const session = await harness.createSession({ config: { thinking: "low", permission: { mode: "manual" } } });
  session.setThinking("high");
  await session.setPermissionMode("workspace");
  await session.close();
  const restored = await harness.resumeSession(session.id);
  check("runtime thinking survives restore", restored.thinkingSetting === "high");
  check("runtime permission survives restore", restored.permissionMode === "workspace");
  await restored.close();
  pause = true;
  const first = harness.resumeSession(session.id);
  await enteredResolver;
  const second = harness.resumeSession(session.id).then((value) => value, (error: unknown) => error);
  unblock();
  check("external resume joins while the resolver awaits", await first === await second);
  await harness.close();
  faux.unregister();
}

async function inheritedBindingsAndStoredKeys(): Promise<void> {
  const faux = registerFauxProvider();
  const repository = new MemorySessionRepository();
  let actions!: ExtensionActions;
  const h = createHarness({ ...faux.harnessModel(), infrastructure: () => ({ sessionRepository: repository }),
    extensions: [{ id: "credential-owner", session(api) { actions = api.actions; } }] });
  const parent = await h.createSession({ config: { thinking: "low", permission: { mode: "manual" } }, bindings: { mcpCredentials: { credentialsFor: () => undefined } } });
  const error = await actions.createSession().catch((cause: unknown) => cause);
  check("extension create inherits credential requirements too", error instanceof SessionDependencyMissingError && error.missing.includes("mcpCredentials"));
  const handle = await repository.open(parent.id);
  const setup = await handle!.store.getState("session:config") as { config: SessionConfig };
  check("runtime fields have only one durable source", setup.config.model === undefined && setup.config.thinking === undefined && setup.config.permission?.mode === undefined);
  parent.setThinking("high");
  await parent.close();
  check("thinking is stored under its own core key", await handle!.store.getState("session:thinking") === "high");
  await h.close();
  faux.unregister();
}

// ── What used to be accepted and no longer is must say so; what was stored before still opens ──

async function removedOptionsAndOlderSessions(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.harnessModel();

  // A flat option from before `config` would otherwise be dropped in silence — and with it a
  // permission mode or an isolation flag the host believes is in force.
  const flat = (options: Record<string, unknown>): unknown => {
    try {
      createHarness({ ...model, ...options } as Parameters<typeof createHarness>[0]);
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const moved = flat({ permission: { mode: "manual" }, strictIsolation: true });
  check("removed options: a flat harness option is an error, not a no-op", moved instanceof HarnessConfigError);
  check("removed options: the error says where each one lives now", moved instanceof HarnessConfigError && moved.message.includes("config.defaults.permission") && moved.message.includes("config.policy.strictIsolation"));
  check("removed options: so is a key the harness never knew", flat({ homeDir: "/tmp/x" }) instanceof HarnessConfigError);
  check("removed options: one left undefined is not an option", flat({ permission: undefined }) === undefined);

  // A session stored before `session:config` existed kept its extension parameters under their
  // old key. It opens as it always did, with those parameters as its configuration.
  const repository = new MemorySessionRepository();
  const seen: unknown[] = [];
  const harness = createHarness({
    ...model,
    infrastructure: () => ({ sessionRepository: repository }),
    extensions: [{ id: "label", session(_api, ctx) { seen.push(ctx.params); } }],
  });
  const older = await harness.createSession();
  await older.close();
  const handle = await repository.open(older.id);
  check("older session: one created with no configuration stores no setup", await handle!.store.getState("session:config") === null);
  await handle!.store.putState("extensions:params", { label: { text: "green" } });
  const reopened = await harness.resumeSession(older.id);
  check("older session: its extension parameters are read from where they were stored", JSON.stringify(reopened.config.extensions?.["label"]) === JSON.stringify({ text: "green" }) && JSON.stringify(seen.at(-1)) === JSON.stringify({ text: "green" }));
  check("older session: it has no record of what it ran on, so nothing is demanded of it", reopened.requires.length === 0);
  await harness.close();

  // The local preset builds each session's capabilities from that session's context: an isolating
  // policy reaches the MCP capability instead of stopping at the harness.
  const home = mkdtempSync(join(tmpdir(), "session-config-local-"));
  try {
    const local = await createLocalHarness({
      modelManager: model.modelManager,
      homeDir: home,
      loadDiskProfiles: false,
      loadConfiguredProviders: false,
      config: { workDir: home, policy: { strictIsolation: true }, defaults: { ...model.config.defaults } },
    });
    const sandbox = new LocalEnvironment(home);
    const shared = await local.createSession({
      bindings: { environment: sandbox },
      config: { mcp: { servers: { api: { transport: "http", url: "http://127.0.0.1:1/mcp", bearerTokenEnvVar: "SHARED_TOKEN" } } } },
    }).then(() => undefined, (error: unknown) => error);
    check("local preset: isolation reaches the session's capabilities", shared instanceof HarnessConfigError && shared.message.includes("bearerTokenEnvVar"));
    check("local preset: the refused session left no record", (await local.listSessions()).length === 0);
    await local.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  faux.unregister();
}

await removedOptionsAndOlderSessions();
await inheritedBindingsAndStoredKeys();
await lifecycleRegressions();
await differentMcpPerSession();
await failedOpenLeavesNothing();
await wiredBeforeTheFirstRun();
await permissionIsNotWidened();
await liveObjectsAreProvidedAgain();
await oneConfigurationDefinition();
await namesAndForkedParameters();

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exit(1);
