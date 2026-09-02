/**
 * The file-extension manager (design: docs/architecture.md §5.4-5.5). An extension
 * is a FILE whose default export is an `ExtensionDefinition`; the manager runs its `create` half
 * once if it has one, registers the result as a service under the extension's `id`, and hands
 * the SAME definition to every session (its `setup` is the per-session half). One extension,
 * one approval, one reload — the manager turns a reload into the coordinated act: barrier →
 * swap the session half → replace the service → release.
 *
 * Trust: the code runs at HOST trust and holds `createSession`. The control point is the same
 * single one as for ordinary extensions — manual load/reload IS the approval (mtime-scoped).
 * Nothing here auto-loads or watches.
 *
 * `stageDefinition` — running `create` against a staging host and collecting the one service, so a
 * throwing `create` publishes nothing — is shared with the harness's by-value channel
 * (`createHarness({ extensions })` runs a `create`-bearing definition through it with no loader).
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionDefinition, ExtensionHostContext } from "./types.ts";
import { ExtensionLoader, type ExtensionFileStatus } from "./loader.ts";
import { ServiceRegistry, type ServiceOptions } from "./services.ts";

/** The session surface the barrier hands to a swap function. */
export interface HeldSession {
  readonly id: string;
  attachExtension(definition: ExtensionDefinition): Promise<void>;
  detachExtension(extensionId: string): Promise<void>;
  attachedExtensionIds(): readonly string[];
  attachedExtensions(): readonly { readonly id: string; readonly uses: readonly string[] }[];
}

/** The narrow harness face the manager operates through (no import cycle with harness.ts). */
export interface ExtensionHostBridge {
  readonly services: ServiceRegistry;
  createSession(options?: Record<string, unknown>): Promise<{ readonly id: string }>;
  sessions(): readonly HeldSession[];
  /** Rendezvous every session holding one of `extensionIds` at its run boundary, run `fn` in
   *  the quiet moment (held() reads live — sessions born gated during the barrier appear). */
  withBarrier(extensionIds: readonly string[], timeoutMs: number, fn: (held: () => readonly HeldSession[]) => Promise<void>): Promise<void>;
  warn(message: string): void;
}

interface LoadedRecord {
  /** Whether this extension's `create` published a service under its id. */
  readonly hasService: boolean;
}

/** What staging one `create`-bearing definition produced, before anything is published. */
export interface StagedDefinition {
  /** The one service `create` returned, to register under the extension's id; absent when the
   *  definition has no `create`. */
  readonly service?: { readonly name: string; readonly instance: unknown; readonly options: ServiceOptions };
  /** The definition itself — its `setup` is the per-session half, mounted into every session. */
  readonly sessionDef: ExtensionDefinition;
}

export interface StagingOptions {
  /** What the registered service's `replaceable` defaults to. File extensions default to true
   *  (reload is their point); by-value ones to false (a change is a restart). */
  readonly defaultReplaceable: boolean;
  readonly dir?: string;
  /** The extension's data folder, already created. */
  readonly dataDir?: string;
  createSession: ExtensionHostContext["createSession"];
  /** Resolve one of the definition's `uses` names to its service handle. */
  service(name: string): unknown;
  warn(message: string): void;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Run a `create`-bearing definition's `create` half against a staging host and collect the one
 * service it returns — nothing is registered here, so a throwing `create` publishes nothing.
 * Shared by the file manager and the harness's by-value channel. Stays synchronous when `create`
 * is, which the by-value channel relies on to have a synchronous extension's service visible the
 * moment `createHarness` returns.
 */
export function stageDefinition(
  definition: ExtensionDefinition,
  options: StagingOptions,
): StagedDefinition | Promise<StagedDefinition> {
  if (definition.create === undefined) return { sessionDef: definition };
  const host: ExtensionHostContext = {
    createSession: (sessionOptions) => options.createSession(sessionOptions),
    services: Object.freeze(Object.fromEntries((definition.uses ?? []).map((name) => [name, options.service(name)]))),
    ...(options.dir !== undefined ? { dir: options.dir } : {}),
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    warn: (message) => options.warn(`[extension ${definition.id}] ${message}`),
  };
  const finish = (instance: unknown): StagedDefinition => ({
    service: { name: definition.id, instance, options: { replaceable: options.defaultReplaceable } },
    sessionDef: definition,
  });
  const result = definition.create(host);
  return isPromiseLike(result) ? Promise.resolve(result).then(finish) : finish(result);
}

const DEFAULT_BARRIER_TIMEOUT_MS = 30_000;

export class HarnessExtensionManager {
  private readonly loader: ExtensionLoader;
  private readonly bridge: ExtensionHostBridge;
  /** Root of the extensions' data folders (`<root>/<id>`) — outside every code folder. */
  private readonly dataRoot: string;
  /** Every loaded extension by id, and whether its `create` published a service. */
  private readonly loaded = new Map<string, LoadedRecord>();
  /** Definitions newborn sessions receive: every loaded extension's per-session half. */
  private readonly sessionDefs = new Map<string, ExtensionDefinition>();

  constructor(options: { readonly directory: string; readonly dataDir: string; readonly bridge: ExtensionHostBridge }) {
    this.loader = new ExtensionLoader({ directory: options.directory });
    this.dataRoot = resolve(options.dataDir);
    this.bridge = options.bridge;
  }

