import type { CronTask } from "./types.ts";

export const CRON_ID_REGEX = /^[0-9a-f]{8}$/;

/** The whole cron registry lives under one state key (bounded by MAX_CRON_JOBS_PER_SESSION). */
const CRON_STATE_KEY = "cron";

export function isValidCronTask(obj: unknown): obj is CronTask {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o["id"] !== "string" || !CRON_ID_REGEX.test(o["id"])) return false;
  if (typeof o["cron"] !== "string") return false;
  if (typeof o["prompt"] !== "string") return false;
  if (typeof o["createdAt"] !== "number") return false;
  if (o["recurring"] !== undefined && typeof o["recurring"] !== "boolean") return false;
  if (o["lastFiredAt"] !== undefined && (typeof o["lastFiredAt"] !== "number" || !Number.isFinite(o["lastFiredAt"]))) return false;
  return true;
}

/** Where the registry snapshot lives. The extension supplies this over `api.state` (the
 *  per-extension SessionStore KV) — one key, written whole, single writer (the session loop). */
export interface CronPersistence {
  load(): Promise<CronTask[]>;
  save(tasks: readonly CronTask[]): Promise<void>;
}
