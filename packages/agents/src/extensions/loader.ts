import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionDefinition } from "./types.ts";

/** The slice of a session the loader swaps extensions on — `HarnessSession` satisfies it. */
export interface ExtensionAttachTarget {
  attachExtension(definition: ExtensionDefinition): Promise<void>;
  detachExtension(extensionId: string): Promise<void>;
}

/**
 * File-extension loader — the shell that turns a extension directory into extension VALUES for
 * `attachExtension`. The framework core stays file-blind: everything here ends in a plain
 * `ExtensionDefinition`, handed over the same channel host-authored extensions use.
 *
 * Layout: one folder per extension under `directory`, holding a `manifest.json` plus a bundled
 * entry file (dependencies baked in by the author at publish time — no install step here).
 *
 * Trust model — loading is consent, and consent is MANUAL:
 * - `load()` / `reload()` are explicit host actions; performing one approves the extension at
 *   its current file mtime, recorded in `.approvals.json` beside the extensions.
 * - `loadApproved()` (startup) only honors extensions whose entry is byte-for-byte the one
 *   approved (mtime match). A changed or new extension is reported, never silently loaded —
 *   an agent with write access must not be able to plant code that runs on next open.
 *
 * Reload mechanics: native `import()` with a `?v=<mtime>` suffix — a changed file gets a
 * fresh module, an unchanged one hits the cache. Old module instances stay resident until
 * process exit; that is the accepted cost of not restarting.
 */

