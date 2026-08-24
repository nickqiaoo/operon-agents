import { randomBytes } from "node:crypto";
import type { CronTask } from "./types.ts";

export type SessionCronTaskInit = Omit<CronTask, "id" | "createdAt">;

const ID_REGEX = /^[0-9a-f]{8}$/;
const MAX_ID_ATTEMPTS = 8;

export class SessionCronStore {
  private readonly tasks = new Map<string, CronTask>();

  add(init: SessionCronTaskInit, nowMs: number): CronTask {
    const id = this.generateUniqueId();
    const task: CronTask = { ...init, id, createdAt: nowMs };
    this.tasks.set(id, task);
    return task;
  }

  adopt(task: CronTask): void {
    this.tasks.set(task.id, task);
  }

  markFired(id: string, lastFiredAt: number): CronTask | undefined {
    const existing = this.tasks.get(id);
    if (existing === undefined) return undefined;
    const updated: CronTask = { ...existing, lastFiredAt };
    this.tasks.set(id, updated);
    return updated;
  }

  get(id: string): CronTask | undefined {
    return this.tasks.get(id);
  }

  list(): readonly CronTask[] {
    return Array.from(this.tasks.values());
  }

  remove(ids: readonly string[]): readonly string[] {
    const removed: string[] = [];
    for (const id of ids) if (this.tasks.delete(id)) removed.push(id);
    return removed;
  }

  clear(): void {
    this.tasks.clear();
  }

  private generateUniqueId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const candidate = randomBytes(4).toString("hex");
      if (!ID_REGEX.test(candidate)) continue;
      if (!this.tasks.has(candidate)) return candidate;
    }
    throw new Error(`SessionCronStore: failed to generate a unique 8-hex id after ${MAX_ID_ATTEMPTS} attempts`);
  }
}
