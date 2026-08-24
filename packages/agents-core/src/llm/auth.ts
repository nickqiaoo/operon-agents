import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  InMemoryCredentialStore,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
} from "@earendil-works/pi-ai";

export { InMemoryCredentialStore };
/** Backwards-compatible name for Operon callers; the implementation is pi's canonical store. */
export { InMemoryCredentialStore as MemoryCredentialStore };
export type {
  AuthInteraction,
  AuthPrompt,
  AuthResult,
  AuthType,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
  OAuthCredentials,
} from "@earendil-works/pi-ai";

type CredentialFile = Record<string, Credential>;

/**
 * Persistent pi CredentialStore. The file is a provider-id keyed object and
 * writes are atomic. Legacy Operon OAuth rows without `type` are upgraded to
 * canonical `{ type: "oauth", ... }` credentials when read.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return cloneCredential((await this.readAll())[providerId]);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.readAll()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    let resolved: Credential | undefined;
    const run = this.writeChain.then(async () => {
      const all = await this.readAll();
      const current = cloneCredential(all[providerId]);
      const next = await fn(current);
      if (next !== undefined) {
        all[providerId] = cloneCredential(next)!;
        await this.writeAll(all);
        resolved = cloneCredential(next);
      } else {
        resolved = current;
      }
    });
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => resolved);
  }

  delete(providerId: string): Promise<void> {
    const run = this.writeChain.then(async () => {
      const all = await this.readAll();
      if (!(providerId in all)) return;
      delete all[providerId];
      await this.writeAll(all);
    });
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAll(): Promise<CredentialFile> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.filePath, "utf-8")) as unknown;
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

    const credentials: CredentialFile = {};
    for (const [providerId, value] of Object.entries(raw)) {
      const credential = normalizeCredential(value);
      if (credential !== undefined) credentials[providerId] = credential;
    }
    return credentials;
  }

  private async writeAll(all: CredentialFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tmp, this.filePath);
  }
}

function normalizeCredential(value: unknown): Credential | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    return { ...candidate, type: "api_key" } as Credential;
  }
  if (
    candidate.type === "oauth" ||
    (
      typeof candidate.access === "string" &&
      typeof candidate.refresh === "string" &&
      typeof candidate.expires === "number"
    )
  ) {
    return { ...candidate, type: "oauth" } as Credential;
  }
  return undefined;
}

function cloneCredential(credential: Credential | undefined): Credential | undefined {
  return credential === undefined ? undefined : structuredClone(credential);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
