/**
 * History is broadcast from ONE place — the journal — so a live consumer and a replay of the
 * log can never show different transcripts.
 *
 * Before this, each mutation site had to remember to emit an event next to its mutation, and
 * three of them didn't: `injectAtTurnBoundary` appended silently (fixed once), `replaceHistory`
 * emitted nothing at all, and `applyCompaction`'s event carried counts but not enough to
 * reproduce the splice. The visible symptom was the worst kind: the transcript changed after a
 * reopen, with no signal that anything had happened.
 *
 * The assertion throughout is the same one: fold the EVENTS, fold the RECORDS, demand they
 * match. Anything that mutates history without broadcasting fails it.
 */
import { ConversationContext } from "../loop/context.ts";
import { historyChangeEmitter } from "../agent/run-support.ts";
import { ListenerSink } from "../events/events.ts";
import { SessionEventPublisher } from "../events/publisher.ts";
import { SessionProjection } from "../events/projection.ts";
import { reduceHistory, type AgentRecord } from "../store/store.ts";
import { MemoryStore } from "../store/log-store.ts";
import type { AgentEvent } from "../events/events.ts";
import type { Message } from "../protocol/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1_000 };
}

function textsOf(messages: readonly Message[]): string {
  return messages
    .map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
    .join("|");
}

async function replayedTexts(store: MemoryStore, address: string): Promise<string> {
  const records: AgentRecord[] = [];
  for await (const record of store.readRecords({ address })) records.push(record);
  return textsOf(reduceHistory(records).messages);
}

function liveTexts(projection: SessionProjection, address: string): string {
  const agent = projection.snapshot().agents.find((entry) => entry.address === address);
  return textsOf(agent?.messages ?? []);
}

/** Append, trim, compact — after each, live state must equal a replay of the log. */
async function liveMatchesReplayThroughEveryMutation(): Promise<void> {
  const events = new ListenerSink();
  const inner = new MemoryStore();
  const publisher = new SessionEventPublisher("s1", events, inner, "committed");
  const store = publisher.store!;
  const projection = await SessionProjection.attach({ id: "s1", store, events });
  const context = new ConversationContext({
    store,
    address: "main",
  });

  const a = user("a");
  const b = user("b");
  const c = user("c");
  context.appendMessage(a);
  context.appendMessage(b);
  context.appendMessage(c);
  await context.flush();
  check("append: live matches replay", liveTexts(projection, "main") === (await replayedTexts(store, "main")));
  check("append: and it is the full transcript", liveTexts(projection, "main") === "a|b|c");

  // Micro-compaction's trim commits through `replaceHistory` — the mutation that used to be
  // journaled but never broadcast. It runs at a step boundary, i.e. constantly.
  context.replaceHistory([a, c]);
  await context.flush();
  check("replace: live matches replay", liveTexts(projection, "main") === (await replayedTexts(store, "main")));
  check("replace: live actually dropped the trimmed message", liveTexts(projection, "main") === "a|c");

  context.applyCompaction({ summary: "earlier work", compactedCount: 2, tokensBefore: 100, tokensAfter: 10 });
  await context.flush();
  check("compact: live matches replay", liveTexts(projection, "main") === (await replayedTexts(store, "main")));
  check("compact: the summary replaced the prefix", liveTexts(projection, "main").includes("<context-summary>"));

  context.appendMessage(user("d"), { kind: "background_task", taskId: "t1" });
  await context.flush();
  check("append after compaction: still matches replay", liveTexts(projection, "main") === (await replayedTexts(store, "main")));

  // Provenance rides along, so a UI can tell "the user said this" from "a background task
  // settling said this" — the distinction that matters for turns nobody asked for.
  const snapshot = projection.snapshot().agents.find((entry) => entry.address === "main");
  check("origins: parallel to messages", snapshot?.origins.length === snapshot?.messages.length);
  check("origins: the compaction summary is marked as one", snapshot?.origins[0]?.kind === "compaction_summary");
  check("origins: the background settle kept its provenance", snapshot?.origins.at(-1)?.kind === "background_task");

  // A tail-limited snapshot must slice both arrays at the same point.
  const tail = projection.snapshot({ maxMessages: 1 }).agents.find((entry) => entry.address === "main");
  check("origins: a tail-limited snapshot stays aligned", tail?.messages.length === 1 && tail?.origins.length === 1);
  check("origins: and keeps the right one", tail?.origins[0]?.kind === "background_task");

  projection.detach();
}

