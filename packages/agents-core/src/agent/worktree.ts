import { randomBytes } from "node:crypto";
import type { Environment } from "../tool/environment.ts";

/**
 * An isolated working copy handed to a subagent that mutates files, so parallel
 * agents don't clobber each other. `environment` is scoped to the copy (its getcwd()
 * is `cwd`); `cleanup` tears it down (the worktree is removed only if the agent
 * left no changes — a dirty copy is kept for inspection).
 */
export interface WorktreeHandle {
  readonly environment: Environment;
  readonly cwd: string;
  cleanup(): Promise<void>;
}

/**
 * Where isolated worktrees are created, relative to the repository root.
 *
 * Inside the repo on purpose: a worktree has to live on the same filesystem as
 * the repo it forks, and keeping it adjacent means a dirty one left for
 * inspection is found where the work was. Consumers should gitignore it — an
 * abandoned worktree is a checkout, so it shows up as untracked otherwise.
 */
export const WORKTREES_DIR = ".operon/worktrees";

/**
 * Create an isolated git worktree for a subagent and return an environment scoped to it.
 *
 * This is workflow/orchestration policy built entirely on an environment's existing
 * capabilities — git runs through `environment.exec`, and the scoped environment comes from
 * `environment.withCwd`. It is therefore backend-agnostic: any environment whose target host
 * has git (local, ssh, sandbox) can isolate. Whether isolation happens is decided at
 * runtime by git itself — a host without git, or a cwd that isn't a repo, makes the
 * git command fail and we return `null`, and the caller degrades to the shared
 * workspace (surfacing that isolation was unavailable rather than failing silently).
 * Cleanup removes the worktree only if the agent left it clean; a dirty worktree is
 * kept for inspection.
 */
export async function createWorktree(environment: Environment, options?: { label?: string }): Promise<WorktreeHandle | null> {
  const root = (await runGit(environment, ["-C", environment.getcwd(), "rev-parse", "--show-toplevel"])).ok?.trim();
  if (!root) return null; // no git, or cwd isn't a repo → no isolation available

  const id = randomBytes(4).toString("hex");
  const safeLabel = (options?.label ?? "wt").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
  const branch = `wf/${safeLabel}-${id}`;
  // git uses forward slashes on every platform (incl. Windows); normpath fixes display.
  // `.operon/` — the project's name. It was `.agent-framework/`, which this repo
  // has not been called for some time; the directory is created inside the user's
  // own repository, so the stale name was visible to every one of them.
  const wtPath = environment.normpath(`${root}/${WORKTREES_DIR}/${safeLabel}-${id}`);

  const added = await runGit(environment, ["-C", root, "worktree", "add", "--quiet", "-b", branch, wtPath, "HEAD"]);
  if (added.ok === undefined) return null; // creation failed → caller degrades to shared workspace

  const cleanup = async (): Promise<void> => {
    const status = await runGit(environment, ["-C", wtPath, "status", "--porcelain"]);
    if (status.ok !== undefined && status.ok.trim() === "") {
      await runGit(environment, ["-C", root, "worktree", "remove", "--force", wtPath]);
      await runGit(environment, ["-C", root, "branch", "-D", branch]);
    }
    // else: leave the dirty/locked worktree in place for inspection. Errors are
    // swallowed by runGit; cleanup is best-effort and never throws into the run.
  };
  return { environment: environment.withCwd(wtPath), cwd: wtPath, cleanup };
}

/** Run `git <args>` on the environment's host; `ok` is stdout on exit 0, undefined otherwise. */
async function runGit(environment: Environment, args: string[]): Promise<{ ok?: string }> {
  // `.catch` covers git-not-found / the backend refusing to spawn at all.
  const result = await environment.run(["git", ...args]).catch(() => undefined);
  return result?.exitCode === 0 ? { ok: result.stdout } : {};
}
