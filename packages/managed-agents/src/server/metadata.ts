import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRef, EnvironmentRef } from "../protocol/types.ts";

export interface ManagedSessionMetadata {
  readonly version: 1;
  readonly sessionId: string;
  readonly agent: AgentRef;
  readonly environment: EnvironmentRef;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ManagedSessionMetadataStore {
  get(sessionId: string): Promise<ManagedSessionMetadata | undefined>;
  getMany(sessionIds: readonly string[]): Promise<ReadonlyMap<string, ManagedSessionMetadata>>;
  /** Atomically claim a new managed id. False means another creator already owns it. */
  create(metadata: ManagedSessionMetadata): Promise<boolean>;
  delete(sessionId: string): Promise<void>;
}

export class MemoryManagedSessionMetadataStore implements ManagedSessionMetadataStore {
  private readonly values = new Map<string, ManagedSessionMetadata>();

  async get(sessionId: string): Promise<ManagedSessionMetadata | undefined> {
    return this.values.get(sessionId);
  }

  async getMany(sessionIds: readonly string[]): Promise<ReadonlyMap<string, ManagedSessionMetadata>> {
    return new Map(sessionIds.flatMap((id) => {
      const value = this.values.get(id);
      return value === undefined ? [] : [[id, value] as const];
    }));
  }

  async create(metadata: ManagedSessionMetadata): Promise<boolean> {
    if (this.values.has(metadata.sessionId)) return false;
    this.values.set(metadata.sessionId, metadata);
    return true;
  }

  async delete(sessionId: string): Promise<void> {
    this.values.delete(sessionId);
  }
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** Durable default for one-process deployments. Distributed hosts can implement the same
 *  interface on their database without changing SessionHost. */
export class DiskManagedSessionMetadataStore implements ManagedSessionMetadataStore {
  private readonly directory: string;
  private all?: Promise<Map<string, ManagedSessionMetadata>>;

  constructor(directory: string) {
    this.directory = directory;
  }

  async get(sessionId: string): Promise<ManagedSessionMetadata | undefined> {
    if (this.all !== undefined) return (await this.all).get(sessionId);
    try {
      return JSON.parse(await readFile(this.path(sessionId), "utf8")) as ManagedSessionMetadata;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async getMany(sessionIds: readonly string[]): Promise<ReadonlyMap<string, ManagedSessionMetadata>> {
    const all = await (this.all ??= this.loadAll());
    return new Map(sessionIds.flatMap((id) => {
      const value = all.get(id);
      return value === undefined ? [] : [[id, value] as const];
    }));
  }

  async create(metadata: ManagedSessionMetadata): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(this.path(metadata.sessionId), `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (this.all !== undefined) (await this.all).set(metadata.sessionId, metadata);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return false;
      throw error;
    }
  }

  async delete(sessionId: string): Promise<void> {
    await rm(this.path(sessionId), { force: true });
    if (this.all !== undefined) (await this.all).delete(sessionId);
  }

  private async loadAll(): Promise<Map<string, ManagedSessionMetadata>> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return new Map();
      throw error;
    }
    const entries = await Promise.all(names
      .filter((name) => name.endsWith(".json"))
      .map(async (name): Promise<readonly [string, ManagedSessionMetadata] | undefined> => {
        try {
          const value = JSON.parse(await readFile(join(this.directory, name), "utf8")) as ManagedSessionMetadata;
          return value.sessionId === name.slice(0, -5) ? [value.sessionId, value] : undefined;
        } catch {
          return undefined;
        }
      }));
    return new Map(entries.filter((entry): entry is readonly [string, ManagedSessionMetadata] => entry !== undefined));
  }

  private path(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`invalid session id "${sessionId}"`);
    return join(this.directory, `${sessionId}.json`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
