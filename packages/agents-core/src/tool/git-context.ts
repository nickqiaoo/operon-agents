import type { Machine } from "./machine.ts";

const GIT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_DIRTY_FILES = 20;
const DEFAULT_RECENT_COMMITS = 3;
const MAX_COMMIT_LINE_LENGTH = 200;

const ALLOWED_HOSTS = ["github.com", "gitlab.com", "gitee.com", "bitbucket.org", "codeberg.org", "git.sr.ht"] as const;

export interface GitContextOptions {
  readonly maxDirtyFiles?: number;
  readonly recentCommits?: number;
}

export interface GitContext {
  readonly isRepo: boolean;
  readonly cwd: string;
  readonly remote?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly dirtyFiles: readonly string[];
  readonly dirtyCount: number;
  readonly recentCommits: readonly string[];
}

export async function collectGitContext(machine: Machine, cwd: string, options: GitContextOptions = {}): Promise<GitContext> {
  const maxDirty = options.maxDirtyFiles ?? DEFAULT_MAX_DIRTY_FILES;
  const nCommits = options.recentCommits ?? DEFAULT_RECENT_COMMITS;

  if ((await runGit(machine, cwd, ["rev-parse", "--is-inside-work-tree"])) === null) {
    return { isRepo: false, cwd, dirtyFiles: [], dirtyCount: 0, recentCommits: [] };
  }

  const [remoteRaw, branchRaw, dirtyRaw, logRaw] = await Promise.all([
    runGit(machine, cwd, ["remote", "get-url", "origin"]),
    runGit(machine, cwd, ["branch", "--show-current"]),
    runGit(machine, cwd, ["status", "--porcelain"]),
    runGit(machine, cwd, ["log", `-${String(nCommits)}`, "--format=%h %s"]),
  ]);

  const remote = remoteRaw !== null ? (sanitizeRemoteUrl(remoteRaw) ?? undefined) : undefined;
  const project = remote !== undefined ? (parseProjectName(remote) ?? undefined) : undefined;
  const branch = branchRaw !== null && branchRaw.length > 0 ? branchRaw : undefined;

  const allDirty = dirtyRaw !== null ? dirtyRaw.split("\n").filter((line) => line.trim().length > 0) : [];
  const recentCommits =
    logRaw !== null
      ? logRaw
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => line.slice(0, MAX_COMMIT_LINE_LENGTH))
      : [];

  return {
    isRepo: true,
    cwd,
    remote,
    project,
    branch,
    dirtyFiles: allDirty.slice(0, maxDirty),
    dirtyCount: allDirty.length,
    recentCommits,
  };
}

export function formatGitContext(ctx: GitContext): string {
  if (!ctx.isRepo) return "";
  const sections: string[] = [`Working directory: ${ctx.cwd}`];
  if (ctx.remote) sections.push(`Remote: ${ctx.remote}`);
  if (ctx.project) sections.push(`Project: ${ctx.project}`);
  if (ctx.branch) sections.push(`Branch: ${ctx.branch}`);

  if (ctx.dirtyCount > 0) {
    let body = ctx.dirtyFiles.map((line) => `  ${line}`).join("\n");
    if (ctx.dirtyCount > ctx.dirtyFiles.length) {
      body += `\n  ... and ${String(ctx.dirtyCount - ctx.dirtyFiles.length)} more`;
    }
    sections.push(`Dirty files (${String(ctx.dirtyCount)}):\n${body}`);
  }

  if (ctx.recentCommits.length > 0) {
    sections.push(`Recent commits:\n${ctx.recentCommits.map((line) => `  ${line}`).join("\n")}`);
  }

  if (sections.length <= 1) return "";
  return `<git-context>\n${sections.join("\n")}\n</git-context>`;
}

export function sanitizeRemoteUrl(remoteUrl: string): string | null {
  // scp-like SSH (`git@host:owner/repo.git`) — no credentials possible.
  for (const host of ALLOWED_HOSTS) {
    if (remoteUrl.startsWith(`git@${host}:`)) return remoteUrl;
  }
  // HTTPS — parse the hostname exactly and drop any userinfo.
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if ((ALLOWED_HOSTS as readonly string[]).includes(parsed.hostname)) {
    const port = parsed.port ? `:${parsed.port}` : "";
    return `https://${parsed.hostname}${port}${parsed.pathname}`;
  }
  return null;
}

export function parseProjectName(remoteUrl: string): string | null {
  const scp = /^[^/]+@[^/:]+:(.+)$/.exec(remoteUrl);
  const rawPath = scp?.[1] ?? tryUrlPath(remoteUrl);
  if (rawPath === null) return null;
  const project = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return project.length > 0 ? project : null;
}

function tryUrlPath(remoteUrl: string): string | null {
  try {
    return new URL(remoteUrl).pathname;
  } catch {
    return null;
  }
}

/**
 * Git context is best-effort decoration: any failure — git missing, not a repo, a hung
 * command — degrades to `null` rather than surfacing. The timeout is stated as intent, so
 * the backend enforces it with its own kill (and a backend that cannot reports `timedOut`
 * without pretending it stopped anything).
 */
async function runGit(machine: Machine, cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await machine.run(["git", "-C", cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);
  if (result === undefined || result.timedOut || result.exitCode !== 0) return null;
  return result.stdout.trim();
}
