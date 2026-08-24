import path from "node:path";
import type { PluginGithubRef } from "./types.ts";

export type ResolvedSource =
  | { readonly kind: "local-path"; readonly path: string }
  | { readonly kind: "zip-url"; readonly path: string }
  | {
      readonly kind: "github";
      readonly owner: string;
      readonly repo: string;
      readonly ref?: PluginGithubRef;
      // Subdirectory within the repo holding the plugin (monorepo layout, e.g. openai/plugins).
      // Encoded as a `#path=<subdir>` URL fragment so it doesn't collide with `/tree/<ref>` parsing.
      readonly subdir?: string;
    };

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function resolveInstallSource(source: string): ResolvedSource {
  const trimmed = source.trim();
  const github = parseGithubUrl(trimmed);
  if (github !== undefined) return github;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return { kind: "zip-url", path: trimmed };
  if (!path.isAbsolute(trimmed)) throw new Error(`Plugin root must be an absolute path (got "${source}")`);
  return { kind: "local-path", path: trimmed };
}

function parseGithubUrl(raw: string): ResolvedSource | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const owner = segments[0];
  const repoRaw = segments[1];
  if (owner === undefined || repoRaw === undefined) return undefined;

  const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
  // `#path=<subdir>` selects a plugin inside a monorepo (separate from the ref in the path).
  const subdir = parseSubdir(url.hash);
  const withSubdir = (base: ResolvedSource & { kind: "github" }): ResolvedSource =>
    subdir !== undefined ? { ...base, subdir } : base;
  const rest = segments.slice(2);
  if (rest.length === 0) return withSubdir({ kind: "github", owner, repo });

  const head = rest[0];
  const second = rest[1];

  if (head === "tree" && rest.length >= 2) {
    const refValue = decodeRefSegments(rest.slice(1));
    const kind: PluginGithubRef["kind"] = SHA_RE.test(refValue) ? "sha" : "branch";
    return withSubdir({ kind: "github", owner, repo, ref: { kind, value: refValue } });
  }
  if (head === "releases" && second === "tag" && rest.length >= 3) {
    return withSubdir({ kind: "github", owner, repo, ref: { kind: "tag", value: decodeRefSegments(rest.slice(2)) } });
  }
  if (head === "commit" && rest.length >= 2) {
    return withSubdir({ kind: "github", owner, repo, ref: { kind: "sha", value: decodeRefSegments(rest.slice(1)) } });
  }
  return undefined; // /archive/... and other paths → fall through to zip-url
}

/**
 * A repo-relative plugin subdir must stay inside the cached repo. Dropping `.`/`..`/empty
 * segments makes escape arithmetically impossible — a crafted `#path=../../../etc` (or a
 * marketplace `path`) collapses to an in-repo path instead of resolving to an outside dir
 * that then gets read as a plugin. Same containment intent as archive.ts's zip-slip guard.
 */
export function sanitizeSubdir(raw: string): string {
  return raw
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
}

function parseSubdir(hash: string): string | undefined {
  if (hash.length === 0) return undefined;
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const value = params.get("path")?.trim();
  if (value === undefined || value.length === 0) return undefined;
  const safe = sanitizeSubdir(value);
  return safe.length > 0 ? safe : undefined;
}

function decodeRefSegments(segments: readonly string[]): string {
  return segments
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}