/** This framework's version — what a manifest's `engine` is checked against. */
export const FRAMEWORK_VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semver ordering for plain `x.y.z[-pre]` strings (a prerelease sorts below its release). */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a), pb = VERSION_RE.exec(b);
  if (pa === null || pb === null) throw new Error(`not a version: ${JSON.stringify(pa === null ? a : b)}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const preA = pa[4], preB = pb[4];
  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const xs = preA.split("."), ys = preB.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i], y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    const d = nx && ny ? Number(x) - Number(y) : nx ? -1 : ny ? 1 : x.localeCompare(y);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * What must be known about an extension BEFORE its code is imported — find it (`id`), import
 * it (`entry`, gated by `engine`), show it (`version`, `name`, `description`) — and nothing more. What the
 * extension provides (`create`) and consumes (`uses`) lives on the definition it exports, the
 * same on both channels. Only `id` is validated; unknown fields pass through untouched, so a
 * manifest written for a newer loader still loads here.
 */
export interface ExtensionManifest {
  readonly id: string;
  readonly version?: string;
  /** Entry file relative to the extension folder. Default: "index.js". */
  readonly entry?: string;
  /** The lowest framework version this bundle was built for (`x.y.z[-pre]`). Checked BEFORE the
   *  import: an older host lists the extension as `error` and refuses to load it, instead of
   *  importing code written against an API it does not have. */
  readonly engine?: string;
  /** Display name for listings (falls back to `id` in UIs). */
  readonly name?: string;
  /** One line for listings. */
  readonly description?: string;
}

export type ExtensionFileState =
  /** Approved at the current mtime and produced a definition this loader holds. */
  | "loaded"
  /** Approved at the current mtime but not imported yet (call `loadApproved` or `load`). */
  | "approved"
  /** Never approved. Loads only through an explicit `load()`. */
  | "new"
  /** Approved before, but the entry file changed since. Loads only through `reload()`. */
  | "changed"
  /** Folder present but unusable (bad manifest, missing entry). */
  | "error";

export interface ExtensionFileStatus {
  readonly id: string;
  readonly dir: string;
  readonly state: ExtensionFileState;
  readonly version?: string;
  readonly engine?: string;
  readonly name?: string;
  readonly description?: string;
  readonly error?: string;
}

interface ApprovalRecord {
  readonly entry: string;
  readonly mtimeMs: number;
  readonly approvedAt: number;
}

interface ScannedExtension {
  readonly manifest: ExtensionManifest;
  readonly dir: string;
  readonly entryPath: string;
  readonly mtimeMs: number;
}

const APPROVALS_FILE = ".approvals.json";

export class ExtensionLoader {
  private readonly directory: string;
  private readonly approvalsPath: string;
  /** Live definitions by extension id — the values a host hands to `attachExtension`. */
  private readonly loaded = new Map<string, ExtensionDefinition>();

  constructor(options: { readonly directory: string }) {
    this.directory = resolve(options.directory);
    this.approvalsPath = join(this.directory, APPROVALS_FILE);
  }

  /** The parsed manifest of one extension, by id. */
  async manifest(id: string): Promise<ExtensionManifest> {
    return (await this.find(id)).manifest;
  }

  /** The folder a extension lives in — where an extension keeps its data files. */
  async manifestDir(id: string): Promise<string> {
    return (await this.find(id)).dir;
  }

  /** Every extension folder under the directory, with its trust/load state. */
  async list(): Promise<ExtensionFileStatus[]> {
    const approvals = await this.readApprovals();
    const out: ExtensionFileStatus[] = [];
    for (const entry of await this.readExtensionDirs()) {
      try {
        const scanned = await this.scan(entry);
        out.push({
          id: scanned.manifest.id,
          dir: scanned.dir,
          ...(scanned.manifest.version !== undefined ? { version: scanned.manifest.version } : {}),
          ...(scanned.manifest.engine !== undefined ? { engine: scanned.manifest.engine } : {}),
          ...(scanned.manifest.name !== undefined ? { name: scanned.manifest.name } : {}),
          ...(scanned.manifest.description !== undefined ? { description: scanned.manifest.description } : {}),
          state: this.stateOf(scanned, approvals),
        });
      } catch (error) {
        out.push({ id: entry, dir: join(this.directory, entry), state: "error", error: messageOf(error) });
      }
    }
    return out;
  }

  /**
   * Import one extension and approve it as it stands. The call itself is the consent — reserve
   * it for user-initiated actions, never for something an agent triggers on its own.
   */
  async load(id: string): Promise<ExtensionDefinition> {
    const scanned = await this.find(id);
    const definition = await this.importDefinition(scanned);
    await this.approve(scanned);
    this.loaded.set(id, definition);
    return definition;
  }

  /** Re-import after an edit and roll the approval forward to the file as it is now. */
  async reload(id: string): Promise<ExtensionDefinition> {
    return this.load(id);
  }

  /** Forget a extension: drop the held definition and revoke its approval. */
  async unload(id: string): Promise<void> {
    this.loaded.delete(id);
    const approvals = await this.readApprovals();
    if (id in approvals) {
      const { [id]: _dropped, ...rest } = approvals;
      await this.writeApprovals(rest);
    }
  }

  /**
   * Startup path: import every extension still byte-identical to what was approved. Changed and
   * new extensions are skipped and reported so the host can surface them for a manual decision.
   */
  async loadApproved(): Promise<{ loaded: ExtensionDefinition[]; skipped: ExtensionFileStatus[] }> {
    const loaded: ExtensionDefinition[] = [];
    const skipped: ExtensionFileStatus[] = [];
    for (const status of await this.list()) {
      if (status.state === "approved" || status.state === "loaded") {
        try {
          const scanned = await this.find(status.id);
          const definition = await this.importDefinition(scanned);
          this.loaded.set(status.id, definition);
          loaded.push(definition);
          continue;
        } catch (error) {
          skipped.push({ ...status, state: "error", error: messageOf(error) });
          continue;
        }
      }
      skipped.push(status);
    }
    return { loaded, skipped };
  }

  /** The definitions currently held. On the standalone-loader path these reach sessions through
   *  `attachExtension`/`reloadInto`; a harness built with `extensionDir` registers them itself
   *  (`harness.extensions.load`), which is the path that also runs `create` halves. */
  definitions(): ExtensionDefinition[] {
    return [...this.loaded.values()];
  }

  /** Convenience: reload a extension and swap it on a live session (detach old, attach new). */
  async reloadInto(session: ExtensionAttachTarget, id: string): Promise<ExtensionDefinition> {
    const definition = await this.reload(id);
    await session.detachExtension(id).catch(() => undefined);
    await session.attachExtension(definition);
    return definition;
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async readExtensionDirs(): Promise<string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => []);
    // Dot-folders are the loader's own (`.data` holds extensions' data dirs), never extensions.
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
  }

  private async scan(dirName: string): Promise<ScannedExtension> {
    const dir = join(this.directory, dirName);
    const manifestPath = join(dir, "manifest.json");
    let manifest: ExtensionManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExtensionManifest;
    } catch (error) {
      throw new Error(`unreadable manifest.json: ${messageOf(error)}`);
    }
    if (typeof manifest.id !== "string" || !manifest.id.trim()) {
      throw new Error("manifest.json must declare a non-empty string \"id\"");
    }
    if (manifest.engine !== undefined) {
      if (typeof manifest.engine !== "string" || !VERSION_RE.test(manifest.engine)) {
        throw new Error(`manifest "engine" must be a version like "1.2.0", got ${JSON.stringify(manifest.engine)}`);
      }
      if (compareVersions(FRAMEWORK_VERSION, manifest.engine) < 0) {
        throw new Error(`requires operon-agents >= ${manifest.engine}; this host runs ${FRAMEWORK_VERSION}`);
      }
    }
    const entryPath = join(dir, manifest.entry ?? "index.js");
    const stats = await stat(entryPath).catch(() => {
      throw new Error(`entry file missing: ${entryPath}`);
    });
    return { manifest, dir, entryPath, mtimeMs: stats.mtimeMs };
  }

  private async find(id: string): Promise<ScannedExtension> {
    let failure: unknown;
    for (const dirName of await this.readExtensionDirs()) {
      try {
        const scanned = await this.scan(dirName);
        if (scanned.manifest.id === id) return scanned;
      } catch (error) {
        // A broken sibling folder must not block loading the one asked for — but the folder
        // named like the id IS the one asked for, and its reason (bad manifest, missing entry,
        // an `engine` this host is too old for) is the answer, not "not found".
        if (dirName === id) failure = error;
      }
    }
    if (failure !== undefined) throw new Error(`extension "${id}": ${messageOf(failure)}`);
    throw new Error(`no extension with id "${id}" under ${this.directory}`);
  }

  private stateOf(scanned: ScannedExtension, approvals: Record<string, ApprovalRecord>): ExtensionFileState {
    const approval = approvals[scanned.manifest.id];
    if (!approval) return "new";
    if (approval.mtimeMs !== scanned.mtimeMs || approval.entry !== scanned.entryPath) return "changed";
    return this.loaded.has(scanned.manifest.id) ? "loaded" : "approved";
  }

  private async importDefinition(scanned: ScannedExtension): Promise<ExtensionDefinition> {
    // The mtime suffix makes an edited file a NEW module while an unchanged one stays cached.
    const url = `${pathToFileURL(scanned.entryPath).href}?v=${scanned.mtimeMs}`;
    let moduleExports: { default?: unknown };
    try {
      moduleExports = (await import(url)) as { default?: unknown };
    } catch (error) {
      throw new Error(`extension "${scanned.manifest.id}" failed to import: ${messageOf(error)}`);
    }
    let candidate = moduleExports.default;
    // A factory default export lets a extension construct per-load state; called with nothing —
    // everything a extension may use arrives later through its setup(ctx).
    if (typeof candidate === "function") candidate = (candidate as () => unknown)();
    if (!isExtensionDefinition(candidate)) {
      throw new Error(`extension "${scanned.manifest.id}" default export is not an extension definition ({ id, setup })`);
    }
    if (candidate.id !== scanned.manifest.id) {
      throw new Error(`extension id mismatch: manifest says "${scanned.manifest.id}", code says "${candidate.id}"`);
    }
    return candidate;
  }

  private async approve(scanned: ScannedExtension): Promise<void> {
    const approvals = await this.readApprovals();
    await this.writeApprovals({
      ...approvals,
      [scanned.manifest.id]: { entry: scanned.entryPath, mtimeMs: scanned.mtimeMs, approvedAt: Date.now() },
    });
  }

  private async readApprovals(): Promise<Record<string, ApprovalRecord>> {
    try {
      return JSON.parse(await readFile(this.approvalsPath, "utf8")) as Record<string, ApprovalRecord>;
    } catch {
      return {};
    }
  }

  private async writeApprovals(approvals: Record<string, ApprovalRecord>): Promise<void> {
    await writeFile(this.approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");
  }
}

export function createExtensionLoader(options: { readonly directory: string }): ExtensionLoader {
  return new ExtensionLoader(options);
}

function isExtensionDefinition(value: unknown): value is ExtensionDefinition {
  return (
    typeof value === "object" && value !== null
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { setup?: unknown }).setup === "function"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
