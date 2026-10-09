/**
 * MCP connections shared by every session opened in the same directory.
 *
 * A desktop host keeps one process up all day and opens many conversations in one project at
 * once. Each of them used to connect the project's MCP servers again — an stdio server is a child
 * process, so N chats in one folder meant N copies of every server. The pool keys one set of
 * connections by the directory's real path and lends it to each session that opens there.
 *
 * This is deliberately NOT a lifetime tier of the engine (that was the workspace `Scope`, removed
 * for the rules it cost). Core still knows two lifetimes, the process and the session; the pool
 * is a host-side object the session hook hands to `defaultCapabilities`, and the MCP capability
 * borrows from it at `openSession` and gives back at `closeSession`. Because the borrowing lives
 * inside the capability's own open/close, a failed open undoes it like everything else the
 * session opened — no hold is taken anywhere the session cannot see.
 *
 * Lifetime of one directory's set, a "generation":
 *  - built on the first borrow, connected once; concurrent borrows share that one connect;
 *  - kept while any session holds it, then for `idleMs` more, so closing the last chat and
 *    starting the next one does not respawn every server;
 *  - replaced, not mutated, when a borrow arrives with a different configuration (an edited
 *    `mcp.json`, a plugin enabled): new sessions get a new generation, the sessions already
 *    holding the old one keep it, and it closes when the last of them gives it back.
 *
 * Sharing is the point, so it is total: two sessions in one directory drive the SAME server.
 * One with state of its own (a browser) is therefore shared state between them; a reconnect or an
 * OAuth sign-in in one session is seen by all. A server that must be private belongs in the
 * session's own `mcpServers`, which are layered over the shared set and never pooled.
 */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createMcpServers,
  mcpServersCapability,
  McpTransportNotPermittedError,
  type Capability,
  type McpServerConfig,
  type McpServersCapabilityOptions,
  type McpServersHandle,
} from "operon-agents-core";

/** How long a directory's connections outlive its last session by default: five minutes. */
export const DEFAULT_WORKSPACE_MCP_IDLE_MS = 5 * 60_000;

export interface WorkspaceMcpPoolOptions extends Omit<McpServersCapabilityOptions, "sharedServers"> {
  /**
   * How long a directory's connections stay up after the last session using them closes, in ms.
   * A session opened there within the window reuses them. `0` closes them at once. Defaults to
   * {@link DEFAULT_WORKSPACE_MCP_IDLE_MS}.
   */
  readonly idleMs?: number;
}

/** One session's hold on a directory's connections. `release` is idempotent. */
export interface WorkspaceMcpLease {
  readonly servers: McpServersHandle;
  release(): Promise<void>;
}

/** One directory's connections, built from one configuration. */
interface Generation {
  readonly key: string;
  readonly fingerprint: string;
  readonly servers: McpServersHandle;
  /** The one connect every borrower of this generation waits on. */
  readonly ready: Promise<void>;
  leases: number;
  idle?: ReturnType<typeof setTimeout>;
  closed?: Promise<void>;
}

export class WorkspaceMcpPool {
  private readonly options: WorkspaceMcpPoolOptions;
  /** The generation a NEW borrow in each directory gets. */
  private readonly current = new Map<string, Generation>();
  /** Every generation not yet shut down — current ones and retired ones still on loan. */
  private readonly live = new Set<Generation>();
  private closing: Promise<void> | undefined;

  constructor(options: WorkspaceMcpPoolOptions = {}) {
    this.options = options;
  }

  /** Directories whose connections are currently up (on loan or idling). */
  get size(): number {
    return this.current.size;
  }

