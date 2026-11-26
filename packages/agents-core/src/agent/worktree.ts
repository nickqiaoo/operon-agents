import { randomBytes } from "node:crypto";
import { errorMessage } from "../loop/errors.ts";
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
 * runtime by git itself. By default an unavailable worktree returns `null`. Callers
 * requesting isolation use `required: true` to receive the underlying failure.
 * Cleanup removes the worktree only if the agent left it clean; a dirty worktree is
 * kept for inspection.
 */
export function createWorktree(environment: Environment, options: { label?: string; required: true }): Promise<WorktreeHandle>;
export function createWorktree(environment: Environment, options?: { label?: string; required?: boolean }): Promise<WorktreeHandle | null>;
export async function createWorktree(environment: Environment, options?: { label?: string; required?: boolean }): Promise<WorktreeHandle | null> {
  const cwd = environment.getcwd();
  function unavailable(reason: string): null {
    if (options?.required) throw new Error(`Cannot create an isolated worktree in "${cwd}": ${reason}`);
    return null;
  }
  const repo = await runGit(environment, ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if ("error" in repo) return unavailable(repo.error);
  const root = repo.ok.trim();
  if (!root) return unavailable("Git returned an empty repository root.");

  const id = randomBytes(4).toString("hex");
  const safeLabel = (options?.label ?? "wt").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
  const branch = `wf/${safeLabel}-${id}`;
  // git uses forward slashes on every platform (incl. Windows); normpath fixes display.
  // `.operon/` — the project's name. It was `.agent-framework/`, which this repo
  // has not been called for some time; the directory is created inside the user's
  // own repository, so the stale name was visible to every one of them.
  const wtPath = environment.normpath(`${root}/${WORKTREES_DIR}/${safeLabel}-${id}`);

  const added = await runGit(environment, ["-C", root, "worktree", "add", "--quiet", "-b", branch, wtPath, "HEAD"]);
  if ("error" in added) return unavailable(added.error);

  const cleanup = async (): Promise<void> => {
    const status = await runGit(environment, ["-C", wtPath, "status", "--porcelain"]);
    if ("ok" in status && status.ok.trim() === "") {
      await runGit(environment, ["-C", root, "worktree", "remove", "--force", wtPath]);
      await runGit(environment, ["-C", root, "branch", "-D", branch]);
    }
    // else: leave the dirty/locked worktree in place for inspection. Errors are
    // swallowed by runGit; cleanup is best-effort and never throws into the run.
  };
  return { environment: environment.withCwd(wtPath), cwd: wtPath, cleanup };
}

async function runGit(environment: Environment, args: string[]): Promise<{ ok: string } | { error: string }> {
  try {
    const result = await environment.commands.run(["git", ...args]);
    if (result.exitCode === 0) return { ok: result.stdout };
    return { error: result.stderr.trim() || `Git exited with status ${result.exitCode ?? "unknown"}.` };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
