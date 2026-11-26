import type { Environment } from "./environment.ts";
import { NullEnvironment } from "./environment-null.ts";

/** What a session's root environment is called when the host names none. */
export const DEFAULT_ROOT_ENVIRONMENT_NAME = "main";

/** Allowed spelling of an environment name: lower-case, starts with a letter, at most 32 chars. */
export const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * What a subagent sent to an environment may reach. `inherit`: whatever its parent could.
 * `home-only`: that environment and nothing else — for a machine whose work must not touch the
 * others (a sandbox running untrusted code should not be able to `target` your workstation).
 */
export type SubagentEnvironmentAccess = "inherit" | "home-only";

/**
 * What the model is told about an environment, as of when it was declared: the values the
 * system prompt renders. Kept with the declaration so the prompt is the same bytes on every
 * open, whether or not the machine is connected this time or has moved its working directory.
 */
export interface EnvironmentSnapshot {
  readonly osKind: string;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: string;
  readonly shellPath: string;
  readonly cwd: string;
}

/**
 * One named target a session's tools can run in. The NAME is what the model writes as `target`,
 * what durable records keep, and what permission grants are scoped by; the IDENTITY is what two
 * calls are compared by when deciding whether they touch the same workspace (two names may point
 * at one workspace — the host then gives both the same identity).
 */
export interface EnvironmentTableEntry {
  readonly name: string;
  /** The live instance. For an unavailable entry, a placeholder whose every I/O call fails. */
  readonly environment: Environment;
  /** False when the session declares this environment but this open was not handed it. */
  readonly available: boolean;
  /** What this target is for, shown to the model next to its OS / shell / cwd. */
  readonly description?: string;
  /** Overrides the table's default for subagents sent here. */
  readonly subagentAccess?: SubagentEnvironmentAccess;
  /** What the prompt says about it (see {@link EnvironmentSnapshot}). */
  readonly snapshot: EnvironmentSnapshot;
  /** Process-local: never persisted (a sandbox id can change across a snapshot restore). */
  readonly identity: string;
}

/** Host input for one entry — identity and snapshot are derived when not given. */
export interface EnvironmentTableEntryInput {
  readonly name: string;
  readonly environment: Environment;
  readonly description?: string;
  readonly identity?: string;
  readonly subagentAccess?: SubagentEnvironmentAccess;
  /** Default true. An unavailable entry keeps its declared place but runs nothing. */
  readonly available?: boolean;
  /** Default: read from `environment` now. */
  readonly snapshot?: EnvironmentSnapshot;
}

export interface EnvironmentTableOptions {
  /** Default for subagents sent to an environment that sets none. Default `inherit`. */
  readonly subagentAccess?: SubagentEnvironmentAccess;
}

/** Thrown for a table the host described wrongly (bad or duplicate name, undeclared name). */
export class EnvironmentTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentTableError";
  }
}

/**
 * A stand-in for a declared environment this open was not handed. Tool calls never reach it — the
 * tool-call layer refuses a call to an unavailable environment first — but anything that holds
 * the entry and tries I/O gets an error that names the environment instead of a null crash.
 */
export function unavailableEnvironment(environmentName: string): Environment {
  const placeholder = Object.create(new NullEnvironment()) as Environment;
  Object.defineProperty(placeholder, "name", { value: `unavailable:${environmentName}`, enumerable: true });
  return placeholder;
}

/**
 * The default identity: the backing machine plus the working directory. `sandbox.id` alone would
 * merge two worktrees of one checkout; cwd alone would merge two machines with the same layout.
 */
export function defaultEnvironmentIdentity(environment: Environment): string {
  let machine: string;
  try {
    machine = environment.sandbox.id;
  } catch {
    machine = environment.name;
  }
  return `${machine}:${safeCwd(environment)}`;
}

/** The prompt-facing facts of `environment`, read now. */
export function snapshotOf(environment: Environment): EnvironmentSnapshot {
  const os = environment.osInfo;
  return {
    osKind: os.osKind,
    osArch: os.osArch,
    osVersion: os.osVersion,
    shellName: os.shellName,
    shellPath: os.shellPath,
    cwd: safeCwd(environment),
  };
}

function safeCwd(environment: Environment): string {
  try {
    return environment.normpath(environment.getcwd());
  } catch {
    return "";
  }
}

/** Why `name` cannot name an environment, or `undefined` when it can. */
export function invalidEnvironmentName(name: string): string | undefined {
  if (ENVIRONMENT_NAME_PATTERN.test(name)) return undefined;
  return `environment name "${name}" must match ${String(ENVIRONMENT_NAME_PATTERN)} (lower-case letters, digits, "_" and "-", starting with a letter, at most 32 characters)`;
}