  /**
   * Borrow the connections for `workDir`, building them if this directory has none for exactly
   * these `configs`. Resolves once they have connected — fault-isolated, so a server that failed
   * is a status on the handle, never a rejection. Rejects for what `createMcpServers` refuses
   * up front (a transport this host does not run), before anything is built.
   */
  async acquire(workDir: string, configs: Record<string, McpServerConfig>): Promise<WorkspaceMcpLease> {
    this.assertOpen();
    const key = await canonicalDir(workDir);
    this.assertOpen();
    const fingerprint = fingerprintOf(configs);
    let generation = this.current.get(key);
    if (generation !== undefined && generation.fingerprint !== fingerprint) {
      this.current.delete(key);
      if (generation.leases === 0) void this.shutdown(generation);
      generation = undefined;
    }
    if (generation === undefined) {
      const { idleMs: _idleMs, ...serverOptions } = this.options;
      const servers = createMcpServers(configs, serverOptions);
      // Pooled connections belong to no session: their failures reach each borrower through
      // `onStatusChange`, which the MCP capability subscribes to when it opens.
      generation = { key, fingerprint, servers, ready: servers.connect({ sessionId: "" }), leases: 0 };
      this.current.set(key, generation);
      this.live.add(generation);
    }
    const held = generation;
    held.leases += 1;
    if (held.idle !== undefined) {
      clearTimeout(held.idle);
      held.idle = undefined;
    }
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      held.leases -= 1;
      if (held.leases === 0) await this.idle(held);
    };
    try {
      await held.ready;
    } catch (error) {
      await release();
      throw error;
    }
    return { servers: held.servers, release };
  }

  /** Shut every directory's connections down, on loan or not. Later borrows throw. Idempotent. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.current.clear();
      await Promise.allSettled([...this.live].map((generation) => this.shutdown(generation)));
    })();
    return this.closing;
  }

  /** The last lease came back: close a retired generation now, a current one after the grace. */
  private async idle(generation: Generation): Promise<void> {
    const idleMs = this.options.idleMs ?? DEFAULT_WORKSPACE_MCP_IDLE_MS;
    if (this.current.get(generation.key) !== generation || idleMs <= 0) {
      if (this.current.get(generation.key) === generation) this.current.delete(generation.key);
      await this.shutdown(generation);
      return;
    }
    generation.idle = setTimeout(() => {
      generation.idle = undefined;
      if (generation.leases !== 0 || this.current.get(generation.key) !== generation) return;
      this.current.delete(generation.key);
      void this.shutdown(generation);
    }, idleMs);
    // An idling set must not be what keeps the process alive.
    generation.idle.unref?.();
  }

  private shutdown(generation: Generation): Promise<void> {
    if (generation.idle !== undefined) {
      clearTimeout(generation.idle);
      generation.idle = undefined;
    }
    this.live.delete(generation);
    generation.closed ??= generation.ready.catch(() => undefined).then(() => generation.servers.shutdown());
    return generation.closed;
  }

  private assertOpen(): void {
    if (this.closing !== undefined) throw new Error("WorkspaceMcpPool is closed");
  }
}

export interface WorkspaceMcpCapabilityOptions {
  readonly pool: WorkspaceMcpPool;
  /** The session's working directory — the key the connections are shared under. */
  readonly workDir: string;
  /** The servers every session in `workDir` shares. */
  readonly servers: Record<string, McpServerConfig>;
  /** The session's own servers, layered over the shared ones (same name: the session's wins). */
  readonly overlay?: Record<string, McpServerConfig>;
  /**
   * Options for the overlay's connections; the pooled ones were configured on the pool. Its
   * `allowedTransports` is enforced on BOTH — the host's statement of what it runs does not get
   * weaker because a server happens to be shared.
   */
  readonly overlayOptions?: Omit<McpServersCapabilityOptions, "sharedServers">;
}

/**
 * The `mcp` capability over a directory's pooled connections: borrows them at `openSession`,
 * gives them back at `closeSession` (session close or detach alike). In between it is exactly
 * `mcpServersCapability` viewing a shared set — same tools, same `session.mcp`, same overlay.
 */
export function workspaceMcpCapability(options: WorkspaceMcpCapabilityOptions): Capability {
  const allowed = options.overlayOptions?.allowedTransports;
  if (allowed !== undefined) {
    for (const [name, config] of Object.entries(options.servers)) {
      if (config.enabled !== false && !allowed.includes(config.transport)) {
        throw new McpTransportNotPermittedError(name, config.transport, allowed);
      }
    }
  }
  let lease: WorkspaceMcpLease | undefined;
  /** The borrowed set while a lease is held; the view below is empty without one. */
  let bound: McpServersHandle | undefined;
  const view: McpServersHandle = {
    list: () => bound?.list() ?? [],
    listTools: async (name) => (bound !== undefined ? bound.listTools(name) : []),
    reconnect: async (name) => {
      if (bound === undefined) throw new Error(`Unknown MCP server: ${name}`);
      await bound.reconnect(name);
    },
    onStatusChange: (listener) => bound?.onStatusChange(listener) ?? (() => {}),
    toolProviders: () => bound?.toolProviders() ?? [],
    // The pool connects and shuts down; a viewer does neither.
    connect: async () => {},
    shutdown: async () => {},
  };
  const inner = mcpServersCapability(options.overlay ?? {}, { ...(options.overlayOptions ?? {}), sharedServers: view });
  const giveBack = async (): Promise<void> => {
    const held = lease;
    lease = undefined;
    bound = undefined;
    await held?.release();
  };
  return {
    name: inner.name,
    contract: inner.contract,
    ...(inner.toolProviders !== undefined ? { toolProviders: inner.toolProviders } : {}),
    get service(): unknown {
      return inner.service;
    },
    openSession: async (ctx) => {
      lease = await options.pool.acquire(options.workDir, options.servers);
      bound = lease.servers;
      try {
        await inner.openSession?.(ctx);
      } catch (error) {
        await giveBack();
        throw error;
      }
    },
    closeSession: async (reason) => {
      try {
        await inner.closeSession?.(reason);
      } finally {
        await giveBack();
      }
    },
  };
}

/** The directory's real path, so `./proj`, `/tmp/proj` and a symlink to it share one set. */
async function canonicalDir(workDir: string): Promise<string> {
  const absolute = resolve(workDir);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/** Order-independent identity of a configuration: same servers, same settings, same string. */
function fingerprintOf(configs: Record<string, McpServerConfig>): string {
  return JSON.stringify(configs, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
}
