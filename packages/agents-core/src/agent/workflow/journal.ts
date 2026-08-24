/**
 * Workflow journal — enables `resumeFromRunId`. Each agent() call is
 * keyed by a SHA-256 CHAIN over (previous key + prompt + stable-stringified opts),
 * rolled in execution order. Because the key is chained, changing or inserting any
 * call shifts every key after it, which (together with the runtime's `diverged`
 * latch) gives "longest-unchanged-prefix" resume: the leading run of unchanged
 * calls returns cached instantly, and everything from the first change onward
 * re-runs.
 *
 * Two entry kinds are journaled per call:
 *   - `started` is appended BEFORE the agent runs (with its agentId), so an
 *     interruption leaves a started-without-result trail the next resume detects
 *     and respawns;
 *   - `result` is appended after it completes.
 *
 * This is exactly why the sandbox forbids Date.now()/Math.random(): non-determinism
 * would change the prompts/order (and thus the keys) and defeat resume.
 *
 * Persistence is the SessionStore's append log under a per-run address
 * (`workflow:<runId>`): the journal is agent bookkeeping shaped exactly like the
 * log facet — crash-safe appends, replayed whole on load — so it never touches
 * the Machine or the host filesystem. `custom` entries are audit-only and
 * are never folded into a conversation.
 */

import { createHash } from "node:crypto";
import type { AgentRecord, SessionStore } from "../../store/index.ts";
import type { AgentHookOptions } from "./types.ts";

/**
 * What a run writes down. Two audiences read these, which is why the shape carries more than
 * resume strictly needs:
 *
 * - RESUME reads `started` / `result` by key, exactly as before.
 * - EVERYONE ELSE (the model via BackgroundOutput, a UI seeding its progress view, someone
 *   asking why a run came back empty) reads them in append order as the run's story. That
 *   audience needs the labels a human recognises, the phases the script declared, its own
 *   narration, and — most of all — the failures, which used to be emitted to a live progress
 *   stream and then forgotten.
 *
 * `run` and `outcome` bracket the sequence: the inputs the run was given, and what it
 * produced. With both present the address is self-contained — the script that ran, the args
 * it ran on, every agent result, and the payload — so a run can be replayed, inspected, or
 * served long after the process that ran it is gone.
 */
type JournalEntry = (
  | { type: "run"; runId: string; name: string; args?: unknown; scriptBody: string; parentAddress?: string }
  | { type: "phase"; index: number; title: string; kind: "normal" | "child" }
  | { type: "queued"; key: string; index: number; label: string; phase?: string }
  | { type: "started"; key: string; agentId: string; address?: string; index?: number; label?: string; phase?: string }
  | { type: "result"; key: string; agentId: string; address?: string; result?: unknown; index?: number; label?: string; phase?: string }
  | { type: "error"; key: string; agentId: string; address?: string; error: string; index?: number; label?: string; phase?: string }
  | { type: "log"; message: string }
  | {
      type: "outcome";
      status: "completed" | "failed" | "aborted";
      ok: boolean;
      result?: unknown;
      error?: string;
      failures: string[];
      agentCount: number;
    }
) & { readonly parentToolCallId?: string };

/** An entry as read back, with the append time the store stamped on its record. */
export type JournalEvent = JournalEntry & { readonly time?: number };

export interface JournalResult {
  readonly agentId: string;
  readonly address?: string;
  readonly result: unknown;
}

/** Identity of the agent() call an entry belongs to; omitted on `run`/`phase`/`log`/`outcome`. */
export interface JournalAgentLabel {
  readonly index?: number;
  readonly label?: string;
  readonly phase?: string;
  /** Conversation shard of the concrete child run, for replay-time stream correlation. */
  readonly address?: string;
}

export const JOURNAL_KEY_VERSION = "v2";

const JOURNAL_ENTRY_NAME = "wf_journal";

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The per-run log address journal entries live under. */
export function journalAddress(runId: string): string {
  return `workflow:${sanitize(runId)}`;
}

/** Stable stringify of the opts that affect an agent's result. */
function stableOpts(opts?: AgentHookOptions): string {
  if (!opts) return "{}";
  const picked: Record<string, unknown> = {};
  for (const key of ["schema", "model", "agentType", "isolation"] as const) {
    const v = opts[key];
    if (v === undefined || typeof v === "function") continue;
    picked[key] = v;
  }
  const sortDeep = (val: unknown): unknown => {
    if (Array.isArray(val)) return val.map(sortDeep);
    if (val && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        out[k] = sortDeep((val as Record<string, unknown>)[k]);
      }
      return out;
    }
    return val;
  };
  return JSON.stringify(sortDeep(picked));
}

const ENTRY_TYPES: ReadonlySet<string> = new Set(["run", "phase", "queued", "started", "result", "error", "log", "outcome"]);

/** Validate an untrusted record: older wire versions wrote only `started`/`result`, and a
 *  reader must skip anything it does not recognise rather than fail the whole load. */
function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  const type = o["type"];
  if (typeof type !== "string" || !ENTRY_TYPES.has(type)) return false;
  if (type === "started" || type === "result" || type === "error") {
    return typeof o["key"] === "string" && typeof o["agentId"] === "string";
  }
  if (type === "queued") return typeof o["key"] === "string" && typeof o["index"] === "number";
  if (type === "run") return typeof o["name"] === "string" && typeof o["scriptBody"] === "string";
  if (type === "phase") return typeof o["title"] === "string";
  if (type === "log") return typeof o["message"] === "string";
  return (
    typeof o["ok"] === "boolean" &&
    (o["status"] === "completed" || o["status"] === "failed" || o["status"] === "aborted")
  );
}

