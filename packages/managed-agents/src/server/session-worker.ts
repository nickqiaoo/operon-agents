/**
 * The execution half: claims sessions, pulls what was sent to them, and drives the Harness.
 *
 * A worker is not part of the API surface and nothing calls into it. It claims from the work
 * table (`SessionWork`) and everything it does with a session happens under that session's
 * lease. The API layer holds no reference to a worker — not even when both run in one process —
 * which is what lets any node run any session.
 *
 * ## Pull, both ways in
 *
 *  1. An idle worker's claim loop asks the table for one woken session, runs it, asks again;
 *     when there is none, it waits `claimIntervalMs`.
 *  2. A worker holding a session polls that session's inbox every `inputPollIntervalMs`, while
 *     the agent runs, and hands what it finds to the Harness through its public interface:
 *     `steerTo` for a message (the Harness takes it at the running turn's next step boundary,
 *     or wakes an idle session with it), `cancel` for an interrupt, `respond` for an answer.
 *
 * Nothing is pushed to a worker. Output goes the other way: translated to managed events
 * (`wire-events.ts`), recorded in the history under the lease, then broadcast.
 *
 * ## What "processed" means
 *
 * See `inbox.ts`. In short, a message is processed once it is in the conversation, so a worker
 * that dies after pulling it — or after handing it to the Harness, which queues it in memory —
 * leaves it pending, and the next holder delivers it again. A worker that dies after the
 * conversation took it, but before marking it, is the case `recoverDelivered` exists for: the
 * next holder finds the message in the transcript, marks it, and continues the run instead of
 * delivering it twice.
 *
 * A turn the dead worker left open is closed by the Harness itself before its next run.
 */

import { agentEventFromRecord, type SessionRepository } from "operon-agents/advanced";
import type { AgentEvent, Harness, HarnessSession, InterruptAnswer, PendingRunInterrupt } from "operon-agents";
import { isManagedPreviewEvent, type ManagedEventResource, type ManagedInputResource, type ManagedStreamEvent } from "../protocol/types.ts";
import type { EventBroadcaster } from "./broadcast.ts";
import type { InboxEntry } from "./inbox.ts";
import type { ManagedSessionMetadata, ManagedSessionMetadataStore } from "./metadata.ts";
import type { ManagedAgentRegistry, ManagedEnvironmentRegistry, ManagedSessionContext } from "./registries.ts";
import { DefaultAgentRegistry } from "./registries.ts";
import { blockingEventId, ManagedEventTranslator } from "./wire-events.ts";
import type { SessionWork, WorkLease } from "./work.ts";

/** How far a record's clock may trail the API's acceptance clock and still count as after it. */
const CLOCK_SKEW_MS = 60_000;

interface Recovered {
  /** Pending messages the conversation already holds. */
  readonly delivered: ReadonlySet<string>;
  /** The turn that took them never reached its end. */
  readonly unfinished: boolean;
}

export interface SessionWorkerOptions<TContext = unknown> {
  readonly harness: Harness<TContext>;
  /** The runtime sessions' repository. Read for crash recovery only; the Harness writes it. */
  readonly repository: SessionRepository;
  readonly metadataStore: ManagedSessionMetadataStore;
  readonly environments: ManagedEnvironmentRegistry;
  readonly agents?: ManagedAgentRegistry<TContext>;
  /** The work table. MUST be the same one the service appends through, or nothing is ever claimed. */
  readonly work: SessionWork;
  readonly defaultAgentId?: string;
  /** Heartbeat period while holding a session. MUST be comfortably below the table's TTL. Default 2s. */
  readonly renewIntervalMs?: number;
  /**
   * How often a held session's inbox is pulled. The latency bound for a message or interrupt
   * to reach a running agent. Default 500ms.
   */
  readonly inputPollIntervalMs?: number;
  /** How long the claim loop waits after finding nothing. Default 1s. */
  readonly claimIntervalMs?: number;
  /** How many sessions this worker may hold at once. Default 16. */
  readonly concurrency?: number;
  /** Where to publish this worker's sessions' events for live subscribers. */
  readonly broadcaster?: EventBroadcaster;
  /**
   * A run that threw — the environment would not resolve, the store was unreachable. The lease
   * is released either way; what was not processed stays pending, and the next send to that
   * session wakes it again. Default: `console.error`.
   */
  readonly onError?: (error: unknown, sessionId: string) => void;
  /**
   * Who this worker's sessions belong to. `"multi-tenant"` (the default) refuses what would leak
   * across tenants or run outside the sandbox: an environment not from the registry, a harness
   * holding process-wide MCP connections or an OAuth service, MCP over stdio, a token read from
   * the process environment. `"single-tenant"` lifts all of that for a self-hosted, one-owner
   * deployment, and says so once at construction. See docs/server-profile.md.
   */
  readonly profile?: "multi-tenant" | "single-tenant";
}

