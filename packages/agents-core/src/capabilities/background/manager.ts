import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { errorMessage } from "../../loop/errors.ts";
import type { AgentEvent, EventSink } from "../../events/index.ts";
import type { SteerBus } from "../../loop/steer.ts";
import { reduceHistory, type AgentRecord, type SessionStore } from "../../store/index.ts";
import type { Message, TextContent } from "../../protocol/index.ts";
import type { AttachedOutcome, AttachedRunOptions, AttachedSettleStatus, BackgroundSpawner, CommandStarter, ProcessSpawnOptions, QuestionSpawnOptions } from "../../tool/background.ts";
import type { ToolResult } from "../../tool/types.ts";
import { CommandBackgroundTask } from "./command-task.ts";
import { QuestionBackgroundTask } from "./question-task.ts";
import { SwappableSink } from "./swappable-sink.ts";
import { isPersistedTaskTerminal, type BackgroundTaskPersistence, type PersistedTask } from "./persist.ts";
import {
  TERMINAL_STATUSES,
  isBackgroundTaskTerminal,
  type BackgroundTask,
  type BackgroundTaskInfo,
  type BackgroundTaskInfoBase,
  type BackgroundTaskOutputDelta,
  type BackgroundTaskOutputSnapshot,
  type BackgroundTaskSettlement,
  type BackgroundTaskStatus,
  type TaskOutputLocation,
  taskOutputRef,
} from "./task.ts";

/** The file variant, named so the read helpers can take it without re-narrowing. */
type TaskFileLocation = Extract<TaskOutputLocation, { kind: "file" }>;

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
const SIGTERM_GRACE_MS = 5_000;

const _ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += _ALPHABET[bytes[i]! % 36];
  return `${kind}-${suffix}`;
}

/** Remove task-store bookkeeping before a persisted ghost crosses the public manager API. */
function publicTaskInfo(task: PersistedTask): BackgroundTaskInfo {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    notificationQueuedAt: _notificationQueuedAt,
    notifiedAt: _notifiedAt,
    ...info
  } = task;
  return info as BackgroundTaskInfo;
}

export type { BackgroundTaskOutputDelta, BackgroundTaskOutputSnapshot } from "./task.ts";

/**
 * UTF-8 window alignment. Every read in this file is a BYTE window over text — the tail of a
 * log, a delta from an offset — and a byte offset lands mid-character often enough to matter:
 * any CJK log produces a replacement character at the seam on essentially every read.
 *
 * Two directions, because the two window kinds are cut differently. A tail is cut at the
 * FRONT (start at `size - n`), so the fix is to skip a leading run of continuation bytes. A
 * delta is cut at the BACK (read `n` bytes from a cursor), so the fix is to drop a trailing
 * partial sequence and leave those bytes for the next read — which is why `nextCursor` must be
 * derived from the trimmed length, never from what was read.
 *
 * Deliberately not a StringDecoder: that carries state across calls, which is right for a
 * follower with one reader and wrong here, where reads are independent, repeatable, and may
 * come from several consumers at different offsets.
 */
function utf8ContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/** Bytes a leading sequence needs, from its first byte. 1 when it is not a lead byte. */
function utf8SequenceLength(byte: number): number {
  if ((byte & 0b1000_0000) === 0) return 1;
  if ((byte & 0b1110_0000) === 0b1100_0000) return 2;
  if ((byte & 0b1111_0000) === 0b1110_0000) return 3;
  if ((byte & 0b1111_1000) === 0b1111_0000) return 4;
  return 1;
}

/** Offset of the first whole character, skipping a partial one the window opened inside of. */
function utf8AlignStart(buf: Buffer): number {
  const max = Math.min(buf.byteLength, 3);
  let i = 0;
  while (i < max && utf8ContinuationByte(buf[i]!)) i += 1;
  return i;
}

/** Length of the longest prefix that ends on a character boundary. */
function utf8AlignEnd(buf: Buffer): number {
  const len = buf.byteLength;
  // A sequence spans at most 4 bytes, so only the last 3 can be an unfinished one.
  for (let back = 1; back <= Math.min(3, len); back += 1) {
    const start = len - back;
    const byte = buf[start]!;
    if (utf8ContinuationByte(byte)) continue;
    const needed = utf8SequenceLength(byte);
    return needed > back ? start : len;
  }
  return len;
}

/** The journal record name workflow runs append under (see agent/workflow/journal.ts). */
const WORKFLOW_JOURNAL_ENTRY = "wf_journal";

/**
 * One journal entry as a line of a run's story.
 *
 * Deliberately a separate renderer from `renderWorkflowProgress`: that one formats LIVE events
 * for a terminal, this one formats RECORDS for a model reading back. The entries carry more
 * than the events did (a full result rather than a preview), and unknown types are skipped so
 * a record written by a newer version never breaks an older reader.
 */
