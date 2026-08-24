/**
 * Coverage for `AgentConfig.modelSettings` reaching the wire, and for the precedence rule
 * between the agent profile and session-level runtime overrides.
 *
 * This exists because the link used to be broken: `modelSettings` was declared on the agent,
 * assigned in the constructor, and then never read — the runner forwarded only the session's
 * thinking level, so `temperature` set on an agent was silently dropped. A unit test on
 * `resolveModelParams` alone would not have caught that; the assertions below follow the
 * value all the way into the options the provider is called with.
 *
 * The faux provider passes its `options` straight through (its `streamSimple` delegates to
 * `stream` without pi's `buildBaseOptions` whitelist), so what these tests observe is exactly
 * what this layer assembled.
 */
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type Context,
  type FauxResponseStep,
} from "./faux.ts";
import {
  defineAgent,
  defineModel,
  LocalMachine,
  resolveModelParams,
  Runner,
  Session,
  type ModelSettings,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** Captured `options` of the last provider call. */
type CapturedOptions = Record<string, unknown> | undefined;

/**
 * Run one turn against a faux model and hand back the options the provider was called with.
 * `settings` goes on the agent; `thinking` (when given) is the session-tier override applied
 * through the same setter a user would call.
 */
async function captureOptions(
  machine: LocalMachine,
  settings: ModelSettings | undefined,
  sessionThinking?: "low" | "high",
): Promise<CapturedOptions> {
  const faux = registerFauxProvider();
  let captured: CapturedOptions;
  const respond: FauxResponseStep = (_context: Context, options) => {
    captured = options as CapturedOptions;
    return fauxAssistantMessage("ok", { stopReason: "stop" });
  };
  faux.setResponses([respond]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({
    name: "a",
    model,
    instructions: "x",
    ...(settings !== undefined ? { modelSettings: settings } : {}),
  });

  const runner = new Runner({ machine, permission: { mode: "yolo" } });
  const session = await Session.open({ machine });
  try {
    if (sessionThinking !== undefined) session.setThinking(sessionThinking);
    await runner.run(agent, "hello", { session });
  } finally {
    await session.close();
    faux.unregister();
  }
  return captured;
}

async function testAgentSettingsReachTheProvider(machine: LocalMachine): Promise<void> {
  const options = await captureOptions(machine, {
    temperature: 0.25,
    maxTokens: 4096,
    thinking: "low",
  });

  check("modelSettings.temperature reaches the provider", options?.temperature === 0.25);
  check("modelSettings.maxTokens reaches the provider", options?.maxTokens === 4096);
  // pi's simple surface names the thinking knob `reasoning`; `toOptions` does that mapping.
  check("modelSettings.thinking maps to the provider's `reasoning`", options?.reasoning === "low");
}

async function testThinkingBudgetsReachTheProvider(machine: LocalMachine): Promise<void> {
  const options = await captureOptions(machine, {
    thinking: "medium",
    thinkingBudgets: { medium: 4321 },
  });

  const budgets = options?.thinkingBudgets as { medium?: number } | undefined;
  check("modelSettings.thinkingBudgets reaches the provider", budgets?.medium === 4321);
}

async function testSessionThinkingOutranksTheProfile(machine: LocalMachine): Promise<void> {
  const options = await captureOptions(machine, { temperature: 0.7, thinking: "low" }, "high");

  check(
    "session setThinking() overrides the agent profile's thinking level",
    options?.reasoning === "high",
  );
  check(
    "the session override leaves the profile's other settings intact",
    options?.temperature === 0.7,
  );
}

async function testNoSettingsSendsNoParams(machine: LocalMachine): Promise<void> {
  const options = await captureOptions(machine, undefined);

  // Guards the no-regression case: an agent without modelSettings must produce a request
  // byte-identical to what it produced before this plumbing existed.
  check("an agent with no modelSettings sends no temperature", options?.temperature === undefined);
  check("an agent with no modelSettings sends no maxTokens", options?.maxTokens === undefined);
  check("an agent with no modelSettings sends no reasoning", options?.reasoning === undefined);
}

async function testSessionIdIsStampedPerConversationLine(machine: LocalMachine): Promise<void> {
  const options = await captureOptions(machine, undefined);

  const sessionId = options?.sessionId;
  check(
    "the loop stamps a provider sessionId scoped to the conversation line",
    typeof sessionId === "string" && sessionId.endsWith(":main") && sessionId.length > ":main".length,
  );
}

/**
 * `apiKey` is the one credential path that does not go through a CredentialStore: a key held
 * in code or config. It is a named field on ModelSpec rather than a generic options bag,
 * because it deliberately overrides resolved provider auth and that has to be visible.
 */
async function testApiKeyOnTheModelSpec(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  let captured: CapturedOptions;
  faux.setResponses([
    (_context: Context, options) => {
      captured = options as CapturedOptions;
      return fauxAssistantMessage("ok", { stopReason: "stop" });
    },
  ]);
  const descriptor = faux.getModel();
  const model = defineModel({ descriptor, runtime: faux.runtime, apiKey: "sk-from-code" });
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const runner = new Runner({ machine, permission: { mode: "yolo" } });
  await runner.run(agent, "hello");
  faux.unregister();

  check("ModelSpec.apiKey reaches the provider", captured?.apiKey === "sk-from-code");
}

async function testNoApiKeyLeavesResolutionToTheRuntime(machine: LocalMachine): Promise<void> {
  const options = await captureOptions(machine, undefined);

  // Absent (not empty-string) is what lets pi fall back to the credential store / env vars:
  // `models.js` resolves `options?.apiKey ?? auth.apiKey`.
  check(
    "omitting apiKey leaves provider auth resolution to the runtime",
    options !== undefined && !("apiKey" in options && options.apiKey !== undefined),
  );
}

/**
 * `connection` is the build-time transport tier: fixed when the model is made, applied to every
 * request. Asserted together with `params` to pin the thing that actually matters — the two
 * tiers reach the provider in one options object without clobbering each other.
 */
async function testConnectionSettings(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  let captured: CapturedOptions;
  faux.setResponses([
    (_context: Context, options) => {
      captured = options as CapturedOptions;
      return fauxAssistantMessage("ok", { stopReason: "stop" });
    },
  ]);
  const model = defineModel({
    descriptor: faux.getModel(),
    runtime: faux.runtime,
    connection: {
      headers: { "x-team": "operon", "x-drop-me": null },
      timeoutMs: 12_345,
      transport: "sse",
    },
  });
  const agent = defineAgent({
    name: "a",
    model,
    instructions: "x",
    modelSettings: { temperature: 0.5 },
  });

  const runner = new Runner({ machine, permission: { mode: "yolo" } });
  await runner.run(agent, "hello");
  faux.unregister();

  const headers = captured?.headers as Record<string, string | null> | undefined;
  check("connection.headers reaches the provider", headers?.["x-team"] === "operon");
  // null is how pi deletes a header it would otherwise send — it must survive as null, not
  // be dropped on the way through.
  check("connection.headers keeps null (header deletion) intact", headers?.["x-drop-me"] === null);
  check("connection.timeoutMs reaches the provider", captured?.timeoutMs === 12_345);
  check("connection.transport reaches the provider", captured?.transport === "sse");
  check("connection and params coexist on one request", captured?.temperature === 0.5);
}

async function testConnectionIsOverridablePerRequest(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  let captured: CapturedOptions;
  faux.setResponses([
    (_context: Context, options) => {
      captured = options as CapturedOptions;
      return fauxAssistantMessage("ok", { stopReason: "stop" });
    },
  ]);
  const model = defineModel({
    descriptor: faux.getModel(),
    runtime: faux.runtime,
    connection: { timeoutMs: 1_000 },
  });

  // providerOptions is the escape hatch and must outrank build-time defaults; an extension
  // rewriting the wire for one request cannot be vetoed by how the model was constructed.
  await model.complete({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    providerOptions: { timeoutMs: 9_000 },
  });
  faux.unregister();

  check("providerOptions overrides connection for a single request", captured?.timeoutMs === 9_000);
}

/** Precedence and the empty case, straight on the resolver — cheaper to assert exhaustively. */
function testResolveModelParams(): void {
  check(
    "resolveModelParams: nothing set → undefined (no params object on the request)",
    resolveModelParams(undefined, undefined) === undefined,
  );
  check(
    "resolveModelParams: session thinking alone still produces params",
    resolveModelParams(undefined, "high")?.thinking === "high",
  );
  check(
    "resolveModelParams: profile thinking applies when the session has no override",
    resolveModelParams({ thinking: "low" }, undefined)?.thinking === "low",
  );
  check(
    "resolveModelParams: session thinking wins over the profile's",
    resolveModelParams({ thinking: "low" }, "high")?.thinking === "high",
  );
  check(
    "resolveModelParams: a profile with only temperature does not invent a thinking level",
    resolveModelParams({ temperature: 0 }, undefined)?.thinking === undefined,
  );
  check(
    "resolveModelParams: temperature 0 survives (not treated as absent)",
    resolveModelParams({ temperature: 0 }, undefined)?.temperature === 0,
  );
}

async function main(): Promise<void> {
  const machine = new LocalMachine();

  testResolveModelParams();
  await testAgentSettingsReachTheProvider(machine);
  await testThinkingBudgetsReachTheProvider(machine);
  await testSessionThinkingOutranksTheProfile(machine);
  await testNoSettingsSendsNoParams(machine);
  await testSessionIdIsStampedPerConversationLine(machine);
  await testApiKeyOnTheModelSpec(machine);
  await testNoApiKeyLeavesResolutionToTheRuntime(machine);
  await testConnectionSettings(machine);
  await testConnectionIsOverridablePerRequest(machine);

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

void main();
