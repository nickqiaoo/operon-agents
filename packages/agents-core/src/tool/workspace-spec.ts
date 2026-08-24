/**
 * Declarative workspace preparation: describe what a workspace should CONTAIN, and let this
 * materialize it. The whole implementation is a recursive descent over a small entry union.
 *
 * Deliberately smaller than a general sandbox manifest format. Omitted, because a coding
 * workspace does not need them: bucket mounts (rclone/FUSE), users/groups/permission bits,
 * secret-store environment references, and cross-language serialization compatibility. Those
 * are where nearly all the size of such formats goes. Add one only when a real need appears.
 *
 * Written against `Machine`, so it works on local, SSH and sandbox backends alike rather than
 * being reimplemented per vendor.
 */
import type { Machine } from "./machine.ts";

export type WorkspaceEntry =
  | { readonly type: "dir"; readonly children?: Readonly<Record<string, WorkspaceEntry>> }
  | { readonly type: "file"; readonly content: string; readonly lineEndings?: "LF" | "CRLF" }
  | { readonly type: "host_file"; readonly src: string }
  | { readonly type: "host_dir"; readonly src: string }
  | {
      readonly type: "git_repo";
      readonly repo: string;
      readonly ref?: string;
      /** Shallow by default; full history is rarely what an agent needs. */
      readonly depth?: number;
    };

export interface WorkspaceSpec {
  /** Absolute root every entry path is relative to. */
  readonly root: string;
  readonly entries: Readonly<Record<string, WorkspaceEntry>>;
}

export interface MaterializeOptions {
  /** Reads host files for `host_file`/`host_dir`. Omit to reject those entries. */
  readonly hostReader?: HostReader;
  readonly signal?: AbortSignal;
  /** Per-command timeout for `git_repo` clones. */
  readonly gitTimeoutMs?: number;
}

/** Host-side filesystem access, injected so this module needs no `node:fs` import. */
export interface HostReader {
  readFile(path: string): Promise<Buffer>;
  /** Relative paths of every file beneath `dir`, recursively. */
  listFiles(dir: string): Promise<readonly string[]>;
}

/** Concurrent host→machine file writes. Latency-bound work, so this is well above CPU count. */
const HOST_DIR_CONCURRENCY = 8;

/** Run `body` over every item, at most `limit` in flight. The first rejection propagates. */
async function inParallel<T>(items: readonly T[], limit: number, body: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await body(item);
      }
    }),
  );
}

export class WorkspaceMaterializeError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceMaterializeError";
    this.path = path;
  }
}

/**
 * Create everything the spec declares. Entries are materialized in declaration order so a
 * later entry may depend on an earlier one (config written into a freshly cloned repo).
 */
export async function materializeWorkspace(
  machine: Machine,
  spec: WorkspaceSpec,
  options: MaterializeOptions = {},
): Promise<void> {
  const root = machine.normpath(spec.root);
  await machine.mkdir(root, { parents: true });
  await materializeEntries(machine, root, root, spec.entries, options);
}

async function materializeEntries(
  machine: Machine,
  root: string,
  base: string,
  entries: Readonly<Record<string, WorkspaceEntry>>,
  options: MaterializeOptions,
): Promise<void> {
  for (const [relative, entry] of Object.entries(entries)) {
    options.signal?.throwIfAborted();
    const target = safeJoin(machine, root, base, relative);
    await materializeEntry(machine, root, target, entry, options);
  }
}

