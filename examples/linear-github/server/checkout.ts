// One session, one clone. The environment (server/compose.ts) opens a session's environment through
// `ensureCheckout`: the first open clones the session's repository into `<root>/repo` and stamps
// the workspace with the session and repository it belongs to; every later open (a resume after
// a restart, days later, when a comment arrives) finds the clone and reuses it. The agent's
// working directory is the repo.
//
// Environment-agnostic on purpose: the same function prepares a directory on this host
// (`openLocalCheckout`) or inside an E2B sandbox (server/sandbox.ts) -- every command goes
// through the environment it was handed, never through the host's own shell.
//
// The stamp is what ties a GitHub PR back to its session: `SubmitPullRequest` reads it and
// writes the session id into the PR body (see server/pull-request-tool.ts). The checkout itself
// never holds credentials -- see server/github.ts.

import { posix } from "node:path";
import { LocalEnvironment, type Environment } from "operon-agents";
import { formatRepo, type GitHubApi, type RepoRef } from "./github.ts";

export const CHECKOUT_DIR = "repo";
const MARKER_FILE = ".operon.json";
const GIT_USER = process.env.GIT_AUTHOR_NAME ?? "operon-agent[bot]";
const GIT_EMAIL = process.env.GIT_AUTHOR_EMAIL ?? "operon-agent[bot]@users.noreply.github.com";

/** What a workspace remembers about itself, next to (not inside) the clone. */
export interface WorkspaceMarker {
  readonly sessionId: string;
  /** `owner/name`: what SubmitPullRequest pushes to and opens the PR against. */
  readonly repo: string;
  readonly base: string;
}

async function exists(environment: Environment, path: string): Promise<boolean> {
  try {
    await environment.fileInfo(path);
    return true;
  } catch {
    return false;
  }
}

async function git(environment: Environment, args: readonly string[], options: { cwd: string; env?: Record<string, string> }): Promise<string> {
  const result = await environment.run(["git", ...args], { ...options, timeoutMs: 10 * 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.exitCode ?? "?"}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

/**
 * The session's environment, rooted in its clone under `root` (a directory on `environment`). Clones on
 * first open, reuses afterwards. Paths are joined with the environment's own path rules, so a
 * sandbox root like `/home/user/work/<session>` works the same as a host directory.
 */
export async function ensureCheckout(environment: Environment, root: string, sessionId: string, repo: RepoRef, github: GitHubApi): Promise<Environment> {
  const join = environment.pathClass() === "posix" ? posix.join : (await import("node:path")).join;
  const repoDir = join(root, CHECKOUT_DIR);
  if (!(await exists(environment, join(repoDir, ".git")))) {
    await environment.mkdir(root, { parents: true });
    const base = await github.defaultBranch(repo);
    await git(environment, ["clone", "--quiet", "--branch", base, github.cloneUrl(repo), repoDir], { cwd: root, env: await github.gitEnv() });
    await git(environment, ["config", "user.name", GIT_USER], { cwd: repoDir });
    await git(environment, ["config", "user.email", GIT_EMAIL], { cwd: repoDir });
    const marker: WorkspaceMarker = { sessionId, repo: formatRepo(repo), base };
    await environment.writeText(join(root, MARKER_FILE), JSON.stringify(marker, null, 2));
  }
  return environment.withCwd(repoDir);
}

/** A checkout in a directory on this host. */
export function openLocalCheckout(root: string, sessionId: string, repo: RepoRef, github: GitHubApi): Promise<Environment> {
  return ensureCheckout(new LocalEnvironment(root), root, sessionId, repo, github);
}

/** The marker of the workspace `environment` is rooted in (its cwd is the clone). */
export async function readMarker(environment: Environment): Promise<WorkspaceMarker> {
  const p = environment.pathClass() === "posix" ? posix : (await import("node:path")).default;
  const path = p.join(p.dirname(environment.getcwd()), MARKER_FILE);
  const raw = JSON.parse((await environment.readBytes(path)).toString("utf8")) as Partial<WorkspaceMarker>;
  if (typeof raw.sessionId !== "string" || typeof raw.repo !== "string" || typeof raw.base !== "string") {
    throw new Error(`${path} is not a workspace marker`);
  }
  return { sessionId: raw.sessionId, repo: raw.repo, base: raw.base };
}

export { git };