/**
 * A session's named environments: the root (where the session runs by default) plus any the host
 * added. A table of one is the ordinary single-environment session, and every multi-environment
 * behavior (the `target` parameter, the prompt's environment list, the `environment` field on
 * events) is switched off for it.
 */
export class EnvironmentTable {
  readonly rootName: string;
  /** Default for subagents sent to an environment that sets none. */
  readonly subagentAccess: SubagentEnvironmentAccess;
  private readonly byName: ReadonlyMap<string, EnvironmentTableEntry>;

  constructor(root: EnvironmentTableEntryInput, additional: readonly EnvironmentTableEntryInput[] = [], options: EnvironmentTableOptions = {}) {
    const entries = new Map<string, EnvironmentTableEntry>();
    for (const input of [root, ...additional]) {
      const invalid = invalidEnvironmentName(input.name);
      if (invalid !== undefined) throw new EnvironmentTableError(invalid);
      if (entries.has(input.name)) throw new EnvironmentTableError(`environment name "${input.name}" is used twice`);
      const available = input.available !== false;
      if (!available && input === root) throw new EnvironmentTableError(`the root environment "${input.name}" must be available`);
      entries.set(input.name, {
        name: input.name,
        environment: input.environment,
        available,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.subagentAccess !== undefined ? { subagentAccess: input.subagentAccess } : {}),
        snapshot: input.snapshot ?? snapshotOf(input.environment),
        identity: input.identity ?? (available ? defaultEnvironmentIdentity(input.environment) : `unavailable:${input.name}`),
      });
    }
    this.rootName = root.name;
    this.subagentAccess = options.subagentAccess ?? "inherit";
    this.byName = entries;
  }

  /** A table holding only `environment`, named {@link DEFAULT_ROOT_ENVIRONMENT_NAME}. */
  static single(environment: Environment, name = DEFAULT_ROOT_ENVIRONMENT_NAME): EnvironmentTable {
    return new EnvironmentTable({ name, environment });
  }

  get size(): number {
    return this.byName.size;
  }

  get root(): EnvironmentTableEntry {
    return this.byName.get(this.rootName)!;
  }

  /** Names in declaration order, root first. */
  get names(): readonly string[] {
    return [...this.byName.keys()];
  }

  get entries(): readonly EnvironmentTableEntry[] {
    return [...this.byName.values()];
  }

  get(name: string): EnvironmentTableEntry | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** What a subagent sent to `name` may reach. */
  subagentAccessFor(name: string): SubagentEnvironmentAccess {
    return this.byName.get(name)?.subagentAccess ?? this.subagentAccess;
  }
}

// ── Declaration: what a session HAS, kept with the session ──────────────────────────────

/**
 * The durable half of a multi-environment session: which environments it has, what each is for,
 * and what the model was told about each. The framework keeps it with the session; a host hands
 * in only the live instances on each open, by name. Everything model-facing — the `target` enum,
 * the prompt's environment list — is rendered from this, so a reopen sends the same request
 * prefix no matter which machines are connected this time.
 */
export interface EnvironmentDeclaration {
  readonly version: 1;
  readonly root: string;
  readonly subagentAccess?: SubagentEnvironmentAccess;
  /** Root first, then the rest in declaration order. */
  readonly environments: readonly EnvironmentDeclarationEntry[];
}

export interface EnvironmentDeclarationEntry {
  readonly name: string;
  readonly description?: string;
  readonly subagentAccess?: SubagentEnvironmentAccess;
  readonly snapshot: EnvironmentSnapshot;
}

export function declarationOf(table: EnvironmentTable): EnvironmentDeclaration {
  return {
    version: 1,
    root: table.rootName,
    ...(table.subagentAccess !== "inherit" ? { subagentAccess: table.subagentAccess } : {}),
    environments: table.entries.map((entry) => ({
      name: entry.name,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.subagentAccess !== undefined ? { subagentAccess: entry.subagentAccess } : {}),
      snapshot: entry.snapshot,
    })),
  };
}

/** Read a stored declaration; `undefined` for anything that is not one. */
export function parseEnvironmentDeclaration(value: unknown): EnvironmentDeclaration | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Partial<EnvironmentDeclaration>;
  if (v.version !== 1 || typeof v.root !== "string" || !Array.isArray(v.environments)) return undefined;
  const environments: EnvironmentDeclarationEntry[] = [];
  for (const raw of v.environments as unknown[]) {
    if (raw === null || typeof raw !== "object") return undefined;
    const e = raw as Partial<EnvironmentDeclarationEntry>;
    if (typeof e.name !== "string" || e.snapshot === undefined || typeof e.snapshot !== "object") return undefined;
    environments.push({
      name: e.name,
      ...(typeof e.description === "string" ? { description: e.description } : {}),
      ...(isAccess(e.subagentAccess) ? { subagentAccess: e.subagentAccess } : {}),
      snapshot: e.snapshot as EnvironmentSnapshot,
    });
  }
  if (environments[0]?.name !== v.root) return undefined;
  return {
    version: 1,
    root: v.root,
    ...(isAccess(v.subagentAccess) ? { subagentAccess: v.subagentAccess } : {}),
    environments,
  };
}

