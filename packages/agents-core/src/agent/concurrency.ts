/**
 * Concurrency limiting for spawned agents.
 *
 * Shared by the `Workflow` runtime and the `Agent`/`agent_<name>` spawn tools so one deployment
 * does not end up with a bounded workflow fan-out beside an unbounded `Agent` fan-out.
 */
import { cpus } from "node:os";
import type { RunState } from "./runner.ts";

/** Concurrency limiter (semaphore). */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // The releaser hands its slot to the woken waiter without ever dropping `active`,
      // so a caller arriving between release and wake-up still sees the pool as full.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Same shape the Workflow tool uses, so both spawn paths default alike. */
export function defaultSpawnConcurrency(): number {
  return Math.min(16, Math.max(2, cpus().length - 2));
}

/**
 * One limiter per session. Keyed off the session port (not the frame) because a run's frames come
 * and go while the session is what actually owns the machine's capacity; a session holds its run
 * lock, so this bounds the whole tree beneath one prompt.
 */
const perSession = new WeakMap<object, Semaphore>();

/**
 * The limiter a spawn should queue on, or `undefined` when this spawn must NOT queue.
 *
 * Only ROOT-frame spawns are limited. A subagent that spawns its own child is deliberately let
 * through: if a frame held a permit while waiting for a child that needs one, a full pool would
 * deadlock — every holder blocked on a permit no holder will release. Bounding the root fan-out
 * is what actually matters (one assistant message asking for twenty subagents); the nested case
 * is already bounded by `maxRecursionDepth`.
 */
export function spawnLimiterFor<TContext>(state: RunState<TContext>, limit: number | undefined): Semaphore | undefined {
  if (state.parentFrameId !== undefined) return undefined;
  const max = limit ?? defaultSpawnConcurrency();
  if (max <= 0) return undefined;
  const key = state.session as unknown as object;
  let semaphore = perSession.get(key);
  if (semaphore === undefined) {
    semaphore = new Semaphore(max);
    perSession.set(key, semaphore);
  }
  return semaphore;
}