export class SessionWorker<TContext = unknown> {
  private readonly harness: Harness<TContext>;
  private readonly repository: SessionRepository;
  private readonly metadata: ManagedSessionMetadataStore;
  private readonly environments: ManagedEnvironmentRegistry;
  private readonly agents: ManagedAgentRegistry<TContext>;
  private readonly work: SessionWork;
  private readonly renewIntervalMs: number;
  private readonly inputPollIntervalMs: number;
  private readonly claimIntervalMs: number;
  private readonly concurrency: number;
  private readonly broadcaster: EventBroadcaster | undefined;
  private readonly onError: (error: unknown, sessionId: string) => void;
  private readonly multiTenant: boolean;
  /** The harness check, run once and remembered — a misconfigured harness fails every open alike. */
  private harnessChecked: Promise<void> | undefined;
  private readonly running = new Map<string, Promise<void>>();
  /** Sessions this worker is opening right now, under the lease it holds for each. */
  private readonly opening = new Set<string>();
  private claiming = false;
  private stopping = false;
  private interruptPause: (() => void) | undefined;

  constructor(options: SessionWorkerOptions<TContext>) {
    this.harness = options.harness;
    this.repository = options.repository;
    this.metadata = options.metadataStore;
    this.environments = options.environments;
    this.agents = options.agents ?? new DefaultAgentRegistry(options.defaultAgentId ?? "default");
    this.work = options.work;
    this.renewIntervalMs = options.renewIntervalMs ?? 2_000;
    this.inputPollIntervalMs = options.inputPollIntervalMs ?? 500;
    this.claimIntervalMs = options.claimIntervalMs ?? 1_000;
    this.concurrency = options.concurrency ?? 16;
    this.broadcaster = options.broadcaster;
    this.onError = options.onError ?? ((error, sessionId) => { console.error(`session ${sessionId}:`, error); });
    this.multiTenant = options.profile !== "single-tenant";
    if (!this.multiTenant) {
      console.warn("SessionWorker: single-tenant profile — sessions may share process-wide MCP connections and credentials, run MCP over stdio, and run in the worker's own environment.");
    } else {
      this.checkDeploymentPolicy();
      // A session on this harness that the worker did not open holds no lease: its writes carry no
      // fence, and nothing resolved its tenant's environment. An extension asking the harness for
      // one (creating a session, waking a closed one) is refused here rather than run that way.
      this.harness.onSessionOpened((session) => {
        if (!this.opening.has(session.id)) {
          throw new Error(`server profile: session ${session.id} was opened on a managed worker without a lease. Sessions here are opened by the worker when it claims them; send the session an event instead, or run the worker with profile: "single-tenant".`);
        }
      });
    }
  }

  private checkDeploymentPolicy(): void {
    if (this.harness.policy.strictIsolation !== true) throw new Error("server profile: harness.policy.strictIsolation must be true");
    if (this.harness.config.eventPublication !== "committed") throw new Error("server profile: harness.config.eventPublication must be committed");
  }

  /** Multi-tenant only: the harness must not carry what every session on the process would share. */
  private async checkHarness(): Promise<void> {
    this.checkDeploymentPolicy();
    const shared = (await this.harness.processSharedParts()).filter((part) => part !== "skillRegistry");
    if (shared.length > 0) {
      throw new Error(`server profile: the harness shares ${shared.join(" and ")} across every session in the process, which on a multi-tenant worker is across tenants. Build them per session (the agent registry's config.mcp.servers / bindings.mcpCredentials), or run the worker with profile: "single-tenant".`);
    }
  }