/** A reader that seeds from the log and one that folded the events must agree. */
async function reattachAgreesWithTheLiveProjection(): Promise<void> {
  const events = new ListenerSink();
  const inner = new MemoryStore();
  const publisher = new SessionEventPublisher("s2", events, inner, "committed");
  const store = publisher.store!;
  const live = await SessionProjection.attach({ id: "s2", store, events });
  const context = new ConversationContext({
    store,
    address: "main",
  });

  context.appendMessage(user("one"));
  context.appendMessage(user("two"));
  context.appendMessage(user("three"));
  context.replaceHistory([user("one"), user("three")]);
  context.applyCompaction({ summary: "condensed", compactedCount: 1, tokensBefore: 50, tokensAfter: 5 });
  await context.flush();

  // A brand-new consumer opening the same session — the "reopen the page" case.
  const reopened = await SessionProjection.attach({ id: "s2", store, events: new ListenerSink() });
  check("reattach: a fresh reader sees exactly what the live one holds", liveTexts(live, "main") === liveTexts(reopened, "main"));

  live.detach();
  reopened.detach();
}

/** Observability must not switch off just because persistence wasn't configured. */
function storelessContextStillBroadcasts(): void {
  const events = new ListenerSink();
  const seen: AgentEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const context = new ConversationContext({
    address: "main",
    onHistoryChange: historyChangeEmitter(events, "s3"),
  });

  context.appendMessage(user("no store here"));
  context.replaceHistory([]);
  check("storeless: append still broadcast", seen.some((event) => event.type === "message.appended"));
  check("storeless: replace still broadcast", seen.some((event) => event.type === "history.replaced"));
  check("storeless: the envelope is stamped", seen.every((event) => event.address === "main" && event.sessionId === "s3"));
}

/** One mutation, one event — the regression lock for the emit sites that were collapsed into
 *  the journal. A leftover hand-written emit anywhere shows up here as a duplicate. */
function eachMutationBroadcastsExactlyOnce(): void {
  const events = new ListenerSink();
  const seen: AgentEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const context = new ConversationContext({
    address: "main",
    onHistoryChange: historyChangeEmitter(events, "s4"),
  });

  context.appendMessage(user("x"));
  check("once: one append ⇒ one message.appended", seen.filter((event) => event.type === "message.appended").length === 1);
  context.replaceHistory([user("y")]);
  check("once: one replace ⇒ one history.replaced", seen.filter((event) => event.type === "history.replaced").length === 1);
  context.applyCompaction({ summary: "s", compactedCount: 1, tokensBefore: 9, tokensAfter: 1 });
  check("once: one compaction ⇒ one history.compacted", seen.filter((event) => event.type === "history.compacted").length === 1);

  // Bookkeeping records go through the same door but are not history.
  const before = seen.length;
  context.record({ type: "usage.record", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
  check("once: an audit record broadcasts no history event", seen.length === before);
}

/** Replaying a log is not a new history change: a reader seeded from it must not also
 *  receive the whole transcript as live events. */
async function replayDoesNotRebroadcast(): Promise<void> {
  const store = new MemoryStore();
  const seed = new ConversationContext({ store, address: "main" });
  seed.appendMessage(user("persisted"));
  await seed.flush();

  const events = new ListenerSink();
  const seen: AgentEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const { replayContext } = await import("../loop/context.ts");
  const restored = await replayContext(store, "main", historyChangeEmitter(events, "s5"));

  check("replay: history was restored", textsOf(restored.messages) === "persisted");
  check("replay: but nothing was rebroadcast", seen.length === 0);

  // The listener is live for changes made AFTER the replay, though.
  restored.appendMessage(user("new"));
  check("replay: post-replay changes do broadcast", seen.filter((event) => event.type === "message.appended").length === 1);
}

async function main(): Promise<void> {
  await liveMatchesReplayThroughEveryMutation();
  await reattachAgreesWithTheLiveProjection();
  storelessContextStillBroadcasts();
  eachMutationBroadcastsExactlyOnce();
  await replayDoesNotRebroadcast();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

await main();
