import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DurableSessionState } from "./catalog-store.ts";

export interface DiskSessionCatalogEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
  /** {@link CreateSessionInput.ownerKey}; absent on rows written before it existed. */
  readonly ownerKey?: string;
  /** Set when the session was soft-deleted; its directory is retained. */
  readonly deletedAt?: number;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly durableState: DurableSessionState;
}

export type DiskSessionCatalogRecord =
  | { readonly op: "upsert"; readonly entry: DiskSessionCatalogEntry }
  | {
      readonly op: "patch";
      readonly sessionId: string;
      readonly title?: string | null;
      readonly updatedAt?: number;
      readonly durableState?: DurableSessionState;
    }
  | { readonly op: "delete"; readonly sessionId: string };

export function sessionCatalogPath(sessionsDir: string): string {
  return join(sessionsDir, "session_catalog.jsonl");
}

export async function appendSessionCatalogRecord(
  sessionsDir: string,
  record: DiskSessionCatalogRecord,
): Promise<void> {
  const catalogPath = sessionCatalogPath(sessionsDir);
  await mkdir(dirname(catalogPath), { recursive: true, mode: 0o700 });
  await appendFile(catalogPath, `${JSON.stringify(record)}\n`, "utf-8");
}

/** Fold the append-only catalog. Last operation wins; updatedAt never moves backwards. */
export async function readSessionCatalog(sessionsDir: string): Promise<Map<string, DiskSessionCatalogEntry>> {
  let raw: string;
  try {
    raw = await readFile(sessionCatalogPath(sessionsDir), "utf-8");
  } catch {
    return new Map();
  }

  const result = new Map<string, DiskSessionCatalogEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const record = parseCatalogLine(line.trim(), sessionsDir);
    if (record === undefined) continue;
    if (record.op === "delete") {
      result.delete(record.sessionId);
      continue;
    }
    if (record.op === "upsert") {
      result.set(record.entry.sessionId, record.entry);
      continue;
    }
    const current = result.get(record.sessionId);
    if (current === undefined) continue;
    result.set(record.sessionId, {
      ...current,
      ...(record.title !== undefined ? { title: record.title ?? undefined } : {}),
      ...(record.durableState !== undefined ? { durableState: record.durableState } : {}),
      ...(record.updatedAt !== undefined
        ? { updatedAt: Math.max(current.updatedAt, record.updatedAt) }
        : {}),
    });
  }
  return result;
}

function parseCatalogLine(line: string, sessionsDir: string): DiskSessionCatalogRecord | undefined {
  if (line === "") return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || !isSafeSessionId(parsed.sessionId ?? (isRecord(parsed.entry) ? parsed.entry.sessionId : undefined))) {
      return undefined;
    }
    if (parsed.op === "delete" && typeof parsed.sessionId === "string") {
      return { op: "delete", sessionId: parsed.sessionId };
    }
    if (parsed.op === "patch" && typeof parsed.sessionId === "string") {
      const durableState = parseDurableState(parsed.durableState);
      if (parsed.durableState !== undefined && durableState === undefined) return undefined;
      return {
        op: "patch",
        sessionId: parsed.sessionId,
        ...(typeof parsed.title === "string" || parsed.title === null ? { title: parsed.title } : {}),
        ...(typeof parsed.updatedAt === "number" ? { updatedAt: parsed.updatedAt } : {}),
        ...(durableState !== undefined ? { durableState } : {}),
      };
    }
    if (parsed.op !== "upsert" || !isRecord(parsed.entry)) return undefined;
    const entry = parsed.entry;
    if (
      typeof entry.sessionId !== "string" ||
      typeof entry.sessionDir !== "string" ||
      typeof entry.workDir !== "string" ||
      typeof entry.createdAt !== "number" ||
      typeof entry.updatedAt !== "number"
    ) return undefined;
    const durableState = parseDurableState(entry.durableState);
    if (durableState === undefined) return undefined;
    const sessionDir = resolve(entry.sessionDir);
    if (!isAbsolute(entry.sessionDir) || !isAbsolute(entry.workDir)) return undefined;
    if (!isPathInside(sessionsDir, sessionDir) || basename(sessionDir) !== entry.sessionId) return undefined;
    return {
      op: "upsert",
      entry: {
        sessionId: entry.sessionId,
        sessionDir,
        workDir: resolve(entry.workDir),
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        durableState,
      },
    };
  } catch {
    return undefined;
  }
}

function parseDurableState(value: unknown): DurableSessionState | undefined {
  return value === "idle" || value === "interrupted" ? value : undefined;
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