  /** Begin claiming. A worker that is never started runs nothing. */
  start(): void {
    if (this.claiming) return;
    this.claiming = true;
    this.stopping = false;
    void this.claimLoop();
  }

  /**
   * Stop claiming, end every run, release every lease. Runs are ended by closing the harness
   * (which aborts their turns), so the leases come back promptly and another node can take the
   * sessions over without waiting out a TTL. Their unprocessed inputs stay pending.
   */
  async stop(): Promise<void> {
    this.claiming = false;
    this.stopping = true;
    this.interruptPause?.();
    await this.harness.close();
    await Promise.allSettled([...this.running.values()]);
  }

  private async claimLoop(): Promise<void> {
    while (this.claiming) {
      const lease = this.running.size < this.concurrency
        ? await this.work.claim().catch((error: unknown) => { this.onError(error, "(claim)"); return undefined; })
        : undefined;
      if (lease !== undefined) {
        const done = this.run(lease).finally(() => {
          if (this.running.get(lease.sessionId) === done) this.running.delete(lease.sessionId);
        });
        this.running.set(lease.sessionId, done);
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.interruptPause = undefined; resolve(); }, this.claimIntervalMs);
        timer.unref?.();
        this.interruptPause = () => { clearTimeout(timer); this.interruptPause = undefined; resolve(); };
      });
    }
  }

  /** Everything that happens under one lease, from claim to release. Never rejects. */
  private async run(lease: WorkLease): Promise<void> {
    const { sessionId } = lease;
    const heartbeat = setInterval(() => {
      void lease.renew().catch((error: unknown) => this.onError(error, sessionId));
    }, this.renewIntervalMs);
    heartbeat.unref?.();
    const output = new OutputChannel(this.work, this.broadcaster, lease);
    try {
      // A previous holder of this session in this process may still be winding down.
      await this.running.get(sessionId);
      const metadata = await this.metadata.get(sessionId);
      if (metadata === undefined) return;
      if (metadata.deletedAt !== undefined) {
        await this.removeRuntime(sessionId);
        await this.metadata.delete(sessionId);
        return;
      }
      if ((await this.work.pending(sessionId)).length === 0) {
        await this.closeAbandonedStatus(sessionId, output);
        return;
      }
      const existed = (await this.repository.get(sessionId)) !== undefined;
      const session = await this.openSession(sessionId, metadata, existed);
      const cancel = (): void => session.cancel();
      lease.signal.addEventListener("abort", cancel, { once: true });
      try {
        await new SessionDriver(session, lease, this.work, output, {
          pollIntervalMs: this.inputPollIntervalMs,
          stopping: () => this.stopping,
          recover: existed ? (entries) => this.recoverDelivered(sessionId, entries) : undefined,
        }).drive();
      } finally {
        lease.signal.removeEventListener("abort", cancel);
        await session.close();
      }
    } catch (error) {
      // A failure outside any turn: the environment would not resolve, the sandbox would not
      // boot, the store was unreachable. Tell watchers now; the inputs are still pending.
      output.emit({
        type: "session.error",
        id: `sevt_err_${crypto.randomUUID().replaceAll("-", "")}`,
        processed_at: null,
        error: { type: "execution_error", message: error instanceof Error ? error.message : String(error) },
      });
      this.onError(error, sessionId);
    } finally {
      clearInterval(heartbeat);
      await output.flush().catch((error: unknown) => this.onError(error, sessionId));
      await lease.release().catch(() => undefined);
    }
  }

  /**
   * A session claimed with nothing to do was abandoned: its holder died, or let its lease lapse.
   * If that holder had told watchers the session was running, nobody ever told them it stopped.
   */
  private async closeAbandonedStatus(sessionId: string, output: OutputChannel): Promise<void> {
    const latest = await this.work.latestStatus(sessionId);
    if (latest?.type !== "session.status_running") return;
    output.emit({
      type: "session.error",
      id: `${latest.id}_lost`,
      processed_at: null,
      error: { type: "worker_lost", message: "the worker running this session stopped before the turn finished" },
    });
    output.emit({ type: "session.status_idle", id: `${latest.id}_idle`, processed_at: null, stop_reason: { type: "end_turn" } });
  }

  private async removeRuntime(sessionId: string): Promise<void> {
    if ((await this.repository.get(sessionId)) === undefined) return;
    await this.harness.deleteSession(sessionId);
  }

  /**
   * Which of these pending messages a previous holder already put in the conversation, and
   * whether the turn that took them was left open. Reads the transcript backwards and stops at
   * the first record older than the oldest of them, so a session with no crash behind it pays
   * for one page.
   */
  private async recoverDelivered(sessionId: string, entries: readonly InboxEntry[]): Promise<Recovered> {
    const wanted = new Set(entries.filter((entry) => entry.event.type === "user.message").map((entry) => entry.event.id));
    const delivered = new Set<string>();
    // The newest turn lifecycle event decides: an open `turn.started` means the run died.
    let unfinished: boolean | undefined;
    if (wanted.size === 0) return { delivered, unfinished: false };
    const oldest = Math.min(...entries.map((entry) => entry.acceptedAt)) - CLOCK_SKEW_MS;
    const handle = await this.repository.open(sessionId);
    if (handle === undefined) return { delivered, unfinished: false };
    try {
      let after: string | undefined;
      for (;;) {
        const page = await handle.store.readRecordPage({ limit: 128, order: "desc", address: "main", ...(after !== undefined ? { after } : {}) });
        for (const stored of page.data) {
          if (stored.record.time !== undefined && stored.record.time < oldest) return { delivered, unfinished: unfinished ?? false };
          const event = agentEventFromRecord(stored.record, sessionId);
          if (unfinished === undefined && (event?.type === "turn.started" || event?.type === "turn.ended" || event?.type === "turn.paused")) {
            unfinished = event.type === "turn.started";
          }
          const steerId = consumedSteerId(event);
          if (steerId !== undefined && wanted.has(steerId)) {
            delivered.add(steerId);
            if (delivered.size === wanted.size && unfinished !== undefined) return { delivered, unfinished };
          }
        }
        if (page.next === undefined) return { delivered, unfinished: unfinished ?? false };
        after = page.next;
      }
    } finally {
      await handle.store.close?.();
    }
  }

  private async openSession(sessionId: string, metadata: ManagedSessionMetadata, exists: boolean): Promise<HarnessSession<TContext>> {
    const ownerKey = metadata.ownerKey;
    const context: ManagedSessionContext = {
      sessionId,
      ...(ownerKey !== undefined ? { ownerKey } : {}),
      ...(metadata.metadata !== undefined ? { metadata: metadata.metadata } : {}),
    };
    const [agentResolution, environmentResolution] = await Promise.all([
      this.agents.resolve(metadata.agent, context),
      this.environments.resolve(metadata.environment, context),
    ]);
    if (this.multiTenant) {
      await (this.harnessChecked ??= this.checkHarness());
      if (environmentResolution.environment === undefined) {
        throw new Error(`server profile: environment "${metadata.environment.id}" resolved no environment for session ${sessionId}, so its tools would run in the harness's own. Return one per session from the environment registry, or run the worker with profile: "single-tenant".`);
      }
    }
    const shared = {
      config: agentResolution.config ?? {},
      bindings: { ...agentResolution.bindings,
        ...(environmentResolution.environment !== undefined ? { environment: environmentResolution.environment } : {}),
      },
    };
    // The managed record is the session's identity; the runtime session is made on first claim.
    // Options are passed on every open, so a loaded or loading instance is an error rather than
    // something to attach to: one lease, one instance.
    this.opening.add(sessionId);
    let session: HarnessSession<TContext>;
    try {
      session = exists
        ? await this.harness.resumeSession(sessionId, shared)
        : await this.harness.createSession({
            // Per-open options apply to the first open too; creation-only ones layer on top.
            ...shared,
            id: sessionId,
            workDir: environmentResolution.workDir,
            ...(metadata.title !== undefined ? { title: metadata.title } : {}),
            ...(ownerKey !== undefined ? { ownerKey } : {}),
          });
    } finally {
      this.opening.delete(sessionId);
    }
    return session;
  }
}