async function materializeEntry(
  machine: Machine,
  root: string,
  target: string,
  entry: WorkspaceEntry,
  options: MaterializeOptions,
): Promise<void> {
  switch (entry.type) {
    case "dir": {
      await machine.mkdir(target, { parents: true });
      if (entry.children !== undefined) {
        await materializeEntries(machine, root, target, entry.children, options);
      }
      return;
    }
    case "file": {
      await machine.mkdir(parentOf(machine, target), { parents: true });
      await machine.writeText(target, entry.content, {
        ...(entry.lineEndings !== undefined ? { lineEndings: entry.lineEndings } : {}),
      });
      return;
    }
    case "host_file": {
      const reader = requireReader(options, target);
      await machine.mkdir(parentOf(machine, target), { parents: true });
      // writeBytes, not writeText: a host file may be an image, a binary, or text in an
      // encoding we have no business guessing at. Decoding to UTF-8 here corrupted every
      // one of those, silently.
      await machine.writeBytes(target, await reader.readFile(entry.src));
      return;
    }
    case "host_dir": {
      const reader = requireReader(options, target);
      await machine.mkdir(target, { parents: true });
      const files = (await reader.listFiles(entry.src)).map((relative) => ({
        relative,
        dest: safeJoin(machine, root, target, relative),
      }));
      // Create each parent directory once rather than once per file it holds.
      for (const dir of new Set(files.map(({ dest }) => parentOf(machine, dest)))) {
        options.signal?.throwIfAborted();
        await machine.mkdir(dir, { parents: true });
      }
      // Copy with bounded concurrency. Serially, every file cost a full round trip, so on a
      // remote machine a directory of any size was seconds of pure latency; the cap keeps a
      // large tree from opening an unbounded number of writes at once.
      await inParallel(files, HOST_DIR_CONCURRENCY, async ({ relative, dest }) => {
        options.signal?.throwIfAborted();
        await machine.writeBytes(dest, await reader.readFile(`${entry.src}/${relative}`));
      });
      return;
    }
    case "git_repo": {
      const argv = ["git", "clone"];
      if (entry.depth !== 0) argv.push("--depth", String(entry.depth ?? 1));
      if (entry.ref !== undefined) argv.push("--branch", entry.ref);
      argv.push("--", entry.repo, target);
      const result = await machine.run(argv, {
        ...(options.gitTimeoutMs !== undefined ? { timeoutMs: options.gitTimeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (result.exitCode !== 0) {
        const detail = result.timedOut ? "timed out" : (result.stderr.trim() || `exit ${String(result.exitCode)}`);
        throw new WorkspaceMaterializeError(`git clone of ${entry.repo} failed: ${detail}`, target);
      }
      return;
    }
  }
}

/**
 * Render a spec as a tree, for telling a MODEL what its workspace contains.
 *
 * An agent dropped into a prepared workspace otherwise has to discover it by listing
 * directories — several tool calls to learn what the host already knew declaratively. This
 * describes the DECLARED shape, not the live filesystem: it is cheap (no I/O) and it stays
 * honest about that, since anything the agent creates later will not appear here.
 */
export function describeWorkspace(spec: WorkspaceSpec, options: { maxLines?: number } = {}): string {
  const maxLines = options.maxLines ?? 200;
  const lines: string[] = [spec.root];
  const truncated = appendEntryLines(lines, spec.entries, "", maxLines);
  if (truncated) lines.push("… (truncated)");
  return lines.join("\n");
}

/** Returns whether the listing was cut short by `maxLines`. */
function appendEntryLines(
  lines: string[],
  entries: Readonly<Record<string, WorkspaceEntry>>,
  indent: string,
  maxLines: number,
): boolean {
  const names = Object.keys(entries);
  for (const [index, name] of names.entries()) {
    if (lines.length >= maxLines) return true;
    const entry = entries[name]!;
    const last = index === names.length - 1;
    lines.push(`${indent}${last ? "└── " : "├── "}${name}${describeEntry(entry)}`);
    if (entry.type === "dir" && entry.children !== undefined) {
      if (appendEntryLines(lines, entry.children, `${indent}${last ? "    " : "│   "}`, maxLines)) return true;
    }
  }
  return false;
}

function describeEntry(entry: WorkspaceEntry): string {
  switch (entry.type) {
    case "dir":
      return "/";
    case "file":
      return `  (${String(Buffer.byteLength(entry.content, "utf8"))} bytes)`;
    case "host_file":
      return `  ← ${entry.src}`;
    case "host_dir":
      return `/  ← ${entry.src}`;
    case "git_repo": {
      const ref = entry.ref === undefined ? "" : ` @ ${entry.ref}`;
      const depth = entry.depth === 0 ? ", full history" : "";
      return `/  ← git clone ${entry.repo}${ref}${depth}`;
    }
  }
}

function requireReader(options: MaterializeOptions, path: string): HostReader {
  if (options.hostReader === undefined) {
    throw new WorkspaceMaterializeError("host_file/host_dir entries need a hostReader", path);
  }
  return options.hostReader;
}

function parentOf(machine: Machine, path: string): string {
  const sep = machine.pathClass() === "win32" ? "\\" : "/";
  const cut = path.lastIndexOf(sep);
  return cut <= 0 ? path : path.slice(0, cut);
}

/**
 * Join and verify the result stays under `root`. Entry paths often come from user config, so
 * `../` escaping the workspace must be refused rather than normalized away silently.
 */
function safeJoin(machine: Machine, root: string, base: string, relative: string): string {
  const sep = machine.pathClass() === "win32" ? "\\" : "/";
  const joined = machine.normpath(`${base}${sep}${relative}`);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (joined !== root && !joined.startsWith(prefix)) {
    throw new WorkspaceMaterializeError(`entry path escapes the workspace root: ${relative}`, joined);
  }
  return joined;
}