  list(): Promise<ExtensionFileStatus[]> {
    return this.loader.list();
  }

  /** What every new session is born with. Wire into the harness's extension evaluation. */
  sessionDefinitions(): ExtensionDefinition[] {
    return [...this.sessionDefs.values()];
  }

  /**
   * Load (and approve) one extension — a USER action, like `ExtensionLoader.load`. Runs the
   * definition's `create` (if any) and publishes the result as its service, then hands the
   * definition to future sessions. Loading an already-loaded extension reloads it: every
   * session holding it meets at its run boundary, the per-session half is swapped (and the
   * service replaced), and everyone resumes — the same act whether or not there is a `create`.
   */
  async load(id: string, options: { readonly timeoutMs?: number } = {}): Promise<void> {
    const definition = await this.loader.load(id);
    // `uses` lives on the definition, so it is readable only after the import; a missing
    // provider revokes the approval the import just recorded, so a failed load leaves nothing
    // behind. Same rule for both kinds: load providers first.
    for (const name of definition.uses ?? []) {
      if (!this.bridge.services.has(name)) {
        await this.loader.unload(id);
        throw new Error(`extension "${id}" uses service "${name}", which is not registered — load the extension that provides it first`);
      }
    }
    await this.register(id, definition, options);
  }

  /** Alias of `load` — the manager's load already swaps a live extension coordinated. */
  reload(id: string, options: { readonly timeoutMs?: number } = {}): Promise<void> {
    return this.load(id, options);
  }

  /**
   * Unload an extension. A `create`-bearing one is refused while any session still runs an
   * extension that `uses` its service — named, so the caller knows what to detach. Its own
   * per-session half does not block (it is removed as part of the unload).
   */
  async unload(id: string): Promise<void> {
    const record = this.loaded.get(id);
    if (record === undefined) {
      // Never loaded: just revoke whatever approval is on file.
      await this.loader.unload(id);
      return;
    }
    const consumers = this.consumersOf(id);
    if (consumers.length > 0) {
      throw new Error(
        `cannot unload extension "${id}": service still consumed by ${consumers.join(", ")} — detach those first`,
      );
    }
    // Own per-session half: detach everywhere (each session applies it at its own boundary — a
    // pure removal needs no barrier; there is no two-version coexistence to prevent).
    for (const session of this.bridge.sessions()) {
      if (session.attachedExtensionIds().includes(id)) await session.detachExtension(id);
    }
    this.sessionDefs.delete(id);
    if (record.hasService) await this.bridge.services.unregister(id);
    this.loaded.delete(id);
    await this.loader.unload(id);
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async register(id: string, definition: ExtensionDefinition, options: { readonly timeoutMs?: number }): Promise<void> {
    const staged = await this.stage(definition);
    const previous = this.loaded.get(id);
    if (previous === undefined) {
      // First load: register the service, then hand the session half to future sessions.
      // Already-open sessions are not touched (a reload only re-attaches to sessions that hold
      // the half) — attach it explicitly where an open session should get it.
      if (staged.service !== undefined) {
        this.bridge.services.register(staged.service.name, staged.service.instance, staged.service.options);
      }
      this.sessionDefs.set(id, staged.sessionDef);
      this.loaded.set(id, { hasService: staged.service !== undefined });
      return;
    }
    // Reload: one coordinated act — barrier on the session half, swap half + service in the
    // quiet moment. Version skew between the two halves is structurally impossible.
    await this.bridge.withBarrier([id], options.timeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS, async (held) => {
      for (const session of held()) {
        if (session.attachedExtensionIds().includes(id)) await session.detachExtension(id);
      }
      if (staged.service !== undefined) {
        if (this.bridge.services.has(id)) await this.bridge.services.replace(id, staged.service.instance);
        else this.bridge.services.register(staged.service.name, staged.service.instance, staged.service.options);
      } else if (previous.hasService) {
        await this.bridge.services.unregister(id);
      }
      this.sessionDefs.set(id, staged.sessionDef);
      for (const session of held()) {
        await session.attachExtension(staged.sessionDef);
      }
    });
    this.loaded.set(id, { hasService: staged.service !== undefined });
  }

  /** Run `create` with a staging host: the service is COLLECTED, not registered, so a throwing
   *  `create` publishes nothing. Services default to replaceable — reload is their point. */
  private async stage(definition: ExtensionDefinition): Promise<StagedDefinition> {
    // The data folder exists before `create` runs, so the extension can use it right away.
    const dataDir = join(this.dataRoot, definition.id);
    if (definition.create !== undefined) await mkdir(dataDir, { recursive: true });
    return stageDefinition(definition, {
      defaultReplaceable: true,
      dir: await this.loader.manifestDir(definition.id),
      dataDir,
      createSession: (sessionOptions) => this.bridge.createSession(sessionOptions as Record<string, unknown>),
      service: (name) => this.bridge.services.handle(name),
      warn: (message) => this.bridge.warn(message),
    });
  }

  /** Sessions still running an extension that `uses` `id`'s service — read off the attached
   *  definitions themselves, so by-value and file consumers count alike. No graph walk: the
   *  graph is depth 1. */
  private consumersOf(id: string): string[] {
    const found: string[] = [];
    for (const session of this.bridge.sessions()) {
      for (const attached of session.attachedExtensions()) {
        if (attached.uses.includes(id)) found.push(`"${attached.id}" (session ${session.id})`);
      }
    }
    return found;
  }
}
