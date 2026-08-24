import { SYSTEM_CLOCKS, type ClockSources } from "./clock.ts";
import type { JitterConfig } from "./jitter.ts";
import type { CronPersistence } from "./persist.ts";
import { SessionCronStore, type SessionCronTaskInit } from "./session-store.ts";
import { createCronScheduler, type CronScheduler } from "./scheduler.ts";
import type { CronTask } from "./types.ts";

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface CronManagerOptions {
  readonly clocks?: ClockSources;
  readonly pollIntervalMs?: number | null;
  readonly jitter?: JitterConfig;
  readonly noStale?: boolean;
  readonly isKilled?: () => boolean;
}

/**
 * What the manager needs from its host, narrowed so both worlds can supply it: the cron
 * EXTENSION wires these to `api.actions.steer` / `api.emitEvent` / `api.state`, and a test
 * can hand in stubs. The manager never sees a steer bus, an event sink or a store.
 */
export interface CronManagerRuntime {
  /** Deliver a fired task's prompt. `metadata` becomes the `<extension-message>` attributes.
   *  Returns whether the message was buffered (no run woke for it), or undefined if delivery
   *  was impossible. */
  readonly steer?: (prompt: string, metadata: Readonly<Record<string, string | number | boolean>>) => { readonly buffered: boolean } | undefined;
  /** Ephemeral stream signal (e.g. "cron.fired"). */
  readonly emit?: (name: string, data: Record<string, unknown>) => void;
  /** Whether the session currently has no run in flight (scheduler poll gating). */
  readonly isIdle?: () => boolean;
  readonly persistence?: CronPersistence;
}

export class CronManager {
  readonly store: SessionCronStore;
  readonly clocks: ClockSources;

  private readonly scheduler: CronScheduler;
  private readonly noStale: boolean;
  private started = false;

  private runtime: CronManagerRuntime = {};
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: CronManagerOptions = {}) {
    this.store = new SessionCronStore();
    this.clocks = options.clocks ?? SYSTEM_CLOCKS;
    this.noStale = options.noStale ?? false;
    this.scheduler = createCronScheduler({
      clocks: this.clocks,
      source: () => this.store.list(),
      isIdle: () => this.runtime.isIdle?.() ?? true,
      ...(options.isKilled !== undefined ? { isKilled: options.isKilled } : {}),
      onFire: (task, ctx) => this.handleFire(task, ctx),
      removeOneShot: (id) => {
        this.removeTasks([id]);
      },
      onAdvanceCursor: (id, lastFiredAt) => this.advanceCursor(id, lastFiredAt),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.jitter !== undefined ? { jitter: options.jitter } : {}),
    });
  }

  attach(runtime: CronManagerRuntime): void {
    this.runtime = runtime;
  }

  addTask(init: SessionCronTaskInit): CronTask {
    const task = this.store.add(init, this.clocks.wallNow());
    this.persistSnapshot();
    return task;
  }

  removeTasks(ids: readonly string[]): readonly string[] {
    const removed = this.store.remove(ids);
    if (removed.length > 0) this.persistSnapshot();
    return removed;
  }

  private advanceCursor(id: string, lastFiredAt: number): void {
    const updated = this.store.markFired(id, lastFiredAt);
    if (updated === undefined) return;
    this.persistSnapshot();
  }

  async loadPersisted(): Promise<void> {
    if (this.runtime.persistence === undefined) return;
    const tasks = await this.runtime.persistence.load();
    this.store.clear();
    for (const task of tasks) this.store.adopt(task);
  }

  // The registry is one state value written whole, so every mutation enqueues a save of the
  // list as of that mutation; the chain serializes writes and the last one wins.
  private persistSnapshot(): void {
    const persistence = this.runtime.persistence;
    if (persistence === undefined) return;
    const tasks = [...this.store.list()];
    this.persistQueue = this.persistQueue.catch(() => {}).then(() => persistence.save(tasks)).catch(() => {});
  }

  async flushPersist(): Promise<void> {
    await this.persistQueue.catch(() => {});
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
    await this.flushPersist();
    this.started = false;
  }

  tick(): void {
    this.scheduler.tick();
  }

  getNextFireTime(): number | null {
    return this.scheduler.getNextFireTime();
  }

  getNextFireForTask(taskId: string): number | null {
    return this.scheduler.getNextFireForTask(taskId);
  }

  isStale(task: CronTask): boolean {
    if (this.noStale) return false;
    if (task.recurring === false) return false;
    const age = this.clocks.wallNow() - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }

  private handleFire(task: CronTask, ctx: { readonly coalescedCount: number }): void {
    const stale = this.isStale(task);
    const recurring = task.recurring !== false;
    const receipt = this.runtime.steer?.(task.prompt, {
      jobId: task.id,
      cron: task.cron,
      recurring,
      coalescedCount: ctx.coalescedCount,
      stale,
    });
    this.runtime.emit?.("cron.fired", {
      jobId: task.id,
      cron: task.cron,
      recurring,
      coalescedCount: ctx.coalescedCount,
      stale,
      prompt: task.prompt,
      buffered: receipt === undefined || receipt.buffered,
    });

    // 7-day auto-expire: a stale recurring task gets one final delivery (above) then drops.
    if (stale && recurring) this.removeTasks([task.id]);
  }
}
