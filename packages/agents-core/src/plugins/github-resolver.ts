import type { PluginGithubRef } from "./types.ts";

export interface GithubResolution {
  readonly zipUrl: string;
  readonly ref: PluginGithubRef;
}

export interface GithubSourceInput {
  readonly owner: string;
  readonly repo: string;
  readonly ref?: PluginGithubRef;
}

export async function resolveGithubSource(input: GithubSourceInput): Promise<GithubResolution> {
  const ref = input.ref ?? { kind: "branch", value: await defaultBranch(input.owner, input.repo) };
  return { zipUrl: codeloadZipUrl(input.owner, input.repo, ref), ref };
}

export function codeloadZipUrl(owner: string, repo: string, ref: PluginGithubRef): string {
  const value = ref.value.split("/").map(encodeURIComponent).join("/");
  return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${value}`;
}

async function defaultBranch(owner: string, repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} resolving ${owner}/${repo} default branch`);
  const body = (await res.json()) as { default_branch?: string };
  if (typeof body.default_branch !== "string") throw new Error(`GitHub API returned no default_branch for ${owner}/${repo}`);
  return body.default_branch;
}
