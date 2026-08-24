import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { operonHomeDir } from "../../home.ts";

export function frameworkHomeDir(): string {
  return operonHomeDir();
}

export function mcpCredentialsDir(homeDir: string): string {
  return join(homeDir, "credentials", "mcp");
}

export function defaultMcpCredentialsDir(): string {
  return mcpCredentialsDir(frameworkHomeDir());
}

export function sanitizeStoreKey(name: string): string {
  // Strip path-traversal segments. Tokens land under `<key>-<suffix>.json`, so the sanitized
  // value must also be a single filename component.
  const safe = basename(name).replaceAll(/[^a-zA-Z0-9_-]/g, "_").replaceAll(/_+/g, "_");
  if (safe.length === 0 || safe.startsWith(".")) {
    throw new Error(`Invalid MCP OAuth store key: "${name}"`);
  }
  return safe;
}

export function canonicalMcpOAuthResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = "";
  return url.toString();
}

export function mcpOAuthStoreKey(serverName: string, serverUrl: string | URL): string {
  const safeName = sanitizeStoreKey(serverName);
  const resource = canonicalMcpOAuthResource(serverUrl);
  const digest = createHash("sha256")
    .update(serverName)
    .update("\0")
    .update(resource)
    .digest("hex")
    .slice(0, 24);
  return `${safeName}-${digest}`;
}

/**
 * Where MCP OAuth credentials (client info / tokens / discovery) are persisted, keyed by a
 * filename-shaped string. The MCP SDK calls `tokens()` synchronously, so this contract is sync
 * — a network-backed backend must front an in-memory copy hydrated at session open (see
 * `MemoryMcpCredentialStore`) rather than implement it directly. Mirrors `llm/auth`'s
 * `CredentialStore` (that one is async because the model auth path is): same idea, credentials
 * are a swappable backend, not hardwired to the local filesystem.
 */
export interface McpCredentialStore {
  read<T>(file: string): T | undefined;
  write(file: string, data: unknown): void;
  remove(file: string): void;
}

/** In-memory `McpCredentialStore` — the injectable backend for deployments with no local disk
 *  (server hydrates it from external storage at session open, flushes on write). */
export class MemoryMcpCredentialStore implements McpCredentialStore {
  private readonly entries = new Map<string, unknown>();

  read<T>(file: string): T | undefined {
    const value = this.entries.get(file);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  write(file: string, data: unknown): void {
    this.entries.set(file, structuredClone(data));
  }
  remove(file: string): void {
    this.entries.delete(file);
  }
  /** Snapshot for dehydration to external storage. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.entries);
  }
  /** Rehydrate from a snapshot (server seeds this at session open). */
  static from(snapshot: Record<string, unknown>): MemoryMcpCredentialStore {
    const store = new MemoryMcpCredentialStore();
    for (const [file, data] of Object.entries(snapshot)) store.entries.set(file, data);
    return store;
  }
}

/** Local default `McpCredentialStore`: one JSON file per key under `<home>/credentials/mcp`, 0600. */
export class JsonFileStore implements McpCredentialStore {
  private readonly dir: string;

  constructor(dir: string = defaultMcpCredentialsDir()) {
    this.dir = dir;
  }

  read<T>(file: string): T | undefined {
    const path = join(this.dir, file);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  write(file: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best-effort; Windows / read-only FS may refuse
    }
    const target = join(this.dir, file);
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    const buf = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf-8");
    const fd = openSync(tmp, "w", 0o600);
    try {
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  remove(file: string): void {
    try {
      unlinkSync(join(this.dir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