function isAccess(value: unknown): value is SubagentEnvironmentAccess {
  return value === "inherit" || value === "home-only";
}

/** What differs between a snapshot the model was given and an environment as it is now. */
export function snapshotDrift(declared: EnvironmentSnapshot, live: EnvironmentSnapshot): string[] {
  const out: string[] = [];
  if (declared.cwd !== live.cwd) out.push(`working directory is now ${live.cwd}`);
  if (declared.osKind !== live.osKind || declared.osVersion !== live.osVersion || declared.osArch !== live.osArch) {
    out.push(`OS is now ${[live.osKind, live.osVersion, live.osArch].filter((p) => p.length > 0).join(" ")}`);
  }
  if (declared.shellName !== live.shellName || declared.shellPath !== live.shellPath) out.push(`shell is now ${live.shellName} (${live.shellPath})`);
  return out;
}

// ── A frame's view ──────────────────────────────────────────────────────────────────────

/**
 * The environments ONE frame (root agent or subagent) can address, as the tool-call layer needs
 * them. `home` is where a call without `target` runs; its entry carries the frame's ACTUAL
 * environment (a workflow worktree, say), which may differ from the table's entry of that name.
 * Present on a step only when the frame can reach more than one environment.
 */
export interface FrameEnvironments {
  readonly home: string;
  /** Name of the session's root environment (permission defaults apply to it). */
  readonly root: string;
  /** Reachable entries by name, `home` included, in table order. */
  readonly reachable: ReadonlyMap<string, EnvironmentTableEntry>;
  /** Every name the session declares, reachable from this frame or not. */
  readonly declared: readonly string[];
}

/**
 * Build a frame's view of the table. `homeEnvironment` is the frame's own instance; `reachable`
 * limits the names (undefined = the whole table). Returns `undefined` for a single-environment
 * session — the path that must stay byte-for-byte what it was. A frame of a multi-environment
 * session that reaches only its home still gets a view: it is offered no `target` and no list,
 * but a call that names another environment is refused instead of silently running at home.
 */
export function frameEnvironmentsOf(
  table: EnvironmentTable | undefined,
  home: string,
  homeEnvironment: Environment,
  reachable?: readonly string[],
): FrameEnvironments | undefined {
  if (table === undefined || table.size <= 1) return undefined;
  const allowed = reachable === undefined ? undefined : new Set(reachable);
  const map = new Map<string, EnvironmentTableEntry>();
  for (const entry of table.entries) {
    if (entry.name !== home && allowed !== undefined && !allowed.has(entry.name)) continue;
    if (entry.name === home && entry.environment !== homeEnvironment) {
      // The frame runs on its own instance of this environment (a worktree): what the prompt
      // says is that instance, and so is the identity the scheduler compares.
      map.set(entry.name, {
        ...entry,
        environment: homeEnvironment,
        available: true,
        snapshot: snapshotOf(homeEnvironment),
        identity: defaultEnvironmentIdentity(homeEnvironment),
      });
    } else {
      map.set(entry.name, entry);
    }
  }
  return { home, root: table.rootName, reachable: map, declared: table.names };
}

/**
 * The prompt section listing a frame's environments. Rendered from the declared snapshots only —
 * never from whether a machine is connected right now — so the same frame renders the same bytes
 * on every turn and every reopen, and the cached prefix holds. Availability and drift reach the
 * model as reminders instead.
 */
export function renderEnvironmentSection(frame: FrameEnvironments): string {
  const lines: string[] = [
    "# Environments",
    "",
    "This session can run tools on more than one machine. File and shell tools take an optional `target` naming one of the environments below; without it they run on your home environment. Paths, processes and files on one environment are not visible on another.",
    "",
  ];
  for (const entry of frame.reachable.values()) {
    const s = entry.snapshot;
    const os = [s.osKind, s.osVersion, s.osArch].filter((part) => part.length > 0).join(" ");
    const home = entry.name === frame.home ? " (home)" : "";
    lines.push(`- \`${entry.name}\`${home}${entry.description !== undefined ? `: ${entry.description}` : ""}`);
    lines.push(`  - OS: ${os}; shell: ${s.shellName} (${s.shellPath}); working directory: ${s.cwd || "(unknown)"}`);
  }
  return lines.join("\n");
}