export class WorkflowJournal {
  private readonly store: SessionStore;
  private readonly address: string;
  private readonly runId: string;
  private readonly parentToolCallId?: string;
  /** key → completed result (loaded on resume). */
  private readonly results = new Map<string, JournalResult>();
  /** keys that were `started` on a prior run (used to detect interrupted agents). */
  private readonly started = new Set<string>();
  /** Every entry in append order — the run's story, for readers that want it whole. */
  private readonly events: JournalEvent[] = [];

  constructor(runId: string, store: SessionStore, parentToolCallId?: string) {
    this.store = store;
    this.runId = runId;
    this.parentToolCallId = parentToolCallId;
    this.address = journalAddress(runId);
  }

  /** Chained key for an agent() call: hash(prevKey + prompt + opts). */
  keyFor(prevKey: string, prompt: string, opts: AgentHookOptions | undefined): string {
    const hash = createHash("sha256")
      .update(prevKey)
      .update("\0")
      .update(prompt)
      .update("\0")
      .update(stableOpts(opts))
      .digest("hex");
    return `${JOURNAL_KEY_VERSION}:${hash}`;
  }

  /** Load prior records (no-op for a fresh run). */
  async load(): Promise<void> {
    try {
      for await (const stored of this.store.readRecords({ address: this.address })) {
        if (stored.type !== "custom" || stored.name !== JOURNAL_ENTRY_NAME) continue;
        const entry = stored.data;
        if (!isJournalEntry(entry)) continue;
        this.events.push(stored.time === undefined ? entry : { ...entry, time: stored.time });
        if (entry.type === "started") this.started.add(entry.key);
        else if (entry.type === "result") {
          this.results.set(entry.key, {
            agentId: entry.agentId,
            ...(entry.address !== undefined ? { address: entry.address } : {}),
            result: entry.result,
          });
        }
      }
    } catch {
      return;
    }
  }

  /** A completed result for this key, or undefined (never ran, or interrupted). */
  getResult(key: string): JournalResult | undefined {
    return this.results.get(key);
  }

  /** Whether this key was `started` on a prior run (interrupted if also no result). */
  wasStarted(key: string): boolean {
    return this.started.has(key);
  }

  /** Every entry in append order, including any loaded from a prior process. */
  readEvents(): readonly JournalEvent[] {
    return this.events;
  }

  /** The exact source this run was launched with (meta block included), when recorded. */
  recordedScript(): string | undefined {
    for (const event of this.events) if (event.type === "run") return event.scriptBody;
    return undefined;
  }

  /** The run's own outcome, once written. */
  outcome(): Extract<JournalEvent, { type: "outcome" }> | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event?.type === "outcome") return event;
    }
    return undefined;
  }

  /**
   * The inputs, written before anything runs. `scriptBody` here is the SOURCE as given — meta
   * block included — because a resume re-parses it, and `parseWorkflow` strips that block off.
   *
   * Carries the script in full rather than a path:
   * a path points at the machine, which is a cache — the file can be edited, overwritten by
   * the next run of the same workflow, or vanish with a sandbox. Replay needs the exact bytes
   * that produced these keys, so the record holds them.
   */
  async recordRun(
    name: string,
    scriptBody: string,
    args: unknown,
    origin?: { readonly parentAddress: string; readonly parentToolCallId: string },
  ): Promise<void> {
    await this.append({
      type: "run",
      runId: this.runId,
      name,
      scriptBody,
      ...(args === undefined ? {} : { args }),
      ...origin,
    }).catch(() => {});
  }

  async recordPhase(index: number, title: string, kind: "normal" | "child"): Promise<void> {
    await this.append({ type: "phase", index, title, kind }).catch(() => {});
  }

  async recordQueued(key: string, label: JournalAgentLabel & { readonly index: number; readonly label: string }): Promise<void> {
    await this.append({ type: "queued", key, ...label }).catch(() => {});
  }

  async recordStarted(key: string, agentId: string, label: JournalAgentLabel = {}): Promise<void> {
    this.started.add(key);
    await this.append({ type: "started", key, agentId, ...label }).catch(() => {});
  }

  async recordResult(key: string, agentId: string, result: unknown, label: JournalAgentLabel = {}): Promise<void> {
    this.results.set(key, { agentId, ...(label.address !== undefined ? { address: label.address } : {}), result });
    await this.append({ type: "result", key, agentId, result, ...label });
  }

  /** A failed agent. Never recorded before, so a failed run left no trace of WHICH step broke
   *  — the one question anyone asks of a run that came back empty. */
  async recordError(key: string, agentId: string, error: string, label: JournalAgentLabel = {}): Promise<void> {
    await this.append({ type: "error", key, agentId, error, ...label }).catch(() => {});
  }

  /** The script's own narration (`log()`), which exists nowhere else. */
  async recordLog(message: string): Promise<void> {
    await this.append({ type: "log", message }).catch(() => {});
  }

  async recordOutcome(entry: Omit<Extract<JournalEntry, { type: "outcome" }>, "type">): Promise<void> {
    await this.append({ type: "outcome", ...entry }).catch(() => {});
  }

  private async append(entry: JournalEntry): Promise<void> {
    const identified: JournalEntry = this.parentToolCallId === undefined || entry.parentToolCallId !== undefined
      ? entry
      : { ...entry, parentToolCallId: this.parentToolCallId };
    this.events.push(identified);
    const record: AgentRecord = {
      address: this.address,
      type: "custom",
      name: JOURNAL_ENTRY_NAME,
      data: identified,
    };
    await this.store.appendRecord(record);
  }
}
