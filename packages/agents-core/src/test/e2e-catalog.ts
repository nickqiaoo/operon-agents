/**
 * Dynamic tool catalog — mid-conversation MCP connect/disconnect/reconnect keeps the cached
 * request prefix stable; catalog changes are announced at the tail; loaded definitions stay
 * reconstructible across disconnects, compaction and durable replay.
 *
 * Session-level turns run against the faux provider; every request the model saw is then
 * serialized with pi's real Anthropic wire (aborted from `onPayload`) so the prefix
 * comparison is on the bytes the API would cache, not on an internal projection.
 */
import { z } from "zod";
import {
  fauxAssistantMessage,
  fauxToolCall,
  openTestSession,
  registerFauxProvider,
  testRunner,
  type Context,
} from "./faux.ts";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  compactionCapability,
  ConversationContext,
  defineAgent,
  MemoryStore,
  MicroCompaction,
  replayContext,
  summaryMessage,
  type Message,
  type ToolResultMessage,
} from "../index.ts";
import { ToolAccesses } from "../tool/access.ts";
import { tool } from "../tool/define.ts";
import type { Tool } from "../tool/types.ts";
import { SEARCH_TOOL_NAME } from "../tool/search/deferral.ts";
import { describeUnknownTool, loadedToolSchemas, prepareToolCatalog } from "../tool/search/catalog.ts";
import { DEFERRED_TOOL_PLACEHOLDER, withAnthropicDeferredMode } from "../llm/deferred-tools.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────

const SLACK_SEND = "mcp__slack__send_message";
const SLACK_LIST = "mcp__slack__list_channels";
const GITHUB_ISSUE = "mcp__github__create_issue";

function mcpTool(name: string, description: string, reply: string): Tool {
  return tool({
    name,
    description,
    parameters: z.object({ text: z.string().optional() }),
    accesses: ToolAccesses.none(),
    execute: ({ text }) => `${reply}:${text ?? ""}`,
  });
}

const slackSend = mcpTool(SLACK_SEND, "Send a message to a Slack channel.", "sent");
const slackSendV2 = mcpTool(SLACK_SEND, "Send a message to a Slack channel (v2: supports threads).", "sent-v2");
const slackList = mcpTool(SLACK_LIST, "List Slack channels.", "channels");
const github = mcpTool(GITHUB_ISSUE, "Create a GitHub issue.", "issue");

interface Snapshot {
  readonly label: string;
  readonly context: Context;
}

function text(message: Message): string {
  return message.content.map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : "")).join("");
}

function lastReminder(messages: readonly Message[]): string | undefined {
  const found = [...messages].reverse().find((m) => m.role === "user" && text(m).includes("<system-reminder>"));
  return found ? text(found) : undefined;
}

function toolNames(context: Context): string[] {
  return (context.tools ?? []).map((t) => t.name);
}

function wireModel(): Model<Api> {
  return {
    id: "claude-sonnet-4-5",
    name: "claude-sonnet-4-5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat: { supportsToolReferences: true },
  } as Model<Api>;
}

interface WirePayload {
  readonly system: unknown;
  readonly tools: Array<Record<string, unknown>>;
  readonly messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
}

/** Serialize a request exactly as our ChatModel would (placeholder included). */
async function capturePayload(context: Context): Promise<WirePayload> {
  const controller = new AbortController();
  let payload: unknown;
  const options: SimpleStreamOptions = withAnthropicDeferredMode({
    apiKey: "test",
    signal: controller.signal,
    maxRetries: 0,
    onPayload: (next) => {
      payload = next;
      controller.abort();
      return next;
    },
  }) as SimpleStreamOptions;
  const stream = streamAnthropic(wireModel(), context, options);
  for await (const _event of stream) {
    // drain the abort
  }
  if (typeof payload !== "object" || payload === null) throw new Error("pi did not expose a payload");
  return payload as WirePayload;
}

/** The bytes the API caches ahead of the conversation: system + non-deferred tools. */
function prefixOf(payload: WirePayload): string {
  return JSON.stringify({ system: payload.system, tools: payload.tools.filter((t) => t.defer_loading !== true) });
}

// ── session-level flow ─────────────────────────────────────────────────────────────────────

