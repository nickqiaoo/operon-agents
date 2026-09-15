import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { downloadZip, extractZip } from "./archive.ts";
import { describeIssue, optionalText, optionalTextList } from "./fields.ts";
import { codeloadZipUrl } from "./github-resolver.ts";
import { resolveInstallSource, sanitizeSubdir } from "./source.ts";
import type { PluginGithubRef } from "./types.ts";

/**
 * Plugin marketplace = a github plugin repo (Codex format, e.g. github.com/openai/plugins). The repo
 * IS the registry: `.agents/plugins/marketplace.json` lists plugins, each living in a subdir with its
 * own `.codex-plugin/plugin.json`. The repo is cached ONCE (see `materializeGithubRepo`) and then the
 * index + plugins are read from the local copy — no per-plugin downloads, no raw fetches.
 *
 * This module is the neutral *mechanism*: it hardcodes NO repo, NO curation, renders no UI. Only the
 * Codex schema is accepted — an entry's `source` is an object `{ source: "local"|"git-subdir"|"url",
 * … }`. (The legacy operon string-source schema was removed: nobody published those.)
 */
export interface MarketplaceEntry {
  readonly id: string;
  readonly displayName: string;
  /** Install source — for a `local` Codex entry, an absolute path inside the cached repo. */
  readonly source: string;
  readonly tier?: string;
  readonly version?: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
}

export interface Marketplace {
  /** The source the registry was loaded from (the github repo ref). */
  readonly source: string;
  readonly version?: string;
  readonly plugins: readonly MarketplaceEntry[];
}

export interface LoadMarketplaceOptions {
  /** The marketplace github repo: `owner/repo[@ref]` shorthand or a github.com repo URL. */
  readonly source: string;
  /**
   * Local directory the repo has been materialized (cached) into — see `materializeGithubRepo`. The
   * index is read from `<repoDir>/.agents/plugins/marketplace.json` and each `local` entry resolves
   * to an absolute path under `<repoDir>` (so installing it is a local copy, not a download).
   */
  readonly repoDir: string;
}

// The registry, materialized locally: index + plugins are read from `repoRoot`.
interface MarketplaceLocation {
  readonly repoRoot: string;
  readonly source: string;
}

// Codex's marketplace index path inside a repo.
const CODEX_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";

/** Read + validate a marketplace registry from a cached github repo. */
export async function loadMarketplace(options: LoadMarketplaceOptions): Promise<Marketplace> {
  const location = resolveLocation(options.source, options.repoDir);
  const raw = await readFile(join(location.repoRoot, CODEX_MARKETPLACE_PATH), "utf8");
  return parseMarketplace(raw, location);
}

/**
 * Download a github repo's ZIP archive (one request) and extract it into `destDir`, returning the
 * extracted repo root. For a monorepo marketplace this is fetched ONCE and then both browsing and
 * installing read from the local copy — instead of re-downloading the whole repo per plugin. The
 * caller owns `destDir` (and any caching/refresh policy); pass a fresh/empty dir.
 */
export async function materializeGithubRepo(options: {
  readonly owner: string;
  readonly repo: string;
  readonly ref?: string;
  readonly destDir: string;
}): Promise<string> {
  const ref: PluginGithubRef = { kind: "branch", value: options.ref ?? "HEAD" };
  const buffer = await downloadZip(codeloadZipUrl(options.owner, options.repo, ref));
  return extractZip(buffer, options.destDir);
}

/** Codex source object: { source: "local"|"git-subdir"|"url", path|url, ref|sha }. */
const CodexSourceSchema = z.object({
  source: optionalText,
  path: optionalText,
  url: optionalText,
  ref: optionalText,
  sha: optionalText,
});

const MarketplaceEntrySchema = z.object({
  id: optionalText,
  name: optionalText,
  displayName: optionalText,
  source: CodexSourceSchema,
  tier: optionalText,
  version: optionalText,
  description: optionalText,
  shortDescription: optionalText,
  homepage: optionalText,
  websiteURL: optionalText,
  keywords: optionalTextList,
});

