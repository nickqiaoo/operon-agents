import {
  ListenerSink,
  MemoryAppender,
  FRAMEWORK_TELEMETRY_EVENTS,
  FORBIDDEN_TELEMETRY_KEYS,
  RESERVED_TELEMETRY_KEYS,
  createTelemetryService,
  defineEvent,
  noopTelemetryService,
  redactTelemetryString,
  subscribeTelemetryProjection,
  type AgentEventBody,
  type AgentEventInput,
  type TelemetryAppender,
  type TelemetryEvent,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

// ── 1. Registry rules ─────────────────────────────────────────────────────────────────────────────

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const UNIT_WORDS = ["ms", "tokens", "count", "bytes"];

{
  let ok = true;
  const problems: string[] = [];
  for (const [name, def] of Object.entries(FRAMEWORK_TELEMETRY_EVENTS)) {
    if (!SNAKE.test(name)) problems.push(`event ${name} is not snake_case`);
    if (def.owner.length === 0) problems.push(`event ${name} has no owner`);
    if (def.comment.trim().length === 0) problems.push(`event ${name} has no comment`);
    if (def.scope !== "session") problems.push(`event ${name} should be session-scoped`);
    for (const [prop, description] of Object.entries(def.properties)) {
      if (!SNAKE.test(prop)) problems.push(`${name}.${prop} is not snake_case`);
      if (typeof description !== "string" || description.trim().length === 0) problems.push(`${name}.${prop} has no description`);
      if (RESERVED_TELEMETRY_KEYS.includes(prop)) problems.push(`${name}.${prop} is a reserved context key`);
      if (FORBIDDEN_TELEMETRY_KEYS.includes(prop)) problems.push(`${name}.${prop} is a forbidden content key`);
      for (const unit of UNIT_WORDS) {
        const segments = prop.split("_");
        if (segments.includes(unit) && segments[segments.length - 1] !== unit) problems.push(`${name}.${prop}: unit ${unit} must be a suffix`);
      }
    }
  }
  ok = problems.length === 0;
  if (!ok) console.log(problems.join("\n"));
  check("registry: naming, units, owner/comment, reserved & forbidden keys", ok);
}

// ── 2. Service semantics ──────────────────────────────────────────────────────────────────────────

{
  let clock = 100;
  const service = createTelemetryService({ now: () => clock++, onError: () => {} });
  const memory = new MemoryAppender();
  const view = service.withContext({ session_id: "s1" });
  const deeper = view.withContext({ address: "root/child", agent: "coder" });

  deeper.track("compaction", { before_tokens: 10, after_tokens: 5, compacted_count: 3 });
  check("service: no appender = no-op, no throw", memory.events.length === 0);

  service.addAppender(memory);
  deeper.track("compaction", { before_tokens: 10, after_tokens: 5, compacted_count: 3 });
  const e = memory.events[0];
  check("service: late addAppender applies to existing views", memory.events.length === 1);
  check(
    "service: context merged (session_id, address, agent) + payload + timestamp",
    e !== undefined &&
      e.name === "compaction" &&
      e.properties.session_id === "s1" &&
      e.properties.address === "root/child" &&
      e.properties.agent === "coder" &&
      e.properties.before_tokens === 10 &&
      e.timestamp === 100,
  );

  const throwing: TelemetryAppender = {
    track: () => {
      throw new Error("boom");
    },
    flush: () => Promise.reject(new Error("boom")),
    shutdown: () => Promise.resolve(),
  };
  const detachThrowing = service.addAppender(throwing);
  const after = new MemoryAppender();
  service.addAppender(after);
  view.track("session_started", { resumed: false });
  check("service: a throwing appender is isolated; later appenders still receive", after.events.length === 1 && memory.events.length === 2);
  detachThrowing();

  service.setEnabled(false);
  view.track("session_started", { resumed: true });
  check("service: setEnabled(false) drops at the root for every view", memory.events.length === 2 && after.events.length === 1 && !view.enabled);
  service.setEnabled(true);

  view.track("turn_error", { turn_id: null, message: "x" });
  const last = memory.events[memory.events.length - 1];
  check("service: null is kept on the wire (turn_id: null)", last !== undefined && last.properties.turn_id === null);

  // A product registry sharing the root.
  const PRODUCT = { app_opened: defineEvent<{ platform: string; cold_start: boolean }>({ owner: "product", comment: "x", properties: { platform: "p", cold_start: "c" } }) };
  const product = service.withRegistry(PRODUCT);
  product.track("app_opened", { platform: "darwin", cold_start: true });
  check("service: withRegistry tracks product events through the same root", memory.events[memory.events.length - 1]?.name === "app_opened");

  // Compile-time contract. `pnpm typecheck` excludes src/test; verify with
  // `tsc --noEmit -p <tsconfig including this file>` — every line below must be a real error.
  // @ts-expect-error extra property must not compile
  view.track("session_started", { resumed: true, user_email: "a@b.c" });
  // @ts-expect-error missing property must not compile
  view.track("compaction", { before_tokens: 1 });
  // @ts-expect-error unknown event must not compile
  view.track("nope", {});

  let threw = false;
  try {
    noopTelemetryService.addAppender(memory);
  } catch {
    threw = true;
  }
  check("service: noopTelemetryService refuses addAppender", threw);
  noopTelemetryService.withContext({ a: 1 }).track("session_started", { resumed: false });
  check("service: noopTelemetryService track is a no-op", true);

  await service.flush();
  await service.shutdown();
  check("service: shutdown drains every appender once", memory.shutdownCount === 1 && after.shutdownCount === 1);
}

// ── 3. Redaction ──────────────────────────────────────────────────────────────────────────────────

{
  const r = redactTelemetryString;
  check("redact: email", r("mail nick@example.com now") === "mail <redacted:email> now");
  check("redact: url", r("see https://example.com/a?b=c ok") === "see <redacted:url> ok");
  check("redact: absolute path", r("open /Users/me/proj/src/a.ts") === "open <redacted:path>");
  check("redact: node_modules tail survives", r("in /Users/me/proj/node_modules/zod/index.js") === "in node_modules/zod/index.js");
  check("redact: home-relative path", r("~/secret/dir/file") === "<redacted:path>");
  check("redact: secret shapes from logging/redact still apply", !r("key sk-ant-SECRETSECRETSECRET1234567890").includes("SECRET"));
  check("redact: plain enum-ish strings untouched", r("user_follow_up") === "user_follow_up" && r("bash") === "bash");
}

// ── 4. Projection: synthetic AgentEvent stream ────────────────────────────────────────────────────

function assistant(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): unknown {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model,
    responseId: "resp_1",
    usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  };
}