interface DriverOptions {
  readonly pollIntervalMs: number;
  readonly stopping: () => boolean;
  readonly recover: ((entries: readonly InboxEntry[]) => Promise<Recovered>) | undefined;
}

/**
 * One session under one lease: pull the inbox, hand it to the Harness, mark what was processed,
 * and stop once there is nothing left this holder can act on.
 */
class SessionDriver<TContext> {
  private readonly translator = new ManagedEventTranslator();
  /** Messages handed to the Harness, by id, waiting to show up in the conversation. */
  private readonly inFlight = new Map<string, ManagedInputResource>();
  /** Inputs this holder has acted on and is waiting to settle, so a poll does not repeat them. */
  private readonly handled = new Set<string>();
  private acks: Promise<void> = Promise.resolve();
  private responding: { readonly done: Promise<void> } | undefined;
  private readonly wake = new Wakeup();

  private readonly session: HarnessSession<TContext>;
  private readonly lease: WorkLease;
  private readonly work: SessionWork;
  private readonly output: OutputChannel;
  private readonly options: DriverOptions;

  constructor(session: HarnessSession<TContext>, lease: WorkLease, work: SessionWork, output: OutputChannel, options: DriverOptions) {
    this.session = session;
    this.lease = lease;
    this.work = work;
    this.output = output;
    this.options = options;
  }