const MarketplaceSchema = z.object({
  version: optionalText,
  plugins: z.array(MarketplaceEntrySchema),
});

/** Parse + validate a marketplace registry string against a cached repo location. */
export function parseMarketplace(raw: string, location: MarketplaceLocation): Marketplace {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Plugin marketplace is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = MarketplaceSchema.safeParse(json);
  if (!parsed.success) {
    throw new TypeError(`Plugin marketplace is malformed: ${parsed.error.issues.map(describeIssue).join("; ")}`);
  }
  return {
    source: location.source,
    version: parsed.data.version,
    plugins: parsed.data.plugins.map((entry, index) => toEntry(entry, index, location)),
  };
}

function resolveLocation(source: string, repoDir: string): MarketplaceLocation {
  const trimmed = source.trim();
  if (trimmed.length === 0) throw new Error("Plugin marketplace source cannot be empty.");
  if (parseGithubMarketplaceSource(trimmed) === undefined) {
    throw new Error(`Plugin marketplace must be a github repo (got "${trimmed}").`);
  }
  return { repoRoot: repoDir, source: trimmed };
}

/**
 * Recognise a github repo marketplace reference: `owner/repo[@ref]` shorthand or a github.com repo
 * URL. Returns the repo coordinates (so a caller can cache the repo) or undefined for non-repo
 * sources. Exported so embedders can validate config + cache the repo.
 */
export function parseGithubMarketplaceSource(source: string): { owner: string; repo: string; ref?: string } | undefined {
  if (source.startsWith("https://github.com/") || source.startsWith("http://github.com/")) {
    const url = new URL(source);
    const seg = url.pathname.split("/").filter((s) => s.length > 0);
    if (seg.length < 2) return undefined;
    const owner = seg[0]!;
    const repo = (seg[1] ?? "").replace(/\.git$/, "");
    // A repo root, or `/tree/<ref>` — anything pointing at a deeper file isn't a repo registry ref.
    if (seg.length === 2) return { owner, repo };
    if (seg[2] === "tree" && seg.length >= 4) return { owner, repo, ref: seg.slice(3).join("/") };
    return undefined;
  }
  // Shorthand `owner/repo` / `owner/repo@ref`. Exclude local paths and direct .json files.
  if (source.includes("://") || source.startsWith(".") || source.startsWith("/") || source.startsWith("~") || source.endsWith(".json")) {
    return undefined;
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:@(.+))?$/.exec(source);
  if (m === null) return undefined;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ""), ...(m[3] ? { ref: m[3] } : {}) };
}

function toEntry(value: z.output<typeof MarketplaceEntrySchema>, index: number, location: MarketplaceLocation): MarketplaceEntry {
  const id = value.id ?? value.name;
  if (id === undefined) throw new Error(`Plugin marketplace entry ${index + 1} must define "id" or "name".`);
  return {
    id,
    displayName: value.displayName ?? value.name ?? id,
    source: resolveCodexSource(value.source, location, id),
    tier: value.tier,
    version: value.version,
    description: value.description ?? value.shortDescription,
    homepage: value.homepage ?? value.websiteURL,
    keywords: value.keywords,
  };
}

function resolveCodexSource(obj: z.output<typeof CodexSourceSchema>, location: MarketplaceLocation, id: string): string {
  const kind = obj.source;
  const path = obj.path;
  if (kind === "local" || (kind === undefined && path !== undefined)) {
    if (path === undefined) throw new Error(`Plugin marketplace entry ${id}: local source requires "path".`);
    // `local` is relative to the repo ROOT → absolute path in the cached repo (install = local copy).
    return join(location.repoRoot, cleanSubdir(path));
  }
  if (kind === "git-subdir") {
    const url = obj.url;
    if (url === undefined) throw new Error(`Plugin marketplace entry ${id}: git-subdir source requires "url".`);
    const ref = obj.ref ?? obj.sha ?? "HEAD";
    const sub = path !== undefined ? cleanSubdir(path) : undefined;
    const base = `${stripTrailingSlash(url)}/tree/${ref}`;
    return sub !== undefined ? `${base}#path=${sub}` : base;
  }
  if (kind === "url") {
    const url = obj.url ?? path;
    if (url === undefined) throw new Error(`Plugin marketplace entry ${id}: url source requires "url".`);
    return url;
  }
  throw new Error(`Plugin marketplace entry ${id}: unsupported source kind "${kind ?? "(none)"}".`);
}