{
  let clock = 0;
  const service = createTelemetryService({ now: () => clock });
  const memory = new MemoryAppender();
  service.addAppender(memory);
  const sink = new ListenerSink();
  const off = subscribeTelemetryProjection(sink, service.withContext({ session_id: "s1" }), { now: () => clock, resumed: true });

  const S = "s1";
  const emit = async (body: AgentEventBody & { address?: string }): Promise<void> => {
    const input: AgentEventInput = { sessionId: S, address: "", ...body };
    await sink.emit(input);
  };

  await emit({ type: "agent.started", agent: "main" });
  clock = 10;
  await emit({ type: "turn.started", turnId: "t1", origin: { kind: "user", messageId: "m1" } as never });
  await emit({ type: "turn.step.started", turnId: "t1", step: 0, stepId: "st0" });
  await emit({ type: "message.appended", message: assistant("claude-a", 100, 20, 50, 5) as never });
  clock = 12;
  await emit({ type: "tool.call.started", toolCallId: "c1", toolName: "bash", args: { cmd: "rm -rf /" } });
  clock = 20;
  await emit({ type: "tool.result", toolCallId: "c1", toolName: "bash", result: { content: [] } as never, isError: false });
  await emit({ type: "turn.step.started", turnId: "t1", step: 1, stepId: "st1" });
  await emit({ type: "message.appended", message: assistant("claude-b", 200, 30) as never });
  // Sub-agent under root.
  await emit({ type: "agent.started", agent: "explore", address: "sub1" });
  await emit({ type: "turn.started", turnId: "t1", address: "sub1" });
  await emit({ type: "tool.call.started", toolCallId: "c2", toolName: "grep", args: {}, address: "sub1" });
  clock = 25;
  await emit({ type: "tool.result", toolCallId: "c2", toolName: "grep", result: { content: [] } as never, isError: true, address: "sub1" });
  await emit({ type: "error", message: "boom at /Users/me/x/y.ts for nick@example.com", address: "sub1" });
  // Sub-agent ends WITHOUT turn.ended: its dangling turn closes as cancelled.
  await emit({ type: "agent.ended", agent: "explore", address: "sub1" });
  await emit({ type: "compaction.completed", tokensBefore: 1000, tokensAfter: 300, compactedCount: 12 });
  await emit({ type: "turn.step.retrying", turnId: "t1", step: 2, attempt: 2, maxAttempts: 3, delayMs: 500, reason: "rate_limited" });
  await emit({ type: "assistant.delta", turnId: "t1", delta: "hi" } as never);
  clock = 40;
  await emit({ type: "turn.ended", turnId: "t1", reason: "completed" });
  await emit({ type: "turn.ended", turnId: "t1", reason: "completed" }); // duplicate: ignored

  const byName = (name: string): TelemetryEvent[] => memory.events.filter((e) => e.name === name);
  const names = memory.events.map((e) => e.name);

  check("projection: session_started once, with resumed", byName("session_started").length === 1 && byName("session_started")[0]?.properties.resumed === true);
  check("projection: turn_started carries origin kind", byName("turn_started")[0]?.properties.origin === "user");
  const tool = byName("tool_call");
  check(
    "projection: tool_call has duration, outcome, turn_id, tool_name (never args)",
    tool.length === 2 &&
      tool[0]?.properties.duration_ms === 8 &&
      tool[0]?.properties.outcome === "success" &&
      tool[0]?.properties.turn_id === "t1" &&
      tool[0]?.properties.tool_name === "bash" &&
      !("args" in (tool[0]?.properties ?? {})) &&
      tool[1]?.properties.outcome === "error" &&
      tool[1]?.properties.address === "sub1" &&
      tool[1]?.properties.agent === "explore",
  );
  const sub = byName("subagent_spawned")[0];
  check("projection: subagent_spawned with depth 1", sub?.properties.agent_name === "explore" && sub?.properties.depth === 1);
  const err = byName("turn_error")[0];
  check(
    "projection: turn_error message redacted (path + email)",
    err?.properties.turn_id === "t1" && err?.properties.message === "boom at <redacted:path> for <redacted:email>",
  );
  const finished = byName("turn_finished");
  const root = finished.find((e) => e.properties.address === "");
  const subFinished = finished.find((e) => e.properties.address === "sub1");
  check(
    "projection: root turn_finished sums usage, counts steps/tools, keeps last model, duration",
    root?.properties.reason === "completed" &&
      root?.properties.duration_ms === 30 &&
      root?.properties.step_count === 2 &&
      root?.properties.tool_call_count === 1 &&
      root?.properties.input_tokens === 300 &&
      root?.properties.output_tokens === 50 &&
      root?.properties.cache_read_tokens === 50 &&
      root?.properties.cache_write_tokens === 5 &&
      root?.properties.model === "claude-b",
  );
  check("projection: dangling sub-agent turn closed as cancelled on agent.ended", subFinished?.properties.reason === "cancelled" && subFinished?.properties.model === null);
  check("projection: duplicate turn.ended ignored", finished.length === 2);
  check("projection: compaction + step_retry projected", byName("compaction")[0]?.properties.after_tokens === 300 && byName("step_retry")[0]?.properties.attempt === 2);
  check("projection: deltas are not projected", !names.some((n) => n.includes("delta")));

  // Every numeric property on the wire carries a unit suffix (or is an explicitly unit-less count).
  const UNITLESS = new Set(["attempt", "max_attempts", "depth"]);
  const badNumeric = memory.events.flatMap((e) =>
    Object.entries(e.properties)
      .filter(([k, v]) => typeof v === "number" && !UNITLESS.has(k) && !/_(ms|count|tokens|bytes)$/.test(k))
      .map(([k]) => `${e.name}.${k}`),
  );
  if (badNumeric.length > 0) console.log(badNumeric.join(", "));
  check("projection: every numeric property has a unit suffix", badNumeric.length === 0);

  off();
  await emit({ type: "turn.started", turnId: "t2" });
  check("projection: unsubscribe stops projection", byName("turn_started").length === 2);
}

// ── Summary ───────────────────────────────────────────────────────────────────────────────────────

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