  async drive(): Promise<void> {
    const { session } = this;
    this.translator.seed(await session.pendingInterruptions());
    const unsubscribe = session.onEvent((event) => this.observe(event));
    const poll = setInterval(() => this.wake.raise(), this.options.pollIntervalMs);
    poll.unref?.();
    const done = (): boolean => this.lease.signal.aborted || this.options.stopping();
    try {
      await this.recover();
      while (!done()) {
        this.wake.take();
        await this.apply(await this.work.pending(session.id));
        const woke = await Promise.race([this.settled().then(() => false), this.wake.wait().then(() => true)]);
        if (woke || done()) continue;
        // Idle. A message still in flight that is no longer queued never reached the conversation:
        // the run that would have taken it failed, and said so on the stream. It is processed
        // all the same. One still queued is about to start a run; look again shortly.
        if (this.inFlight.size > 0) {
          if (session.status.hasQueuedMessages) {
            await this.wake.wait();
            continue;
          }
          this.ack([...this.inFlight.values()]);
          this.inFlight.clear();
        }
        await this.acks;
        // Background work finishing starts a turn of its own; keep the session while it runs.
        if ((session.background?.list(true).length ?? 0) > 0) {
          await this.wake.wait();
          continue;
        }
        // The final look: clear the wake first, so a send landing after this read wakes the
        // row for the next claim instead of being stranded by our release.
        await this.lease.clearWake();
        if (!(await this.actionable(await this.work.pending(session.id)))) return;
      }
    } finally {
      clearInterval(poll);
      unsubscribe();
      await this.responding?.done;
      await this.acks.catch(() => undefined);
    }
  }

  /** Messages a previous holder put in the conversation but never marked processed. */
  private async recover(): Promise<void> {
    if (this.options.recover === undefined) return;
    const pending = await this.work.pending(this.session.id);
    const { delivered, unfinished } = await this.options.recover(pending);
    if (delivered.size === 0) return;
    this.ack(pending.filter((entry) => delivered.has(entry.event.id)).map((entry) => entry.event));
    await this.acks;
    // The turn that took them died with the previous holder: run once more so the agent answers
    // what it was given — unless newer input will start a run anyway.
    if (!unfinished) return;
    const rest = (await this.work.pending(this.session.id)).filter((entry) => !delivered.has(entry.event.id));
    if (rest.length === 0 && (await this.session.pendingInterruptions()).length === 0) {
      this.output.emit({ type: "session.status_rescheduled", id: `sevt_resched_${crypto.randomUUID().replaceAll("-", "")}`, processed_at: null });
      void this.session.prompt([]).catch(() => undefined);
    }
  }

  private observe(event: AgentEvent): void {
    for (const managed of this.translator.translate(event)) this.output.emit(managed);
    const id = event.type === "message.appended"
      ? consumedSteerId(event)
      : event.type === "steer.discarded" && (event.address ?? "main") === "main" ? event.steerId : undefined;
    const message = id === undefined ? undefined : this.inFlight.get(id);
    if (message !== undefined) {
      this.inFlight.delete(message.id);
      this.ack([message]);
    }
  }