function renderWorkflowJournalEntry(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const e = data as Record<string, unknown>;
  const where = [e["phase"], e["label"]].filter((v) => typeof v === "string" && v.length > 0).join(" / ");
  switch (e["type"]) {
    case "run":
      return `workflow: ${String(e["name"])}${e["args"] === undefined ? "" : `\nargs: ${safeJson(e["args"])}`}`;
    case "phase":
      return `── phase ${String(e["index"])}: ${String(e["title"])}`;
    case "started":
      return `▶ ${where || String(e["agentId"] ?? "agent")}`;
    case "result":
      return `✔ ${where || String(e["agentId"] ?? "agent")} → ${safeJson(e["result"])}`;
    case "error":
      return `✘ ${where || String(e["agentId"] ?? "agent")}: ${String(e["error"])}`;
    case "log":
      return String(e["message"]);
    case "outcome":
      return e["ok"] === true
        ? `outcome: ${String(e["status"] ?? "completed")} (${String(e["agentCount"] ?? 0)} agents)\nresult: ${safeJson(e["result"])}`
        : `outcome: ${String(e["status"] ?? "failed")} (${String(e["agentCount"] ?? 0)} agents)\nerror: ${String(e["error"] ?? "")}`;
    default:
      return undefined;
  }
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function emptyOutputSnapshot(): BackgroundTaskOutputSnapshot {
  return { content: "", sizeBytes: 0, contentBytes: 0, truncated: false };
}

/** A front-sliced window over an in-memory text value — unlike a log tail, an answer or a
 *  shard reduction reads from its beginning. */
function textSnapshot(text: string, maxBytes: number): BackgroundTaskOutputSnapshot {
  const full = Buffer.from(text, "utf-8");
  const window = full.subarray(0, Math.min(Math.max(0, Math.trunc(maxBytes)), full.byteLength));
  const aligned = window.subarray(0, utf8AlignEnd(window));
  return {
    content: aligned.toString("utf-8"),
    sizeBytes: full.byteLength,
    contentBytes: aligned.byteLength,
    truncated: full.byteLength > aligned.byteLength,
  };
}

/**
 * The last `maxBytes` of a task's output file. Reads only that window — a 2 GB build log
 * costs the same as a 2 KB one — and reports the file's full size so the caller learns how
 * much it is NOT seeing. The file keeps everything either way; this is just the window.
 */
async function tailFileSnapshot(file: { machine: TaskFileLocation["machine"]; path: string }, maxBytes: number): Promise<BackgroundTaskOutputSnapshot> {
  try {
    const size = (await file.machine.fileInfo(file.path)).size;
    const windowBytes = Math.min(maxBytes, size);
    if (windowBytes === 0) return { content: "", sizeBytes: size, contentBytes: 0, truncated: size > 0 };
    const bytes = await file.machine.readBytes(file.path, { offset: size - windowBytes, length: windowBytes });
    const aligned = bytes.subarray(utf8AlignStart(bytes));
    return {
      content: aligned.toString("utf-8"),
      sizeBytes: size,
      contentBytes: aligned.byteLength,
      truncated: size > aligned.byteLength,
    };
  } catch {
    // The file may have been removed or its Machine may no longer be reachable. Empty is the
    // honest snapshot; the task metadata still preserves the canonical location.
    return emptyOutputSnapshot();
  }
}

/** How often a WATCHED output file is checked for new bytes. Only ticks while someone is
 *  attached with a live tap; a detached task nobody is looking at costs nothing. */
const FOLLOW_INTERVAL_MS = 1_000;

/** How long a foreground run must last before the user is offered "move to background". */
const DETACHABLE_AFTER_MS = 2_000;

interface OutputFollower {
  /** Read whatever is left, then stop. Idempotent. */
  drain(): Promise<void>;
  stop(): void;
}

/**
 * Tail an output file for a watcher, reading only what was appended since the last tick — so
 * a tick costs what was WRITTEN, not what the file has accumulated. A decoder spans ticks
 * because a multi-byte character can straddle two reads.
 */
function followOutputFile(file: { machine: TaskFileLocation["machine"]; path: string }, emit: (chunk: string) => void): OutputFollower {
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const pump = async (): Promise<void> => {
    // Serialize: a slow read must not let the next tick re-read the same bytes.
    if (inFlight !== undefined) return await inFlight;
    inFlight = (async () => {
      try {
        const bytes = await file.machine.readBytes(file.path, { offset });
        if (bytes.byteLength > 0) {
          offset += bytes.byteLength;
          const text = decoder.write(bytes);
          if (text.length > 0) emit(text);
        }
      } catch {
        // Not created yet (the redirect is part of the command) or gone after a kill. The
        // live tap is best-effort; the command's own result is what settles the task.
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = undefined;
    }
  };

  const timer = setInterval(() => void pump(), FOLLOW_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();

  return {
    async drain(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await pump();
      const tail = decoder.end();
      if (tail.length > 0) emit(tail);
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export interface BackgroundManagerOptions {
  readonly maxRunningTasks?: number;
  readonly now?: () => number;
}

export interface BackgroundManagerRuntime {
  readonly steer?: SteerBus;
  readonly events?: EventSink;
  readonly sessionId?: string;
  readonly address?: string;
  /** Durable per-task status store. Absent → the manager runs purely in memory (no reconcile
   *  across process restarts), matching a session with no durable store. */
  readonly persistence?: BackgroundTaskPersistence;
  /** The session's append log, for reading shard-backed output (a sub-agent's conversation).
   *  Absent → shard locations cannot be served and say so, which is the honest answer for a
   *  storeless session: nothing was persisted to read back. */
  readonly store?: SessionStore;
}

interface ManagedTask {
  readonly taskId: string;
  readonly task: BackgroundTask;
  status: BackgroundTaskStatus;
  readonly startedAt: number;
  endedAt: number | null;
  readonly waiters: Array<() => void>;
  terminalFired: boolean;
  stopReason?: string | undefined;
  terminalNotificationSuppressed?: boolean | undefined;
  /** Settle-notification ledger; see `PersistedTask.notificationQueuedAt`. */
  notificationQueuedAt?: number | undefined;
  notifiedAt?: number | undefined;
  revision: number;
  readonly abortController: AbortController;
  lifecyclePromise: Promise<void>;
}

export class BackgroundManager implements BackgroundSpawner {
  private readonly tasks = new Map<string, ManagedTask>();
  // Per-tool-call detach triggers: the loop registers one around each running tool call
  // (keyed by toolCallId); firing it moves an attached foreground run into a background task.
  private readonly detachControllers = new Map<string, AbortController>();
  // Tasks loaded from the persistence store on reopen with no live process driving them.
  // `reconcile` reclassifies the non-terminal ones as `lost`. Terminal ghosts stay as a
  // read-through record for `/tasks` (list activeOnly=false) and `getTask`.
  private readonly ghosts = new Map<string, PersistedTask>();
  // Settles this process has already resent. The durable ledger cannot carry this: its entry
  // only closes when the recipient CONSUMES the message, so between the resend and that
  // confirmation the record still reads "owed" — and `reconcile` is a public call a host may
  // make more than once. Process-local by design: a real restart starts empty and resends.
  private readonly redelivered = new Set<string>();
  private readonly maxRunningTasks?: number;
  private readonly now: () => number;

  private steer?: SteerBus;
  private events?: EventSink;
  private sessionId = "";
  private address = "main";
  private persistence?: BackgroundTaskPersistence;
  private store?: SessionStore;
  private unsubscribeConsumption?: () => void;
  /** Serialize the whole task store, including the KV backend's shared task index. */
  private persistenceChain: Promise<void> = Promise.resolve();

  constructor(options: BackgroundManagerOptions = {}) {
    this.maxRunningTasks = options.maxRunningTasks;
    this.now = options.now ?? Date.now;
  }

  attach(runtime: BackgroundManagerRuntime): void {
    this.steer = runtime.steer;
    this.events = runtime.events;
    this.sessionId = runtime.sessionId ?? "";
    this.address = runtime.address ?? "main";
    // These are session identity, so an explicit storeless attach must clear a prior session's
    // handles instead of accidentally reading/writing the old session.
    this.persistence = runtime.persistence;
    this.store = runtime.store;
    // Close the settle-notification ledger from the only evidence that counts: the message
    // reaching the recipient's conversation. `steer` alone only reaches an in-memory queue.
    this.unsubscribeConsumption?.();
    this.unsubscribeConsumption = runtime.events?.subscribe((event: AgentEvent) => {
      if (event.type !== "message.appended") return;
      const origin = event.origin;
      if (origin?.kind !== "background_task") return;
      this.stampNotified(origin.taskId);
    });
  }

  /** Undo `attach`'s subscription. (Not `detach` — that one moves a tool call to the
   *  background and is part of the spawner surface.) */
  detachRuntime(): void {
    this.unsubscribeConsumption?.();
    this.unsubscribeConsumption = undefined;
  }

  /**
   * Load persisted task records for this session (called on reopen, before `reconcile`).
   * Records whose id is already a live task in this process are skipped — live always wins.
   */
  async loadFromDisk(): Promise<void> {
    // `attach` may move a manager to another session. A storeless target must see an empty
    // durable registry, not the prior session's already-loaded ghosts.
    this.ghosts.clear();
    if (this.persistence === undefined) return;
    for (const task of await this.persistence.listTasks()) {
      if (this.tasks.has(task.taskId)) continue;
      this.ghosts.set(task.taskId, task);
    }
  }

  /**
   * Reclassify orphaned tasks — a non-terminal ghost means the process that spawned it exited
   * without writing a terminal status, so it is dead → `lost`. Writes the terminal status back
   * (idempotent: `lost` is itself terminal, so a later reopen skips it) and emits a terminated
   * event. Call after `loadFromDisk` on session reopen. Returns the reclassified records.
   */
  async reconcile(): Promise<readonly BackgroundTaskInfo[]> {
    const lost: BackgroundTaskInfo[] = [];
    for (const [id, task] of this.ghosts) {
      if (!isPersistedTaskTerminal(task.status)) {
        const updated: PersistedTask = {
          ...task,
          status: "lost",
          endedAt: task.endedAt ?? this.now(),
          revision: task.revision + 1,
        };
        this.ghosts.set(id, updated);
        await this.enqueuePersist(updated);
        const info = publicTaskInfo(updated);
        this.emitTerminated(info);
        this.steerLost(info);
        lost.push(info);
        continue;
      }
      // Terminal, so the work itself finished — but if its notification was queued and never
      // confirmed, the process died before the model ever saw the result. Resend it. (Neither
      // stamp ⇒ nothing was ever owed: a suppressed settle. Leave it alone.)
      if (task.notificationQueuedAt !== undefined && task.notifiedAt === undefined && !this.redelivered.has(id)) {
        this.redelivered.add(id);
        this.steerUnconfirmed(task);
      }
    }
    return lost;
  }

  spawnCommand(start: CommandStarter, command: string, description: string, options?: ProcessSpawnOptions): string {
    return this.registerTask(new CommandBackgroundTask(start, command, description, options));
  }

  spawnQuestion(
    run: (signal: AbortSignal) => Promise<ToolResult>,
    description: string,
    options: QuestionSpawnOptions,
  ): { readonly taskId: string; readonly status: string } {
    const taskId = this.registerTask(new QuestionBackgroundTask(run, description, options));
    return { taskId, status: this.getTask(taskId)?.status ?? "running" };
  }

  // ── Attach / detach (foreground ↔ background) ─────────────────────────────────

  registerDetachable(toolCallId: string): AbortSignal {
    let controller = this.detachControllers.get(toolCallId);
    if (controller === undefined) {
      controller = new AbortController();
      this.detachControllers.set(toolCallId, controller);
    }
    return controller.signal;
  }

  unregisterDetachable(toolCallId: string): void {
    this.detachControllers.delete(toolCallId);
  }

  detach(toolCallId: string): boolean {
    const controller = this.detachControllers.get(toolCallId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  async runCommandAttached(
    start: CommandStarter,
    command: string,
    description: string,
    options: AttachedRunOptions,
  ): Promise<AttachedOutcome> {
    const task = new CommandBackgroundTask(start, command, description, {
      logPath: options.logPath,
      machine: options.machine,
      parentAddress: options.parentAddress,
      toolCallId: options.toolCallId,
    });
    return this.runAttached(task, {
      foregroundSignal: options.foregroundSignal,
      detachSignal: options.detachSignal,
      foregroundTimeoutMs: options.foregroundTimeoutMs,
      onLive: options.onLive,
      onDetachable: options.onDetachable,
      getExitCode: () => task.exitCode,
    });
  }

  /**
   * Drive a task attached to the foreground, racing its settlement against a detach trigger.
   * Owns the ONE controller both phases use: while attached it is bridged from
   * `foregroundSignal` (abort → kill) and an optional foreground timeout; on detach the bridge
   * is dropped (so the turn ending can't kill the now-background process) and the SAME
   * controller is handed to the manager so BackgroundStop still works.
   */
  private async runAttached(
    task: BackgroundTask,
    opts: {
      readonly foregroundSignal: AbortSignal;
      readonly detachSignal?: AbortSignal;
      readonly foregroundTimeoutMs?: number;
      readonly onLive?: (chunk: string) => void;
      readonly onDetachable?: () => void;
      readonly getExitCode?: () => number | null;
    },
  ): Promise<AttachedOutcome> {
    // BackgroundManager's attached driver always requires canonical durable output, even when
    // a low-level caller omitted the detach routing signal. Validate before starting so the
    // optional routing seam can never silently reintroduce a pipe-only manager path.
    this.assertDurableOutput(task);
    const controller = new AbortController();
    const sink = new SwappableSink(controller.signal);

    let detached = false;
    let cause: "timeout" | "aborted" | undefined;

    let resolveSettled!: (settlement: BackgroundTaskSettlement) => void;
    const settledP = new Promise<BackgroundTaskSettlement>((resolve) => {
      resolveSettled = resolve;
    });
    let resolveDetached!: (taskId: string) => void;
    const detachedP = new Promise<string>((resolve) => {
      resolveDetached = resolve;
    });

    // A file-backed task pushes nothing (its output never enters this process), so the live
    // echo comes from reading the file. The poll exists ONLY while someone is watching: it
    // starts because `onLive` was supplied, and stops the moment the run detaches or settles.
    // Nobody watching → not a single read, which is the whole reason the file is the store.
    const follow =
      task.outputLocation?.kind === "file" && opts.onLive !== undefined
        ? followOutputFile(task.outputLocation, (chunk) => {
            if (!detached) opts.onLive?.(chunk);
          })
        : undefined;

    sink.setDownstream({
      settle: async (settlement) => {
        // Final read first: the command may have written between the last tick and its exit.
        await follow?.drain();
        resolveSettled(settlement);
        return true;
      },
    });

    // Aborting IS the whole stop protocol: a command task forwards the signal to `machine.run`,
    // where SIGTERM → grace → SIGKILL escalation lives (the layer that can actually kill).
    const kill = (why: "timeout" | "aborted"): void => {
      if (cause === undefined) cause = why;
      controller.abort();
    };
    const onForegroundAbort = (): void => kill("aborted");
    if (opts.foregroundSignal.aborted) kill("aborted");
    else opts.foregroundSignal.addEventListener("abort", onForegroundAbort);
    const timeoutTimer =
      opts.foregroundTimeoutMs !== undefined ? setTimeout(() => kill("timeout"), opts.foregroundTimeoutMs) : undefined;

    // Start the task. Its output already goes to its durable location; the sink owns only stop
    // and settlement. On an error before settle, synthesize one so `settledP` always resolves.
    const startPromise = Promise.resolve()
      .then(() => task.start(sink))
      .catch(async (error: unknown) => {
        const aborted = controller.signal.aborted;
        await sink.settle({
          status: aborted ? "killed" : "failed",
          stopReason: aborted ? undefined : errorMessage(error),
        });
      });

    // "Long enough to be worth offering." A command that returns in milliseconds never makes
    // the UI flash a "move to background" affordance the user could not have acted on; one
    // that is still going after this gets the offer, and only then. Mirrors the threshold a
    // progress indicator appears at, because it answers the same question: is this run slow?
    const detachableTimer =
      opts.detachSignal !== undefined && opts.onDetachable !== undefined
        ? setTimeout(() => {
            if (!detached) opts.onDetachable?.();
          }, DETACHABLE_AFTER_MS)
        : undefined;
    if (detachableTimer !== undefined && typeof detachableTimer.unref === "function") detachableTimer.unref();

    const onDetach = (): void => {
      if (detached) return;
      detached = true;
      // The watcher is gone; the task keeps running and its file keeps growing, but nobody
      // is looking, so nobody reads. BackgroundOutput windows the file on demand instead.
      follow?.stop();
      opts.foregroundSignal.removeEventListener("abort", onForegroundAbort);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      const taskId = this.adoptRunning(task, controller, sink, startPromise);
      resolveDetached(taskId);
    };
    if (opts.detachSignal !== undefined) {
      if (opts.detachSignal.aborted) onDetach();
      else opts.detachSignal.addEventListener("abort", onDetach, { once: true });
    }

    try {
      const outcome = await Promise.race([
        settledP.then((settlement) => ({ settlement }) as const),
        detachedP.then((taskId) => ({ taskId }) as const),
      ]);
      if ("taskId" in outcome) {
        return { kind: "detached", taskId: outcome.taskId };
      }
      let status: AttachedSettleStatus = outcome.settlement.status === "paused" ? "failed" : outcome.settlement.status;
      // The task reports a plain "killed" on abort; distinguish a foreground timeout.
      if (status === "killed" && cause === "timeout") status = "timed_out";
      return { kind: "settled", status, exitCode: opts.getExitCode?.() ?? null };
    } finally {
      follow?.stop();
      if (detachableTimer !== undefined) clearTimeout(detachableTimer);
      opts.foregroundSignal.removeEventListener("abort", onForegroundAbort);
      opts.detachSignal?.removeEventListener("abort", onDetach);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }
  }

  /**
   * Adopt an already-running task (started by `runAttached`) into the managed set, reusing its
   * existing abort controller and swapping the sink downstream to this manager. Does NOT call
   * `task.start` (already running) and intentionally bypasses the running-task cap: detaching
   * promotes work that is already executing, it does not start new work.
   */
  private adoptRunning(
    task: BackgroundTask,
    controller: AbortController,
    sink: SwappableSink,
    lifecyclePromise: Promise<void>,
  ): string {
    this.assertDurableOutput(task);
    const taskId = generateTaskId(task.idPrefix);
    const entry: ManagedTask = {
      taskId,
      task,
      status: "running",
      startedAt: this.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
      revision: 0,
      abortController: controller,
      lifecyclePromise,
    };
    this.tasks.set(taskId, entry);
    // Hand the still-running task's eventual settlement to this manager entry. Its output
    // continues writing to the same durable location it had while attached.
    sink.setDownstream({
      settle: (settlement) => this.settleTask(entry, settlement),
    });
    this.emitStarted(this.toInfo(entry));
    void this.persistLive(entry);
    return taskId;
  }

  registerTask(task: BackgroundTask): string {
    this.assertDurableOutput(task);
    this.assertCanRegister();
    const taskId = generateTaskId(task.idPrefix);
    const entry: ManagedTask = {
      taskId,
      task,
      status: "running",
      startedAt: this.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
      revision: 0,
      abortController: new AbortController(),
      lifecyclePromise: Promise.resolve(),
    };
    this.tasks.set(taskId, entry);

    // Persist the origin + stable task id BEFORE starting user work. If the process dies after
    // start but before the spawn ack reaches conversation history, cold recovery can still map
    // `(parentAddress, toolCallId)` back to this task. A failed persistence backend is already
    // fail-soft inside persistLive; storeless sessions simply continue in memory.
    const persisted = this.persistLive(entry);
    entry.lifecyclePromise = persisted
      .then(() =>
        task.start({
          signal: entry.abortController.signal,
          settle: (settlement) => this.settleTask(entry, settlement),
        }),
      )
      .catch(async (error: unknown) => {
        const aborted = entry.abortController.signal.aborted;
        await this.settleTask(entry, {
          status: aborted ? "killed" : "failed",
          stopReason: aborted ? undefined : errorMessage(error),
        });
      });

    this.emitStarted(this.toInfo(entry));
    return taskId;
  }

  /** The durable projection of a task. The output's address comes from the task itself and is
   *  never reconstructed from an id. */
  private toPersisted(entry: ManagedTask): PersistedTask {
    const info = this.toInfo(entry);
    const ledger = {
      ...(entry.notificationQueuedAt !== undefined ? { notificationQueuedAt: entry.notificationQueuedAt } : {}),
      ...(entry.notifiedAt !== undefined ? { notifiedAt: entry.notifiedAt } : {}),
    };
    return { ...info, schemaVersion: 2, revision: entry.revision, ...ledger };
  }

  /** Queue a snapshot behind every earlier write. This prevents a slow `running` write from
   *  landing after a terminal snapshot, and prevents concurrent KV index updates losing ids. */
  private enqueuePersist(task: PersistedTask): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return Promise.resolve();
    const write = this.persistenceChain
      .catch(() => undefined)
      .then(() => persistence.writeTask(task))
      .then(() => undefined, () => undefined);
    this.persistenceChain = write;
    return write;
  }

  /** Capture the next monotonic revision before placing it on the persistence queue. */
  private async persistLive(entry: ManagedTask): Promise<void> {
    if (this.persistence === undefined) return;
    entry.revision += 1;
    await this.enqueuePersist(this.toPersisted(entry));
  }

  private assertCanRegister(): void {
    if (this.maxRunningTasks === undefined) return;
    if (this.activeTaskCount() < this.maxRunningTasks) return;
    throw new Error("Too many background tasks are already running.");
  }

  /** Background status is metadata, never a result store. Every non-question task must point
   *  at exactly one authoritative durable output location before it can enter the registry. */
  private assertDurableOutput(task: BackgroundTask): void {
    const kind = task.outputLocation?.kind;
    const valid =
      (task.kind === "process" && kind === "file") ||
      (task.kind === "agent" && kind === "conversation") ||
      (task.kind === "workflow" && kind === "workflow-run") ||
      (task.kind === "question" && kind === undefined);
    if (!valid) {
      throw new Error(`Background ${task.kind} tasks require their canonical durable output location.`);
    }
    if ((kind === "conversation" || kind === "workflow-run") && this.store === undefined) {
      throw new Error(`Background ${task.kind} tasks require an attached durable session store.`);
    }
  }

  private activeTaskCount(): number {
    let count = 0;
    for (const entry of this.tasks.values()) if (!TERMINAL_STATUSES.has(entry.status)) count++;
    return count;
  }

  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) return this.toInfo(entry);
    const ghost = this.ghosts.get(taskId);
    return ghost === undefined ? undefined : publicTaskInfo(ghost);
  }

  /** Find the task spawned by one assistant tool call. `toolCallId` is provider-scoped, so the
   *  parent conversation address is part of the identity. Used internally by cold recovery;
   *  model-facing reads continue to use the stable task id via BackgroundOutput. */
  findByOrigin(parentAddress: string, toolCallId: string): BackgroundTaskInfo | undefined {
    for (const entry of this.tasks.values()) {
      if (entry.task.parentAddress === parentAddress && entry.task.toolCallId === toolCallId) {
        return this.toInfo(entry);
      }
    }
    for (const task of this.ghosts.values()) {
      if (task.parentAddress === parentAddress && task.toolCallId === toolCallId) return publicTaskInfo(task);
    }
    return undefined;
  }

  list(activeOnly = true, limit?: number): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      if (activeOnly && TERMINAL_STATUSES.has(entry.status)) continue;
      result.push(this.toInfo(entry));
      if (limit !== undefined && result.length >= limit) return result;
    }
    // Ghosts are all terminal (loaded from a prior process, then reconciled), so they only
    // surface when the caller wants terminal tasks too. Skip any now driven live.
    if (!activeOnly) {
      for (const [id, task] of this.ghosts) {
        if (this.tasks.has(id)) continue;
        result.push(publicTaskInfo(task));
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  /**
   * A bounded WINDOW onto a task's output, plus the truth about how much it is a window of.
   * Never the whole thing: `sizeBytes` says how much exists, `truncated` admits the
   * rest was dropped, and the location says where the complete record lives.
   *
   * Dispatch is on WHERE the output lives, not on what kind of task produced it — a file gets
   * a byte window and a shard gets its durable record reduced to a useful preview. A question
   * has no output location — its answer rides on the task record itself — so it is served
   * from there: the settle notification truncates a long answer and points here for the rest.
   */
  async readOutput(taskId: string, maxBytes = MAX_OUTPUT_BYTES): Promise<BackgroundTaskOutputSnapshot> {
    const entry = this.tasks.get(taskId);
    // A ghost (loaded from a prior process) has no live entry but may still name a location —
    // a log file outlives the process that wrote it, and so does a shard.
    if (entry === undefined) return await this.ghostOutputSnapshot(taskId, maxBytes);
    const location = entry.task.outputLocation;
    if (location?.kind === "file") return await tailFileSnapshot(location, Math.max(0, Math.trunc(maxBytes)));
    if (location?.kind === "conversation") return await this.conversationSnapshot(location.address, Math.max(0, Math.trunc(maxBytes)));
    if (location?.kind === "workflow-run") return await this.workflowRunSnapshot(location.address, Math.max(0, Math.trunc(maxBytes)));
    const info = this.toInfo(entry);
    if (info.kind === "question" && info.answer !== undefined) return textSnapshot(info.answer, maxBytes);
    return emptyOutputSnapshot();
  }

  /**
   * A sub-agent's output, read back from its own conversation shard.
   *
   * The shard is the record — the same one the projection folds for a UI — so this reads it
   * rather than keeping a copy. It works on a RUNNING agent too: its messages are appended as
   * the run proceeds, so the latest answer is whatever it has said so far, not a blank until
   * the run settles.
   */
  private async conversationSnapshot(address: string, maxBytes: number): Promise<BackgroundTaskOutputSnapshot> {
    const store = this.store;
    if (store === undefined) return emptyOutputSnapshot();
    try {
      const records: AgentRecord[] = [];
      for await (const record of store.readRecords({ address })) records.push(record);
      const { messages } = reduceHistory(records);
      // The agent's answer is the last thing it said. Tool calls and their results are steps
      // toward it, already in the shard for anyone who wants the whole trace.
      return textSnapshot(lastAssistantText(messages), maxBytes);
    } catch {
      return emptyOutputSnapshot();
    }
  }

  /**
   * A workflow run, rendered from its journal.
   *
   * The journal is the run's whole story in append order — inputs, each agent starting and
   * returning, the script's own `log()` lines, failures, and the outcome — so this reads it
   * rather than keeping a parallel copy of the progress stream. It answers for a RUNNING run
   * too: entries land as each step completes, so "where is it up to" is just the story so far.
   */
  private async workflowRunSnapshot(address: string, maxBytes: number): Promise<BackgroundTaskOutputSnapshot> {
    const store = this.store;
    if (store === undefined) return emptyOutputSnapshot();
    try {
      const lines: string[] = [];
      for await (const record of store.readRecords({ address })) {
        if (record.type !== "custom" || record.name !== WORKFLOW_JOURNAL_ENTRY) continue;
        const line = renderWorkflowJournalEntry(record.data);
        if (line !== undefined) lines.push(line);
      }
      // Cut at the BACK: a run reads forward from its first step.
      return textSnapshot(lines.join("\n"), maxBytes);
    } catch {
      return emptyOutputSnapshot();
    }
  }

  /** A task with no live entry: its location, if any, outlived the process that ran it. */
  private async ghostOutputSnapshot(taskId: string, maxBytes: number): Promise<BackgroundTaskOutputSnapshot> {
    const ghost = this.ghosts.get(taskId);
    if (ghost === undefined) return emptyOutputSnapshot();
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (ghost.outputRef?.kind === "conversation") {
      return await this.conversationSnapshot(ghost.outputRef.address, limit);
    }
    if (ghost.outputRef?.kind === "workflow-run") {
      return await this.workflowRunSnapshot(ghost.outputRef.address, limit);
    }
    // A question's answer is persisted on the task record itself, so it survives the process.
    if (ghost.kind === "question" && ghost.answer !== undefined) return textSnapshot(ghost.answer, limit);
    // A process ghost knows its output path but not the machine it lived on — the Machine is a
    // live handle, not a serialisable one. The tool surfaces `output_path` for a `Read`.
    return emptyOutputSnapshot();
  }

  /**
   * Everything appended since `cursor`, for a viewer that is following along — the shape
   * a live panel needs, and the one that keeps a tick costing what was WRITTEN rather than
   * what the task has produced in total.
   *
   * Only file-backed tasks can serve it: their output has a stable byte offset because the
   * file keeps everything. Anything else is not followable and the caller falls back to a
   * snapshot — for a shard-backed agent the better live view is the SessionProjection, which
   * folds the same records the UI already subscribes to.
   */
  async readOutputDelta(
    taskId: string,
    cursor: number,
    maxBytes = MAX_OUTPUT_BYTES,
  ): Promise<BackgroundTaskOutputDelta> {
    const from = Math.max(0, Math.trunc(cursor));
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return { content: "", nextCursor: from, followable: false };
    const location = entry.task.outputLocation;
    if (location?.kind !== "file") return { content: "", nextCursor: from, followable: false };
    const file = location;
    try {
      const bytes = await file.machine.readBytes(file.path, { offset: from, length: Math.max(0, Math.trunc(maxBytes)) });
      // Leave a trailing partial sequence behind and advance the cursor only past what was
      // decodable: the next tick re-reads those bytes and completes the character.
      const whole = bytes.subarray(0, utf8AlignEnd(bytes));
      return { content: whole.toString("utf-8"), nextCursor: from + whole.byteLength, followable: true };
    } catch {
      // Gone after cleanup or the Machine is temporarily unreachable.
      return { content: "", nextCursor: from, followable: true };
    }
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined || entry.terminalNotificationSuppressed === true) return;
    entry.terminalNotificationSuppressed = true;
  }

  async stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    const trimmedReason = reason?.trim();
    const stopReason = trimmedReason === undefined || trimmedReason.length === 0 ? undefined : trimmedReason;

    if (TERMINAL_STATUSES.has(entry.status)) {
      return this.toInfo(entry);
    }

    entry.stopReason = stopReason;
    entry.abortController.abort(stopReason);

    // Wait up to 5s for the lifecycle path to settle, then SIGKILL. Waiting on
    // lifecyclePromise lets a natural completion win the race over the kill.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      entry.lifecyclePromise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), SIGTERM_GRACE_MS);
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (TERMINAL_STATUSES.has(entry.status)) {
      return this.toInfo(entry);
    }

    // `graceful: false` adds no second escalation step here — the task's own backend already
    // escalated when the signal fired. What is left is to record the terminal status.
    await this.settleTask(entry, { status: "killed", stopReason });
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const ids = Array.from(this.tasks.keys());
    const results = await Promise.all(ids.map((id) => this.stop(id, reason)));
    return results.filter((info): info is BackgroundTaskInfo => info !== undefined);
  }

  /**
   * Settle when the task reaches a terminal status, the timeout elapses, or `signal` aborts —
   * whichever comes first. Returns the task's status either way; the caller compares it against
   * the terminal set to tell "it finished" from "I stopped waiting".
   *
   * `signal` matters because the timeout can be up to an hour: without it a blocking waiter
   * outlives the turn that started it, and the loop's post-abort grace window has to shoot the
   * tool down with a synthetic error instead of letting it return cleanly.
   */
  async wait(taskId: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    if (TERMINAL_STATUSES.has(entry.status) || signal?.aborted === true) {
      return this.toInfo(entry);
    }

    let terminalWaiter: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          terminalWaiter = resolve;
          entry.waiters.push(resolve);
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
        new Promise<void>((resolve) => {
          if (signal === undefined) return; // never settles — leaves the race to the other two
          onAbort = resolve;
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      if (terminalWaiter !== undefined) {
        const index = entry.waiters.indexOf(terminalWaiter);
        if (index !== -1) entry.waiters.splice(index, 1);
      }
    }

    return this.toInfo(entry);
  }

  private async settleTask(entry: ManagedTask, settlement: BackgroundTaskSettlement): Promise<boolean> {
    if (TERMINAL_STATUSES.has(entry.status)) {
      if (entry.status === "killed" && settlement.status === "killed") {
        entry.endedAt = Math.max(this.now(), (entry.endedAt ?? 0) + 1);
        this.fireTerminalEffects(entry);
        this.resolveWaiters(entry);
      }
      return false;
    }
    entry.status = settlement.status;
    entry.endedAt = this.now();
    entry.stopReason = settlement.stopReason ?? (settlement.status === "killed" ? entry.stopReason : undefined);
    // Persist the terminal status before firing effects so the durable record is written
    // before the run is observably done — a crash after this leaves a correct terminal record,
    // not a `running` one that reconcile would wrongly mark lost.
    await this.persistLive(entry);
    this.fireTerminalEffects(entry);
    this.resolveWaiters(entry);
    return true;
  }

  private resolveWaiters(entry: ManagedTask): void {
    for (const resolve of entry.waiters.splice(0)) resolve();
  }

  private fireTerminalEffects(entry: ManagedTask): void {
    if (entry.terminalFired) return;
    entry.terminalFired = true;
    const info = this.toInfo(entry);
    this.emitTerminated(info);
    this.steerTerminal(info);
  }

  private steerTerminal(info: BackgroundTaskInfo): void {
    if (this.steer === undefined) return;
    if (this.isTerminalNotificationSuppressed(info.taskId)) return;
    const summary = buildTerminalSummary(info, { answer: this.answeredQuestionOutput(info) });
    // The rendered tag is the durable settle record (journaled next turn); the identity
    // attrs are what the subagent/workflow folds match on.
    this.steer.steer(summary, {
      kind: "background_done",
      taskId: info.taskId,
      summary,
      ...(settleToolCallId(info) !== undefined ? { toolCallId: settleToolCallId(info) } : {}),
      ...settleIdentity(info),
    });
    this.stampNotificationQueued(info.taskId);
  }

  /**
   * A finished question's answer.
   *
   * The ONE kind whose settle must carry its output. Every other kind's substance survives
   * the notification: a command's bytes are in its log file, a subagent's final message is in
   * its shard, a workflow's agent results are in its journal. A question's answer is the user
   * SPEAKING — unreproducible, and held nowhere but this process's memory. Leaving it out of
   * the settle would drop what the user said out of the conversation record entirely.
   *
   * Read straight off the task's own record — no buffer involved, so this stays synchronous
   * and `steerTerminal` never has to await (awaiting would reopen the suppression race that
   * going sync closed).
   */
  private answeredQuestionOutput(info: BackgroundTaskInfo): string | undefined {
    if (info.kind !== "question" || info.status !== "completed") return undefined;
    return info.answer !== undefined && info.answer.length > 0 ? info.answer : undefined;
  }

  /**
   * Open the ledger entry: a notification is owed from here until its `message.appended`
   * confirms it. Deliberately written AFTER the enqueue, not before — the write is the slow
   * part, and a crash between the two only costs a duplicate settle on reopen, whereas
   * enqueueing after a failed write would cost a silent loss.
   */
  private stampNotificationQueued(taskId: string): void {
    if (this.persistence === undefined) return;
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) {
      entry.notificationQueuedAt = this.now();
      void this.persistLive(entry);
      return;
    }
    const ghost = this.ghosts.get(taskId);
    if (ghost === undefined) return;
    const updated: PersistedTask = { ...ghost, notificationQueuedAt: this.now(), revision: ghost.revision + 1 };
    this.ghosts.set(taskId, updated);
    void this.enqueuePersist(updated);
  }

  /** Close it: the settle is in the recipient's conversation and will never need resending. */
  private stampNotified(taskId: string): void {
    if (this.persistence === undefined) return;
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) {
      if (entry.notifiedAt !== undefined) return;
      entry.notifiedAt = this.now();
      void this.persistLive(entry);
      return;
    }
    const ghost = this.ghosts.get(taskId);
    if (ghost === undefined || ghost.notifiedAt !== undefined) return;
    const updated: PersistedTask = { ...ghost, notifiedAt: this.now(), revision: ghost.revision + 1 };
    this.ghosts.set(taskId, updated);
    void this.enqueuePersist(updated);
  }

  private isTerminalNotificationSuppressed(taskId: string): boolean {
    return this.tasks.get(taskId)?.terminalNotificationSuppressed === true;
  }

  /** Steer a lost notification for a task reconciled on reopen, so the model learns its
   *  background work died with the previous process (the journaled tag is the settle record). */
  private steerLost(info: BackgroundTaskInfo): void {
    if (this.steer === undefined) return;
    const summary = `${info.description} was running when the previous process exited; marked lost.`;
    this.steer.steer(summary, { kind: "background_done", taskId: info.taskId, summary, ...settleIdentity(info) });
    // A lost-notice can itself be lost — the ledger covers it on the same terms.
    this.stampNotificationQueued(info.taskId);
  }

  /**
   * Resend a settle whose notification was queued but never confirmed — i.e. the process died
   * in the window between the enqueue and the recipient consuming it.
   *
   * Output survival is stated by `outputRef`, not inferred from task kind. Files, conversation
   * shards, and workflow journals all outlive this manager; an answered question is recovered
   * from the task record itself.
   */
  private steerUnconfirmed(task: PersistedTask): void {
    if (this.steer === undefined) return;
    const answer = task.kind === "question" && task.status === "completed" ? task.answer : undefined;
    const readable =
      answer !== undefined ||
      task.outputRef?.kind === "file" ||
      ((task.outputRef?.kind === "conversation" || task.outputRef?.kind === "workflow-run") && this.store !== undefined);
    const note = readable
      ? "(Settled in an earlier process; its durable output is still available.)"
      : "(Settled in an earlier process; no durable output reference is available.)";
    const summary = `${buildTerminalSummary(task, { outputReadable: readable, answer })}\n${note}`;
    this.steer.steer(summary, { kind: "background_done", taskId: task.taskId, summary, ...settleIdentity(task) });
    this.stampNotificationQueued(task.taskId);
  }

  private emitStarted(info: BackgroundTaskInfo): void {
    void this.events?.emit({ address: this.address, sessionId: this.sessionId, type: "background.task.started", info });
  }

  private emitTerminated(info: BackgroundTaskInfo): void {
    void this.events?.emit({ address: this.address, sessionId: this.sessionId, type: "background.task.terminated", info });
  }

  private toInfo(entry: ManagedTask): BackgroundTaskInfo {
    const outputRef = taskOutputRef(entry.task.outputLocation);
    const base: BackgroundTaskInfoBase = {
      taskId: entry.taskId,
      ...(entry.task.parentAddress !== undefined ? { parentAddress: entry.task.parentAddress } : {}),
      ...(entry.task.toolCallId !== undefined ? { toolCallId: entry.task.toolCallId } : {}),
      description: entry.task.description,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      terminalNotificationSuppressed: entry.terminalNotificationSuppressed,
      timeoutMs: entry.task.timeoutMs,
      ...(outputRef !== undefined ? { outputRef } : {}),
    };
    return entry.task.toInfo(base);
  }
}

/** Identity + fine-grained status attrs for a settle notification, per task kind. */
/** The tool call a task was spawned from, for the kinds that record one. */
function settleToolCallId(info: BackgroundTaskInfo): string | undefined {
  return info.toolCallId;
}

function settleIdentity(info: BackgroundTaskInfo): { agentId?: string; runId?: string; status?: string } {
  if (info.kind === "agent") {
    return { agentId: info.agentId, status: info.agentStatus ?? subagentStatusFromTask(info.status) };
  }
  if (info.kind === "workflow") {
    return { runId: info.runId, status: info.runStatus ?? workflowStatusFromTask(info.status) };
  }
  return {};
}

/** Coarse fallback when the run didn't report its own status (e.g. timed out, killed). */
function subagentStatusFromTask(status: BackgroundTaskStatus): string {
  return status === "completed"
    ? "completed"
    : status === "paused"
      ? "paused"
      : status === "killed"
        ? "cancelled"
        : status === "lost"
          ? "lost"
          : "error";
}

function workflowStatusFromTask(status: BackgroundTaskStatus): string {
  return status === "completed" ? "completed" : status === "killed" || status === "lost" ? "aborted" : "failed";
}

/** Generous by design: a hand-typed answer never approaches it, so the cap only ever fires on
 *  something pathological, and the notice stays the whole record in every real case. */
const QUESTION_ANSWER_MAX_CHARS = 8_000;

interface TerminalSummaryOptions {
  /** False when the output no longer exists to be fetched — an earlier process's in-memory
   *  tail died with it, so naming a read would send the model after nothing. */
  readonly outputReadable?: boolean;
  /** A completed question's answer. The lone exception to metadata-only; see
   *  {@link BackgroundManager.answeredQuestionOutput} for why this kind and no other. */
  readonly answer?: string;
}

/**
 * The settle notification: METADATA ONLY, with one exception.
 *
 * A terminal notice arrives unbidden. Nobody asked for it, and it lands in the recipient's
 * context whether or not the substance is wanted — so it carries what only the settle knows
 * (how it ended, the exit code, where the log lives) and stops there. The output is a
 * resource, fetched deliberately, paid for at the moment the model decides it needs it.
 * Attaching a fixed tail instead would charge every task the same bytes regardless: too few
 * to conclude anything on a long run, pure waste on one whose exit code already said it all.
 *
 * The exception is a question's answer, which is not output but conversation — the user's own
 * words, held nowhere else. It rides along in full, and the read instruction is dropped with
 * it: there is nothing left to go fetch.
 *
 * The task id is already an attribute of the enclosing `<background-task-done>` tag; it is
 * repeated in the read instruction so that line can be copied straight into a call.
 */
/** The last thing the assistant said, which is a sub-agent's answer. Mirrors `finalText` in
 *  run-support, kept local so the capability does not depend on the agent layer. */
function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    return message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function buildTerminalSummary(info: BackgroundTaskInfo, options: TerminalSummaryOptions = {}): string {
  // Exit code is a process fact; the other kinds report their outcome through `status`.
  const exit = info.kind === "process" && info.exitCode !== null ? ` (exit code ${String(info.exitCode)})` : "";
  const head =
    info.status === "timed_out"
      ? `${info.description} timed out${exit}.`
      : info.stopReason
        ? `${info.description} ${info.status === "killed" ? "was killed" : info.status}${exit}: ${info.stopReason}.`
        : `${info.description} ${info.status}${exit}.`;
  const logPath = info.outputRef?.kind === "file" ? info.outputRef.path : undefined;
  const lines = [head];
  if (logPath !== undefined) lines.push(`output_log: ${logPath}`);

  // Character-truncated, not byte-windowed: the answer is a JSON string, and slicing it at a
  // byte offset would split a multi-byte character — the very defect the byte-window readers
  // elsewhere in this file still carry.
  const answer = options.answer;
  if (answer !== undefined) {
    const truncated = answer.length > QUESTION_ANSWER_MAX_CHARS;
    lines.push(truncated ? "[answer, truncated]" : "[answer]", truncated ? answer.slice(0, QUESTION_ANSWER_MAX_CHARS) : answer);
    // Only a truncated answer leaves anything behind to fetch.
    if (truncated) lines.push(`Read the full answer with BackgroundOutput(task_id="${info.taskId}").`);
    return lines.join("\n");
  }

  if (options.outputReadable ?? true) {
    lines.push(
      logPath !== undefined
        ? `Read its output with BackgroundOutput(task_id="${info.taskId}"), or Read the log file above for the full, never-truncated record.`
        : `Read its output with BackgroundOutput(task_id="${info.taskId}").`,
    );
  }
  return lines.join("\n");
}

export { isBackgroundTaskTerminal };
