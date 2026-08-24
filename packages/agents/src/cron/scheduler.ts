import type { ParsedCronExpression } from "./cron-expr.ts";
import { computeNextCronRun, parseCronExpression } from "./cron-expr.ts";
import type { ClockSources } from "./clock.ts";
import { DEFAULT_CRON_JITTER_CONFIG, jitteredNextCronRunMs, oneShotJitteredNextCronRunMs, type JitterConfig } from "./jitter.ts";
import type { CronTask } from "./types.ts";

export interface CronSchedulerOptions {
  readonly clocks: ClockSources;
  readonly source: () => readonly CronTask[];
  readonly onFire: (task: CronTask, ctx: { readonly coalescedCount: number }) => void;
  readonly isIdle: () => boolean;
  readonly isKilled?: () => boolean;
  readonly removeOneShot?: (id: string) => void;
  readonly onAdvanceCursor?: (taskId: string, lastFiredAt: number) => void;
  readonly pollIntervalMs?: number | null;
  readonly jitter?: JitterConfig;
}

export interface CronScheduler {
  start(): void;
  stop(): Promise<void>;
  tick(): void;
  getNextFireTime(): number | null;
  getNextFireForTask(taskId: string): number | null;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_COALESCE_ITERATIONS = 10_000;

export function createCronScheduler(opts: CronSchedulerOptions): CronScheduler {
  const { clocks, source, onFire, isIdle, isKilled, removeOneShot, onAdvanceCursor, pollIntervalMs } = opts;
  const jitter = opts.jitter ?? DEFAULT_CRON_JITTER_CONFIG;

  const parsedCache = new Map<string, ParsedCronExpression>();
  const lastSeenAt = new Map<string, number>();
  const seededFromDisk = new Set<string>();
  const inFlight = new Set<string>();
  let timerHandle: ReturnType<typeof setInterval> | null = null;

  function getParsed(expr: string): ParsedCronExpression {
    const cached = parsedCache.get(expr);
    if (cached !== undefined) return cached;
    const parsed = parseCronExpression(expr);
    parsedCache.set(expr, parsed);
    return parsed;
  }

  function debugLog(message: string): void {
    if (process.env["AGENTS_CRON_DEBUG"] === "1") process.stderr.write(`[cron/scheduler] ${message}\n`);
  }

  function computeJitteredNext(task: CronTask, parsed: ParsedCronExpression, baseMs: number): number | null {
    const ideal = computeNextCronRun(parsed, baseMs);
    if (ideal === null) return null;
    if (task.recurring === false) return oneShotJitteredNextCronRunMs(task, ideal, jitter);
    return jitteredNextCronRunMs(task, parsed, ideal, jitter);
  }

  function countCoalesced(
    task: CronTask,
    parsed: ParsedCronExpression,
    firstFireMs: number,
    nowMs: number,
  ): { count: number; lastDueMs: number } {
    let count = 1;
    let cursor = firstFireMs;
    let lastDueMs = firstFireMs;
    while (count < MAX_COALESCE_ITERATIONS) {
      const next = computeNextCronRun(parsed, cursor);
      if (next === null) break;
      if (next > nowMs) break;
      const jitteredNext =
        task.recurring === false ? oneShotJitteredNextCronRunMs(task, next, jitter) : jitteredNextCronRunMs(task, parsed, next, jitter);
      if (jitteredNext > nowMs) break;
      count++;
      cursor = next;
      lastDueMs = next;
    }
    return { count, lastDueMs };
  }

  function tick(): void {
    if (isKilled?.() === true) return;
    if (!isIdle()) return;

    const tasks = source();
    if (tasks.length === 0) return;

    const now = clocks.wallNow();
    try {
      for (const task of tasks) {
        try {
          if (inFlight.has(task.id)) continue;
          const parsed = getParsed(task.cron);

          // Seed `lastSeenAt` from persisted `lastFiredAt` once per task (resume no-replay).
          if (
            !seededFromDisk.has(task.id) &&
            task.lastFiredAt !== undefined &&
            Number.isFinite(task.lastFiredAt) &&
            task.lastFiredAt <= now &&
            !lastSeenAt.has(task.id)
          ) {
            lastSeenAt.set(task.id, task.lastFiredAt);
          }
          seededFromDisk.add(task.id);

          const seen = lastSeenAt.get(task.id);
          const baseFromMs = seen !== undefined && seen > task.createdAt ? seen : task.createdAt;

          const nextFireAt = computeJitteredNext(task, parsed, baseFromMs);
          if (nextFireAt === null) continue;
          if (now < nextFireAt) continue;

          const ideal = computeNextCronRun(parsed, baseFromMs);
          let coalescedCount = 1;
          let lastDueMs: number | null = null;
          if (task.recurring !== false && ideal !== null) {
            const result = countCoalesced(task, parsed, ideal, now);
            coalescedCount = Math.max(1, result.count);
            lastDueMs = result.lastDueMs;
          }

          inFlight.add(task.id);
          let delivered = false;
          try {
            onFire(task, { coalescedCount });
            delivered = true;
          } catch (error) {
            debugLog(`onFire threw for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (!delivered) continue;

          if (task.recurring === false) {
            try {
              removeOneShot?.(task.id);
            } catch (error) {
              debugLog(`removeOneShot threw for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
            lastSeenAt.delete(task.id);
            seededFromDisk.delete(task.id);
          } else {
            const advancedTo = lastDueMs ?? now;
            lastSeenAt.set(task.id, advancedTo);
            try {
              onAdvanceCursor?.(task.id, advancedTo);
            } catch (error) {
              debugLog(`onAdvanceCursor threw for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          debugLog(`tick failed for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      inFlight.clear();
    }
  }

  function start(): void {
    if (timerHandle !== null) return;
    const interval = pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : pollIntervalMs;
    if (interval === null || interval === 0) return; // no automatic polling
    const handle = setInterval(tick, interval);
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      (handle as { unref: () => void }).unref();
    }
    timerHandle = handle;
  }

  async function stop(): Promise<void> {
    if (timerHandle !== null) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    inFlight.clear();
    lastSeenAt.clear();
    seededFromDisk.clear();
    parsedCache.clear();
  }

  function nextFireFor(task: CronTask): number | null {
    try {
      const parsed = getParsed(task.cron);
      const seen = lastSeenAt.get(task.id);
      const persistedCursor =
        task.lastFiredAt !== undefined && Number.isFinite(task.lastFiredAt) && task.lastFiredAt <= clocks.wallNow()
          ? task.lastFiredAt
          : undefined;
      const cursor = seen !== undefined ? seen : persistedCursor;
      const baseFromMs = cursor !== undefined && cursor > task.createdAt ? cursor : task.createdAt;
      return computeJitteredNext(task, parsed, baseFromMs);
    } catch (error) {
      debugLog(`getNextFireFor skipping task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function getNextFireTime(): number | null {
    const tasks = source();
    if (tasks.length === 0) return null;
    let min: number | null = null;
    for (const task of tasks) {
      const next = nextFireFor(task);
      if (next === null) continue;
      if (min === null || next < min) min = next;
    }
    return min;
  }

  function getNextFireForTask(taskId: string): number | null {
    const task = source().find((t) => t.id === taskId);
    if (task === undefined) return null;
    return nextFireFor(task);
  }

  return { start, stop, tick, getNextFireTime, getNextFireForTask };
}