  /** Act on what was pulled, in the order it was sent. */
  private async apply(entries: readonly InboxEntry[]): Promise<void> {
    const fresh = entries.filter((entry) => !this.handled.has(entry.event.id));
    if (fresh.length === 0) return;
    const interrupt = fresh.findLastIndex((entry) => entry.event.type === "user.interrupt");
    if (interrupt >= 0) {
      // Everything sent before the interrupt is superseded by it: cancel drops what the Harness
      // had queued, and what it had not been handed yet is dropped here.
      const superseded = fresh.slice(0, interrupt + 1).map((entry) => entry.event);
      for (const event of superseded) this.handled.add(event.id);
      this.session.cancel();
      await this.session.whenIdle();
      await this.responding?.done;
      this.ack([...superseded, ...this.inFlight.values()]);
      this.inFlight.clear();
      await this.apply(fresh.slice(interrupt + 1));
      return;
    }
    let pending: readonly PendingRunInterrupt[] | undefined;
    const blocked = async (): Promise<readonly PendingRunInterrupt[]> =>
      this.session.status.state === "running" || this.responding !== undefined ? [] : (pending ??= await this.session.pendingInterruptions());
    const answers: Record<string, InterruptAnswer> = {};
    const answered: ManagedInputResource[] = [];
    const stale: ManagedInputResource[] = [];
    for (const entry of fresh) {
      const event = entry.event;
      if (event.type === "user.message") {
        // Held while the session waits on a confirmation; it goes in once that is answered.
        if ((await blocked()).length > 0) continue;
        const text = event.content.map((block) => block.text).join("\n");
        this.handled.add(event.id);
        this.inFlight.set(event.id, event);
        await this.session.steerTo("main", text, { kind: "user" }, { id: event.id }).journaled;
        continue;
      }
      if (event.type === "user.tool_confirmation" || event.type === "user.custom_tool_result") {
        const target = event.type === "user.tool_confirmation" ? event.tool_use_id : event.custom_tool_use_id;
        const match = (await blocked()).find((item) => blockingEventId(item) === target);
        if (match === undefined) {
          // Not something this session is waiting on (any more): a repeat, or a late answer.
          stale.push(event);
          continue;
        }
        answers[match.approvalId] = event.type === "user.tool_confirmation"
          ? { kind: "approval", decision: event.result === "allow" ? "approved" : "rejected", ...(event.deny_message !== undefined ? { feedback: event.deny_message } : {}) }
          : { kind: "input", data: inputAnswer(match, event.content.map((block) => block.text).join("\n")) };
        answered.push(event);
      }
    }
    for (const event of stale) this.handled.add(event.id);
    if (stale.length > 0) this.ack(stale);
    // Resume only once every blocking call is answered, as Claude does; until then the answers
    // stay pending and are read again on the next pull (or by the next holder).
    const waiting = await blocked();
    if (answered.length > 0 && waiting.every((item) => answers[item.approvalId] !== undefined)) {
      for (const event of answered) this.handled.add(event.id);
      const done = this.session.respond(answers).then(
        () => undefined,
        (error: unknown) => {
          this.output.emit({
            type: "session.error",
            id: `sevt_err_${crypto.randomUUID().replaceAll("-", "")}`,
            processed_at: null,
            error: { type: "execution_error", message: error instanceof Error ? error.message : String(error) },
          });
        },
      ).finally(() => {
        this.ack(answered);
        this.responding = undefined;
        this.wake.raise();
      });
      this.responding = { done };
    }
  }

  /** Is there anything pending this holder would act on right now? */
  private async actionable(entries: readonly InboxEntry[]): Promise<boolean> {
    const fresh = entries.filter((entry) => !this.handled.has(entry.event.id));
    if (fresh.length === 0) return false;
    const waiting = await this.session.pendingInterruptions();
    if (waiting.length === 0) return true;
    // Paused: messages wait for the answer, and answers only count once they complete the set.
    if (fresh.some((entry) => entry.event.type === "user.interrupt")) return true;
    const answered = new Set(fresh.flatMap((entry) =>
      entry.event.type === "user.tool_confirmation" ? [entry.event.tool_use_id]
        : entry.event.type === "user.custom_tool_result" ? [entry.event.custom_tool_use_id] : []));
    const stale = [...answered].some((id) => !waiting.some((item) => blockingEventId(item) === id));
    return stale || waiting.every((item) => answered.has(blockingEventId(item)));
  }