async function testSessionFlow(): Promise<void> {
  const faux = registerFauxProvider({
    api: "anthropic-messages",
    provider: "anthropic",
    models: [{ id: "claude-sonnet-4-5" }],
  });
  const snapshots: Snapshot[] = [];
  const snap = (label: string) => (context: Context): void => {
    snapshots.push({ label, context: structuredClone({ systemPrompt: context.systemPrompt, tools: context.tools, messages: context.messages }) });
  };

  let current: Tool[] = [];
  const dyn = { name: "dyn-mcp", toolProviders: [{ id: "mcp:fake", listTools: () => [...current] }] };
  const store = new MemoryStore();
  const session = await openTestSession({
    store,
    capabilities: [dyn, compactionCapability({ maxContextTokens: 1_000_000 })],
    permission: { mode: "yolo" },
  });
  const runner = testRunner({});
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "catalog", model, instructions: "x" });
  const run = (prompt: string) => runner.run(agent, prompt, { session });

  try {
    // Turn 1 — nothing connected yet. SearchTool is already in the prefix.
    faux.setResponses([
      (context) => {
        snap("t1")(context);
        check("t1: SearchTool present before any MCP connects", toolNames(context).includes(SEARCH_TOOL_NAME));
        check("t1: no announcement without catalog changes", lastReminder(context.messages) === undefined);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);
    await run("hello");

    // Turn 2 — slack connects mid-session: announced at the tail, loaded on demand, executed.
    current = [slackSend, slackList];
    faux.setResponses([
      (context) => {
        snap("t2s1")(context);
        const reminder = lastReminder(context.messages) ?? "";
        check("t2: connect announces both slack tools as fresh", reminder.includes(`now available via ${SEARCH_TOOL_NAME}`) && reminder.includes(SLACK_SEND) && reminder.includes(SLACK_LIST));
        check("t2: announcement is the last message", context.messages.at(-1)?.role === "user" && text(context.messages.at(-1)!).includes("<system-reminder>"));
        check("t2: fresh tools are not in the request until loaded", !toolNames(context).includes(SLACK_SEND));
        return fauxAssistantMessage(fauxToolCall(SEARCH_TOOL_NAME, { query: `select:${SLACK_SEND}` }), { stopReason: "toolUse" });
      },
      (context) => {
        snap("t2s2")(context);
        check("t2: loaded tool joins the request, unloaded sibling does not", toolNames(context).includes(SLACK_SEND) && !toolNames(context).includes(SLACK_LIST));
        return fauxAssistantMessage(fauxToolCall(SLACK_SEND, { text: "hello" }), { stopReason: "toolUse" });
      },
      (context) => {
        snap("t2s3")(context);
        return fauxAssistantMessage("done", { stopReason: "stop" });
      },
    ]);
    const t2 = await run("send hello on slack");
    check("t2: loaded MCP tool executed", t2.messages.some((m) => m.role === "toolResult" && m.toolName === SLACK_SEND && text(m) === "sent:hello"));

    // Turn 3 — a second server connects: only the new name is announced.
    current = [slackSend, slackList, github];
    faux.setResponses([
      (context) => {
        snap("t3")(context);
        const reminder = lastReminder(context.messages) ?? "";
        check("t3: second connect announces only the new tool", reminder.includes(GITHUB_ISSUE) && !reminder.includes(SLACK_LIST));
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);
    await run("noted");

    // Turn 4 — slack disconnects. The loaded definition stays on the wire (history replay)
    // but is retracted for the model and can no longer execute.
    current = [github];
    faux.setResponses([
      (context) => {
        snap("t4s1")(context);
        const reminder = lastReminder(context.messages) ?? "";
        check("t4: retracted loaded definition told to disregard", reminder.includes("Disregard those definitions") && reminder.includes(SLACK_SEND));
        check("t4: unloaded sibling told not to search", reminder.includes("Do not search for them") && reminder.includes(SLACK_LIST));
        check("t4: retired definition still declared for the load point", toolNames(context).includes(SLACK_SEND));
        return fauxAssistantMessage(fauxToolCall(SLACK_SEND, { text: "late" }), { stopReason: "toolUse" });
      },
      (context) => {
        snap("t4s2")(context);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);
    const t4 = await run("try slack anyway");
    const retiredCall = t4.messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === SLACK_SEND && text(m) !== "sent:hello");
    check("t4: calling a retired tool errors instead of executing", retiredCall?.isError === true && text(retiredCall).includes("no longer available"));

    // Turn 5 — slack reconnects with the same definition: callable directly again.
    current = [slackSend, github];
    faux.setResponses([
      (context) => {
        snap("t5s1")(context);
        const reminder = lastReminder(context.messages) ?? "";
        check("t5: reconnect with same schema is announced as callable again", reminder.includes("can be called directly") && reminder.includes(SLACK_SEND));
        return fauxAssistantMessage(fauxToolCall(SLACK_SEND, { text: "again" }), { stopReason: "toolUse" });
      },
      (context) => {
        snap("t5s2")(context);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);
    const t5 = await run("slack is back");
    check("t5: reconnected tool executes without a new search", t5.messages.some((m) => m.role === "toolResult" && m.toolName === SLACK_SEND && text(m) === "sent:again"));

    // Turn 6 — slack reconnects with a changed definition: versioned wire name, old one retired.
    current = [slackSendV2, github];
    let versioned = "";
    faux.setResponses([
      (context) => {
        snap("t6")(context);
        const reminder = lastReminder(context.messages) ?? "";
        versioned = reminder.match(/mcp__slack__send_message__v_[0-9a-f]{12}/)?.[0] ?? "";
        check("t6: changed schema arrives under a versioned name", versioned !== "" && reminder.includes(`now available via ${SEARCH_TOOL_NAME}`));
        check("t6: the recorded definition is retired, not rewritten", reminder.includes("Disregard those definitions") && toolNames(context).includes(SLACK_SEND));
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);
    await run("slack upgraded");

    // Turn 7 — manual compaction, then the model calls a never-loaded tool from memory.
    await session.compact();
    faux.setResponses([
      (context) => {
        check("t7: compaction summary request carries no tools", context.tools === undefined);
        return fauxAssistantMessage("## Summary\nSlack and GitHub tools were used.", { stopReason: "stop" });
      },
      (context) => {
        snap("t7s1")(context);
        const summaryIndex = context.messages.findIndex((m) => m.role === "user" && text(m).includes("<context-summary>"));
        const reminder = lastReminder(context.messages) ?? "";
        const plain = new RegExp(`(^|\\n)${SLACK_SEND}(\\n|$)`);
        check("t7: catalog re-announced after compaction (never-loaded tool listed fresh)", summaryIndex >= 0 && context.messages.indexOf(context.messages.findLast((m) => m.role === "user" && text(m).includes("<system-reminder>"))!) > summaryIndex && reminder.includes(`now available via ${SEARCH_TOOL_NAME}`) && reminder.includes(GITHUB_ISSUE));
        check("t7: never-loaded tool is absent from the request", !toolNames(context).includes(GITHUB_ISSUE));
        // The recorded v1 definition was compacted away, so the source name is free again: the
        // surviving v2 announcement is retracted and the plain name comes back as re-added.
        check("t7: source name reclaimed once the recorded definition is compacted away", reminder.includes("available again") && plain.test(reminder) && reminder.includes("Do not search for them") && reminder.includes(versioned));
        return fauxAssistantMessage(fauxToolCall(GITHUB_ISSUE, { text: "bug" }), { stopReason: "toolUse" });
      },
      (context) => {
        snap("t7s2")(context);
        const guidance = [...context.messages].reverse().find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === GITHUB_ISSUE);
        check("t7: unloaded call is refused with load guidance", guidance?.isError === true && text(guidance).includes(`select:${GITHUB_ISSUE}`) && text(guidance).includes("input schema"));
        return fauxAssistantMessage(fauxToolCall(SEARCH_TOOL_NAME, { query: `select:${GITHUB_ISSUE}` }), { stopReason: "toolUse" });
      },
      (context) => {
        snap("t7s3")(context);
        check("t7: search after compaction loads the schema", toolNames(context).includes(GITHUB_ISSUE));
        return fauxAssistantMessage(fauxToolCall(GITHUB_ISSUE, { text: "bug" }), { stopReason: "toolUse" });
      },
      (context) => {
        snap("t7s4")(context);
        return fauxAssistantMessage("filed", { stopReason: "stop" });
      },
    ]);
    const t7 = await run("file the issue");
    check("t7: reloaded tool executes", t7.messages.some((m) => m.role === "toolResult" && m.toolName === GITHUB_ISSUE && text(m) === "issue:bug"));

    // Durable replay: origins and load evidence come back; nothing is re-announced.
    const replayed = await replayContext(store, "main");
    const loaded = loadedToolSchemas(replayed);
    check("replay: loaded schema recovered from the journal", loaded.get(GITHUB_ISSUE)?.schema.description === "Create a GitHub issue.");
    const before = replayed.messages.length;
    const prepared = prepareToolCatalog(replayed, { tools: current, deferredToolNames: new Set(current.map((t) => t.schema.name)), deferEnabled: true });
    check("replay: announcement state is consistent, nothing appended", replayed.messages.length === before && prepared.warnings.length === 0);
    check("replay: catalog names match the announced state", prepared.catalog.has(SLACK_SEND) && !prepared.catalog.has(versioned));
  } finally {
    await session.close();
    faux.unregister();
  }

  // Wire: every request across all turns shares one cached prefix.
  const payloads = new Map<string, WirePayload>();
  for (const s of snapshots) payloads.set(s.label, await capturePayload(s.context));
  const base = prefixOf(payloads.get("t1")!);
  // Known cost, not a regression: once a tool was called before its load point (t7s2 guessed
  // the name, t7s3 loaded it), pi declares it as an ordinary prefix tool from then on. The
  // prefix changes once and stays stable afterwards.
  const knownCost = new Set(["t7s3", "t7s4"]);
  const drift = snapshots.filter((s) => !knownCost.has(s.label) && prefixOf(payloads.get(s.label)!) !== base).map((s) => s.label);
  check(`wire: cached prefix identical across ${snapshots.length - knownCost.size} requests (drift: ${drift.join(",") || "none"})`, drift.length === 0);
  check("wire: refused call to an unloaded tool does not touch the prefix", prefixOf(payloads.get("t7s2")!) === base);
  check("wire: (known cost) call-before-load promotes the tool once, then the prefix is stable again", prefixOf(payloads.get("t7s3")!) !== base && prefixOf(payloads.get("t7s3")!) === prefixOf(payloads.get("t7s4")!));
  check("wire: placeholder keeps deferred mode on from the first request", payloads.get("t1")!.tools.some((t) => t.name === DEFERRED_TOOL_PLACEHOLDER && t.defer_loading === true));
  check("wire: loaded tool is defer_loading, expanded by tool_reference", payloads.get("t2s2")!.tools.some((t) => t.name === SLACK_SEND && t.defer_loading === true) && JSON.stringify(payloads.get("t2s2")!.messages).includes(`"tool_name":"${SLACK_SEND}"`));
  check("wire: retired definition stays defer_loading after disconnect", payloads.get("t4s1")!.tools.some((t) => t.name === SLACK_SEND && t.defer_loading === true));
  const t2 = payloads.get("t2s1")!;
  const roles = t2.messages.map((m) => m.role);
  const last = t2.messages.at(-1)!;
  check("wire: tail announcement is a user turn carrying the cache breakpoint", roles.at(-1) === "user" && last.content.at(-1)?.cache_control !== undefined);
}

// ── compaction unit semantics ──────────────────────────────────────────────────────────────

function assistantCall(name: string, args: Record<string, unknown>, id: string): Message {
  return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }) as Message;
}

function snapshotFor(tools: readonly Tool[]) {
  return { tools, deferredToolNames: new Set(tools.map((t) => t.schema.name)), deferEnabled: true };
}

async function testCompactionSemantics(): Promise<void> {
  // (a) Load point compacted away, no surviving call: the tool leaves the request; the model
  // is re-told to search; a direct call gets load guidance.
  {
    const ctx = new ConversationContext();
    ctx.appendMessage(summaryMessage("used slack"), { kind: "compaction_summary" });
    const prepared = prepareToolCatalog(ctx, snapshotFor([slackSend]));
    check("compact/a: unloaded tool is not sent", !prepared.schemas.some((s) => s.name === SLACK_SEND) && !prepared.tools.some((t) => t.schema.name === SLACK_SEND));
    check("compact/a: full catalog re-announced after the summary", (lastReminder(ctx.messages) ?? "").includes(SLACK_SEND));
    check("compact/a: direct call gets load guidance", (describeUnknownTool(prepared, SLACK_SEND) ?? "").includes(`select:${SLACK_SEND}`));
    check("compact/a: unrelated names get no guidance", describeUnknownTool(prepared, "Nope") === undefined);
  }

  // (b) Load point compacted away but the call survived: `applyCompaction` carries the
  // definition on the summary's origin and the tool stays executable. Known cost: pi sees a
  // call without a load point and declares the tool as an ordinary (prefix) tool.
  {
    const ctx = new ConversationContext();
    ctx.appendMessage({ role: "user", content: [{ type: "text", text: "send hi" }], timestamp: 1 });
    ctx.appendMessage(assistantCall(SEARCH_TOOL_NAME, { query: `select:${SLACK_SEND}` }, "s1"));
    ctx.appendMessage({ role: "toolResult", toolCallId: "s1", toolName: SEARCH_TOOL_NAME, content: [{ type: "text", text: "Loaded tools" }], addedToolNames: [SLACK_SEND, SLACK_LIST], details: { deferredToolSchemas: [{ sourceName: SLACK_SEND, schema: slackSend.schema }, { sourceName: SLACK_LIST, schema: slackList.schema }] }, isError: false, timestamp: 2 });
    ctx.appendMessage(assistantCall(SLACK_SEND, { text: "hi" }, "call-1"));
    ctx.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: SLACK_SEND, content: [{ type: "text", text: "sent:hi" }], isError: false, timestamp: 3 });
    ctx.appendMessage({ role: "user", content: [{ type: "text", text: "again" }], timestamp: 4 });
    ctx.applyCompaction({ summary: "used slack", compactedCount: 3, tokensBefore: 10, tokensAfter: 5 });
    const boundary = ctx.originOf(ctx.messages[0]!);
    check("compact/b: summary origin carries only the definition the kept tail calls", boundary?.kind === "compaction_summary" && boundary.loadedTools?.map((t) => t.schema.name).join() === SLACK_SEND);
    const prepared = prepareToolCatalog(ctx, snapshotFor([slackSend]));
    check("compact/b: surviving call keeps the tool executable", prepared.tools.some((t) => t.schema.name === SLACK_SEND));
    check("compact/b: definition restored from the summary origin", prepared.loaded.get(SLACK_SEND)?.schema.description === slackSend.schema.description);
    check("compact/b: no assistant message carries a per-call snapshot", ctx.messages.every((m) => m.role !== "assistant" || ctx.originOf(m) === undefined));
    const payload = await capturePayload({ systemPrompt: "x", tools: prepared.schemas, messages: ctx.messages });
    const wire = payload.tools.find((t) => t.name === SLACK_SEND);
    check("compact/b: (known cost) pi declares a call-only tool in the prefix", wire !== undefined && wire.defer_loading !== true);

    // Same shape, but the server is gone: the definition is wire-only and cannot execute.
    const gone = prepareToolCatalog(ctx, snapshotFor([github]), { announce: false });
    check("compact/b: retired definition is declared but not executable", gone.schemas.some((s) => s.name === SLACK_SEND) && !gone.tools.some((t) => t.schema.name === SLACK_SEND));
    check("compact/b: retired call is explained", (describeUnknownTool(gone, SLACK_SEND) ?? "").includes("no longer available"));
  }

  // (c) Micro compaction clears old result text but keeps the load evidence and schema.
  {
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "s1",
      toolName: SEARCH_TOOL_NAME,
      content: [{ type: "text", text: "X".repeat(2_000) }],
      addedToolNames: [SLACK_SEND],
      details: { deferredToolSchemas: [{ sourceName: SLACK_SEND, schema: slackSend.schema }] },
      isError: false,
      timestamp: 1,
    };
    const messages: Message[] = [result];
    const micro = new MicroCompaction({ cacheMissedThresholdMs: 0, minContextUsageRatio: 0, keepRecentMessages: 0, minContentTokens: 1 });
    const cleared = micro.detectAndApply(messages, 0, 1);
    const ctx = new ConversationContext({ history: messages });
    check("compact/c: micro compaction keeps details and addedToolNames", cleared === 1 && loadedToolSchemas(ctx).get(SLACK_SEND)?.schema.description === slackSend.schema.description);
  }
}

// ── wire: announcement placement ───────────────────────────────────────────────────────────

async function testAnnouncementWire(): Promise<void> {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
    assistantCall(SEARCH_TOOL_NAME, { query: "slack" }, "s1"),
    { role: "toolResult", toolCallId: "s1", toolName: SEARCH_TOOL_NAME, content: [{ type: "text", text: "found" }], addedToolNames: [SLACK_SEND], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "<system-reminder>\ncatalog changed\n</system-reminder>" }], timestamp: 4 },
  ];
  const payload = await capturePayload({ systemPrompt: "x", tools: [{ name: SEARCH_TOOL_NAME, description: "s", parameters: { type: "object" } }, slackSend.schema], messages });
  const roles = payload.messages.map((m) => m.role);
  check("wire: reminder after a tool result serializes as a second user turn", roles.join(",") === "user,assistant,user,user");
  check("wire: tool_reference stays in the tool_result turn", payload.messages[2]!.content.some((b) => b.type === "tool_result") && JSON.stringify(payload.messages[2]).includes("tool_reference"));
  check("wire: cache breakpoint moves to the announcement", payload.messages[3]!.content.at(-1)?.cache_control !== undefined);
}


async function main(): Promise<void> {
  await testSessionFlow();
  await testCompactionSemantics();
  await testAnnouncementWire();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ CATALOG E2E PASS — dynamic MCP catalog keeps the cached prefix; tail announcements; compaction + replay");
  } else {
    console.log("❌ CATALOG E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ CATALOG E2E ERROR:", error);
  process.exit(1);
});
