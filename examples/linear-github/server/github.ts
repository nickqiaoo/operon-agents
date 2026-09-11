// The server's own GitHub access: cloning and pushing (as git over HTTPS) and the pull request
// API. Credentials live here, in the server process, and never in the checkout: git gets a
// per-command `http.extraHeader` through the environment (`gitEnv`), so the remote URL in the
// clone stays bare and a token is never written to disk or shown on a command line.
//
// One credential, any repository the credential reaches: every method names the repository it
// acts on, so one server serves every repository its GitHub App is installed on. The interface is
// what the tool and the checkout need; the tests stub it with a local bare repository and an
// in-memory PR list.

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly body: string | null;
}

export interface GitHubApi {
  /** Where `git clone` and `git push` go. */
  cloneUrl(repo: RepoRef): string;
  /** Environment overrides for a git command that must authenticate against `cloneUrl()`:
   *  a fresh token as an `http.extraHeader`, or nothing for a remote that needs none. */
  gitEnv(): Promise<Record<string, string>>;
  defaultBranch(repo: RepoRef): Promise<string>;
  /** The open PR whose head is `branch`, if any. */
  findPullRequest(repo: RepoRef, branch: string): Promise<PullRequest | undefined>;
  createPullRequest(repo: RepoRef, input: { title: string; body: string; head: string; base: string }): Promise<PullRequest>;
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequest | undefined>;
  /** Whether a GitHub login may steer the agent from a PR comment: write access to the repo. */
  canSteer(repo: RepoRef, login: string): Promise<boolean>;
}

/** `owner/name` -> ref. The same string is a session's environment id and the workspace marker's `repo`. */
export function parseRepo(full: string): RepoRef {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(full.trim());
  if (!match) throw new Error(`expected a repository as "owner/name", got "${full}"`);
  return { owner: match[1]!, name: match[2]! };
}

export function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/** `http.extraHeader` for one git command, via git's environment-config protocol (git ≥ 2.31):
 *  never on the command line, never in `.git/config`. */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

class OctokitGitHub implements GitHubApi {
  private readonly octokit: Octokit;
  private readonly token: () => Promise<string>;
  private readonly branches = new Map<string, string>();

  constructor(octokit: Octokit, token: () => Promise<string>) {
    this.octokit = octokit;
    this.token = token;
  }

  cloneUrl(repo: RepoRef): string {
    return `https://github.com/${repo.owner}/${repo.name}.git`;
  }

  async gitEnv(): Promise<Record<string, string>> {
    return gitAuthEnv(await this.token());
  }

  async defaultBranch(repo: RepoRef): Promise<string> {
    const key = formatRepo(repo);
    let branch = this.branches.get(key);
    if (branch === undefined) {
      const { data } = await this.octokit.rest.repos.get({ owner: repo.owner, repo: repo.name });
      branch = data.default_branch;
      this.branches.set(key, branch);
    }
    return branch;
  }

  async findPullRequest(repo: RepoRef, branch: string): Promise<PullRequest | undefined> {
    const { data } = await this.octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.name,
      state: "open",
      head: `${repo.owner}:${branch}`,
      per_page: 1,
    });
    const pr = data[0];
    return pr ? { number: pr.number, url: pr.html_url, head: pr.head.ref, body: pr.body } : undefined;
  }

  async createPullRequest(repo: RepoRef, input: { title: string; body: string; head: string; base: string }): Promise<PullRequest> {
    const { data } = await this.octokit.rest.pulls.create({ owner: repo.owner, repo: repo.name, ...input });
    return { number: data.number, url: data.html_url, head: data.head.ref, body: data.body };
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequest | undefined> {
    try {
      const { data } = await this.octokit.rest.pulls.get({ owner: repo.owner, repo: repo.name, pull_number: number });
      return { number: data.number, url: data.html_url, head: data.head.ref, body: data.body };
    } catch (err) {
      if ((err as { status?: number }).status === 404) return undefined;
      throw err;
    }
  }

  async canSteer(repo: RepoRef, login: string): Promise<boolean> {
    try {
      const { data } = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: repo.owner,
        repo: repo.name,
        username: login,
      });
      return WRITE_PERMISSIONS.has(data.permission);
    } catch (err) {
      // 404: not a collaborator at all.
      if ((err as { status?: number }).status === 404) return false;
      throw err;
    }
  }
}

/** A GitHub App installation (GITHUB_APP_ID / GITHUB_PRIVATE_KEY / GITHUB_INSTALLATION_ID) or,
 *  for a quick start, a personal access token (GITHUB_TOKEN). The repositories it can work on
 *  are the ones the installation (or the token) reaches; there is no list to maintain here. */
export function githubFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubApi {
  if (env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID) {
    const auth = {
      appId: env.GITHUB_APP_ID,
      // A key pasted into .env arrives with literal "\n" sequences.
      privateKey: env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
      installationId: Number(env.GITHUB_INSTALLATION_ID),
    };
    const octokit = new Octokit({ authStrategy: createAppAuth, auth });
    // Installation tokens expire after an hour; auth() caches and renews.
    const token = async () => ((await octokit.auth({ type: "installation" })) as { token: string }).token;
    return new OctokitGitHub(octokit, token);
  }
  if (env.GITHUB_TOKEN) {
    const token = env.GITHUB_TOKEN;
    return new OctokitGitHub(new Octokit({ auth: token }), async () => token);
  }
  throw new Error("set GITHUB_APP_ID + GITHUB_PRIVATE_KEY + GITHUB_INSTALLATION_ID, or GITHUB_TOKEN");
}
