import * as pathe from "pathe";
import { isSensitiveFile } from "./sensitive.ts";
import type { WorkspaceConfig } from "../support/workspace.ts";
import type { Machine } from "../machine.ts";

export type PathClass = "posix" | "win32";
export type PathSecurityCode = "PATH_OUTSIDE_WORKSPACE" | "PATH_SENSITIVE" | "PATH_INVALID";
export type PathAccessOperation = "read" | "write" | "search";
export type WorkspaceGuardMode = "absolute-outside-allowed" | "disabled";

export interface WorkspaceAccessPolicy {
  readonly guardMode: WorkspaceGuardMode;
  readonly checkSensitive: boolean;
}

export const DEFAULT_WORKSPACE_ACCESS_POLICY: WorkspaceAccessPolicy = {
  guardMode: "absolute-outside-allowed",
  checkSensitive: true,
};

export interface PathAccess {
  readonly path: string;
  readonly outsideWorkspace: boolean;
}

export class PathSecurityError extends Error {
  readonly code: PathSecurityCode;
  readonly rawPath: string;
  readonly canonicalPath: string;

  constructor(code: PathSecurityCode, rawPath: string, canonicalPath: string, message: string) {
    super(message);
    this.name = "PathSecurityError";
    this.code = code;
    this.rawPath = rawPath;
    this.canonicalPath = canonicalPath;
  }
}

const DEFAULT_PATH_CLASS: PathClass = process.platform === "win32" ? "win32" : "posix";

function isWin32DriveRelative(path: string): boolean {
  return /^[A-Za-z]:(?:$|[^\\/])/.test(path);
}

export function normalizeUserPath(path: string, pathClass: PathClass = DEFAULT_PATH_CLASS): string {
  if (pathClass !== "win32") return path;
  if (path === "/") return "/";
  if (path.startsWith("//")) return path;

  const cygdriveMatch = /^\/cygdrive\/([A-Za-z])(?:\/|$)/.exec(path);
  if (cygdriveMatch !== null) {
    const drive = cygdriveMatch[1]!.toUpperCase();
    const rest = path.slice(`/cygdrive/${cygdriveMatch[1]!}`.length);
    return `${drive}:${rest === "" ? "/" : rest}`;
  }

  const driveMatch = /^\/([A-Za-z])(?:\/|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toUpperCase();
    const rest = path.slice(2);
    return `${drive}:${rest === "" ? "/" : rest}`;
  }

  return path;
}

function expandUserPath(path: string, homeDir: string | undefined, pathClass: PathClass): string {
  if (homeDir === undefined) return path;
  if (path === "~") return homeDir;
  if (path.startsWith("~/") || (pathClass === "win32" && path.startsWith("~\\"))) {
    return pathe.join(homeDir, path.slice(2));
  }
  return path;
}

export function canonicalizePath(path: string, cwd: string, pathClass: PathClass = DEFAULT_PATH_CLASS): string {
  if (path === "") throw new PathSecurityError("PATH_INVALID", path, path, "Path cannot be empty");
  const normalizedPath = normalizeUserPath(path, pathClass);
  if (pathClass === "win32" && isWin32DriveRelative(normalizedPath)) {
    throw new PathSecurityError(
      "PATH_INVALID",
      path,
      normalizedPath,
      `"${path}" is a drive-relative Windows path. Use an absolute path like C:\\path or a path relative to the working directory.`,
    );
  }
  if (!pathe.isAbsolute(normalizedPath) && !pathe.isAbsolute(cwd)) {
    throw new PathSecurityError(
      "PATH_INVALID",
      path,
      normalizedPath,
      `Cannot resolve "${path}" against non-absolute cwd "${cwd}".`,
    );
  }
  const abs = pathe.isAbsolute(normalizedPath) ? normalizedPath : pathe.resolve(cwd, normalizedPath);
  return pathe.normalize(abs);
}

export function isWithinDirectory(candidate: string, base: string, pathClass: PathClass = DEFAULT_PATH_CLASS): boolean {
  const nc = pathe.normalize(candidate);
  const nb = pathe.normalize(base);
  const comparableCandidate = pathClass === "win32" ? nc.toLowerCase() : nc;
  const comparableBase = pathClass === "win32" ? nb.toLowerCase() : nb;
  if (comparableCandidate === comparableBase) return true;
  const prefix = comparableBase.endsWith("/") ? comparableBase : comparableBase + "/";
  return comparableCandidate.startsWith(prefix);
}

export function isWithinWorkspace(
  candidate: string,
  config: WorkspaceConfig,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): boolean {
  if (isWithinDirectory(candidate, config.workspaceDir, pathClass)) return true;
  for (const dir of config.additionalDirs) {
    if (isWithinDirectory(candidate, dir, pathClass)) return true;
  }
  return false;
}

export function relativePathParts(targetPath: string, cwd: string, pathClass: PathClass): string[] {
  const rel = pathClass === "win32" ? pathe.relative(cwd, targetPath) : pathe.relative(cwd, targetPath);
  return rel.split(/[\\/]+/).filter((part) => part.length > 0);
}

export interface ResolvePathAccessOptions {
  readonly operation: PathAccessOperation;
  readonly policy?: WorkspaceAccessPolicy | undefined;
  readonly pathClass?: PathClass | undefined;
  readonly homeDir?: string;
}