function cleanSubdir(p: string): string {
  // Drops `..`/`.`/empty segments too — a marketplace `local.path: "../../home/user/.ssh"`
  // must not resolve outside the cached repo root (see sanitizeSubdir).
  return sanitizeSubdir(p.trim());
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/$/, "");
}

// ── Per-entry detail enrichment (logo / description) ─────────────────────────
//
// A marketplace registry lists only id/name/source/category — the rich metadata (display name,
// description, logo, brand colour) lives in each plugin's OWN manifest. We read it from the CACHED
// repo on disk (no network). Only `local` entries (absolute paths in the cache) are enriched; a
// git-subdir/url entry points elsewhere and returns null (no logo in browse). Never throws.

/** Rich, displayable metadata for a single marketplace entry, read from its plugin manifest. */
export interface MarketplaceEntryDetails {
  readonly displayName?: string;
  readonly description?: string;
  /** Absolute https URL to the logo, if the manifest gives one directly. */
  readonly logoUrl?: string;
  /** Absolute local file path to the logo (cached repo) — the embedder serves this. */
  readonly logoPath?: string;
  readonly brandColor?: string;
}

// Manifest filenames to try, in order (Codex first, then operon). Mirrors plugins/manifest.ts.
const ENTRY_MANIFEST_CANDIDATES = [".codex-plugin/plugin.json", "agents.plugin.json", ".agents-plugin/plugin.json"];

/**
 * Read displayable details (logo/description) for one marketplace entry from its plugin manifest in
 * the cached repo. `source` is the entry's install source; only a local plugin dir is enrichable.
 * Returns null when the source isn't local or no manifest/fields are found ("no extras").
 */
export async function loadMarketplaceEntryDetails(source: string): Promise<MarketplaceEntryDetails | null> {
  const resolved = resolveInstallSource(source);
  if (resolved.kind !== "local-path") return null;
  for (const candidate of ENTRY_MANIFEST_CANDIDATES) {
    try {
      const manifest = DetailsManifestSchema.safeParse(JSON.parse(await readFile(join(resolved.path, candidate), "utf8")));
      if (!manifest.success) continue;
      return extractEntryDetails(manifest.data, resolved.path);
    } catch {
      // Missing/parse error for this candidate — try the next, then give up (null).
    }
  }
  return null;
}

// Display metadata only: a field of the wrong type is ignored, never a reason to hide the entry.
const lenientText = optionalText.catch(undefined);
const DetailsManifestSchema = z.looseObject({
  interface: z
    .looseObject({
      displayName: lenientText,
      shortDescription: lenientText,
      longDescription: lenientText,
      logo: lenientText,
      composerIcon: lenientText,
      brandColor: lenientText,
    })
    .catch({}),
  displayName: lenientText,
  name: lenientText,
  description: lenientText,
  logo: lenientText,
  icon: lenientText,
});

function extractEntryDetails(manifest: z.output<typeof DetailsManifestSchema>, dir: string): MarketplaceEntryDetails {
  // Codex puts the user-facing fields under `interface`; operon uses top-level fields.
  const iface = manifest.interface;
  const displayName = iface.displayName ?? manifest.displayName ?? manifest.name;
  const description = iface.shortDescription ?? iface.longDescription ?? manifest.description;
  const logoRel = iface.logo ?? iface.composerIcon ?? manifest.logo ?? manifest.icon;
  const brandColor = iface.brandColor;

  let logoUrl: string | undefined;
  let logoPath: string | undefined;
  if (logoRel !== undefined) {
    if (/^https?:\/\//.test(logoRel)) logoUrl = logoRel;
    else logoPath = join(dir, logoRel.replace(/^\.?\/+/, ""));
  }

  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    ...(logoPath !== undefined ? { logoPath } : {}),
    ...(brandColor !== undefined ? { brandColor } : {}),
  };
}