  /** No run in flight and no resume pending. */
  private async settled(): Promise<void> {
    await this.session.whenIdle();
    await this.responding?.done;
    // A reason the runtime reports after the run (a failed wake run) arrives on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
    for (const event of this.translator.flush()) this.output.emit(event);
    await this.output.flush();
  }

  private ack(events: readonly ManagedInputResource[]): void {
    if (events.length === 0) return;
    this.acks = this.acks.then(async () => {
      await this.work.acknowledge(this.session.id, events.map((event) => event.id), this.lease.fence);
      // The history now shows them processed; tell watchers the same way.
      this.output.processed(events);
    }).catch(() => {
      // The lease is gone: the next holder sees them pending and deals with them.
      this.session.cancel();
    });
  }
}

/**
 * A `user.custom_tool_result` as the answer the paused call expects. The result is text, as in
 * Claude; a call suspended on questions (`AskUserQuestion`: `display.questions`) expects
 * answers keyed by question, so the text answers each of them, marked freeform so the model reads
 * it as prose. Anything else gets the text as it is.
 */
function inputAnswer(item: PendingRunInterrupt, text: string): unknown {
  if (item.kind !== "input") return text;
  const questions = (item.request.display as { readonly questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return text;
  const asked = questions
    .map((question: unknown) => (question as { readonly question?: unknown } | null)?.question)
    .filter((question): question is string => typeof question === "string");
  if (asked.length === 0) return text;
  return { answers: Object.fromEntries(asked.map((question) => [question, text])), method: "freeform" };
}

/**
 * Where a worker's managed events go: the history first (fenced by the lease), then the
 * broadcast. Serialized, so watchers see events in the order the history records them.
 */
class OutputChannel {
  private chain: Promise<void> = Promise.resolve();

  private readonly work: SessionWork;
  private readonly broadcaster: EventBroadcaster | undefined;
  private readonly lease: WorkLease;

  constructor(
    work: SessionWork,
    broadcaster: EventBroadcaster | undefined,
    lease: WorkLease,
  ) {
    this.work = work;
    this.broadcaster = broadcaster;
    this.lease = lease;
  }

  emit(event: ManagedStreamEvent): void {
    if (isManagedPreviewEvent(event)) {
      // Live-only: never in the history. Still on the chain, so a preview cannot overtake the
      // persisted events before it (`status_running`) or arrive after the message it previews.
      const broadcaster = this.broadcaster;
      if (broadcaster !== undefined) this.chain = this.chain.then(() => broadcaster.publish(this.lease.sessionId, event));
      return;
    }
    this.chain = this.chain.then(async () => {
      await this.work.recordOutput(this.lease.sessionId, [event], this.lease.fence);
      this.broadcaster?.publish(this.lease.sessionId, { ...event, processed_at: new Date().toISOString() } as ManagedEventResource);
    });
    // A failed write means the lease is gone; the next holder owns this session's history.
    this.chain = this.chain.catch(() => undefined);
  }

  /** Echo sent events on the stream once processed, as Claude does. */
  processed(events: readonly ManagedInputResource[]): void {
    const at = new Date().toISOString();
    this.chain = this.chain.then(() => {
      for (const event of events) this.broadcaster?.publish(this.lease.sessionId, { ...event, processed_at: at });
    });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

function consumedSteerId(event: AgentEvent | undefined): string | undefined {
  if (event?.type !== "message.appended" || (event.address ?? "main") !== "main") return undefined;
  const origin = event.origin;
  return origin !== undefined && "steerId" in origin && typeof origin.steerId === "string" ? origin.steerId : undefined;
}

/**
 * A latch that remembers. `raise` sets it; `take` reads and clears it; `wait` resolves at the
 * next raise, or at once if one is pending. Raises are never lost between a `take` and a `wait`.
 */
class Wakeup {
  private pending = false;
  private waiters: Array<() => void> = [];

  raise(): void {
    this.pending = true;
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  take(): boolean {
    const was = this.pending;
    this.pending = false;
    return was;
  }

  wait(): Promise<void> {
    if (this.pending) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }
}