export interface ResolvePathAccessPathOptions {
  readonly machine: Pick<Machine, "pathClass" | "gethome" | "realpath">;
  readonly workspace: WorkspaceConfig;
  readonly operation: PathAccessOperation;
  readonly policy?: WorkspaceAccessPolicy;
  readonly expandHome?: boolean;
}

/**
 * Symlink resolution for a path that may not fully exist yet (e.g. a file `Write`
 * is about to create). Backends disagree on whether `realpath` throws for a missing
 * leaf (LocalMachine does, the posix `readlink -f` fallback does not); walking up to the
 * longest existing ancestor and rejoining the remainder normalizes that away so a
 * merely-missing path never throws ENOENT.
 *
 * Only not-found errors trigger the walk-up. Anything else (EACCES, a dropped SSH
 * connection, ELOOP, EIO) propagates: this function feeds a security check, and
 * swallowing a transient backend failure would silently degrade the guard back to
 * string-only matching — fail closed instead.
 */
async function resolveRealPath(machine: Pick<Machine, "realpath">, path: string): Promise<string> {
  try {
    return await machine.realpath(path);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const parent = pathe.dirname(path);
    if (parent === path) return path;
    const parentReal = await resolveRealPath(machine, parent);
    return pathe.join(parentReal, pathe.basename(path));
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown })["code"];
  return code === "ENOENT" || code === "ENOTDIR";
}

function relativeOutsideMessage(path: string, operation: PathAccessOperation): string {
  const verb = operation === "write" ? "write or edit a file" : operation === "search" ? "search" : "read a file";
  return `"${path}" is not an absolute path. You must provide an absolute path to ${verb} outside the working directory.`;
}

export function resolvePathAccess(
  path: string,
  cwd: string,
  config: WorkspaceConfig,
  options: ResolvePathAccessOptions,
): PathAccess {
  const pathClass = options.pathClass ?? DEFAULT_PATH_CLASS;
  const normalizedPath = normalizeUserPath(path, pathClass);
  const expandedPath = expandUserPath(normalizedPath, options.homeDir, pathClass);
  const rawIsAbsolute = pathe.isAbsolute(expandedPath);
  const canonical = canonicalizePath(expandedPath, cwd, pathClass);
  const outsideWorkspace = !isWithinWorkspace(canonical, config, pathClass);
  const policy = options.policy ?? DEFAULT_WORKSPACE_ACCESS_POLICY;

  if (policy.checkSensitive && isSensitiveFile(canonical)) {
    throw new PathSecurityError(
      "PATH_SENSITIVE",
      path,
      canonical,
      `"${path}" matches a sensitive-file pattern (env / credential / SSH key). Access is blocked to protect secrets.`,
    );
  }

  if (outsideWorkspace) {
    switch (policy.guardMode) {
      case "absolute-outside-allowed":
        if (!rawIsAbsolute) {
          throw new PathSecurityError(
            "PATH_OUTSIDE_WORKSPACE",
            path,
            canonical,
            relativeOutsideMessage(path, options.operation),
          );
        }
        break;
      case "disabled":
        break;
    }
  }

  return { path: canonical, outsideWorkspace };
}

/**
 * Resolve and symlink-check a user-supplied path against the workspace. Unlike
 * {@link resolvePathAccess} (pure string canonicalization), this also resolves
 * symlinks via the machine so a workspace-internal symlink that targets an
 * outside/sensitive path cannot be used to bypass the guard — see `Machine.realpath`.
 */
export async function resolvePathAccessPath(path: string, options: ResolvePathAccessPathOptions): Promise<string> {
  const { machine, workspace, operation, policy, expandHome = true } = options;
  const pathClass = machine.pathClass();
  const effectivePolicy = policy ?? DEFAULT_WORKSPACE_ACCESS_POLICY;
  const access = resolvePathAccess(path, workspace.workspaceDir, workspace, {
    operation,
    policy,
    pathClass,
    homeDir: expandHome ? machine.gethome() : undefined,
  });

  const real = await resolveRealPath(machine, access.path);
  if (real !== access.path) {
    if (effectivePolicy.checkSensitive && isSensitiveFile(real)) {
      throw new PathSecurityError(
        "PATH_SENSITIVE",
        path,
        real,
        `"${path}" resolves through a symlink to a sensitive-file pattern (env / credential / SSH key). Access is blocked to protect secrets.`,
      );
    }
    // The workspace root itself may sit behind ancestor symlinks (e.g. macOS
    // /tmp -> /private/tmp), so compare against the *resolved* boundary — otherwise
    // every path would spuriously look like it escaped a workspace it never left.
    const realWorkspace = {
      workspaceDir: await resolveRealPath(machine, workspace.workspaceDir),
      additionalDirs: await Promise.all(workspace.additionalDirs.map((dir) => resolveRealPath(machine, dir))),
    };
    if (
      effectivePolicy.guardMode !== "disabled" &&
      !access.outsideWorkspace &&
      !isWithinWorkspace(real, realWorkspace, pathClass)
    ) {
      throw new PathSecurityError(
        "PATH_OUTSIDE_WORKSPACE",
        path,
        real,
        `"${path}" resolves through a symlink to "${real}", which is outside the working directory. Access is blocked.`,
      );
    }
  }

  return access.path;
}
