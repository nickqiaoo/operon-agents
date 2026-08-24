import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { downloadZip, extractZip } from "./archive.ts";
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

/** Parse + validate a marketplace registry string against a cached repo location. */
export function parseMarketplace(raw: string, location: MarketplaceLocation): Marketplace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Plugin marketplace is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new TypeError("Plugin marketplace must be an object.");
  const rawPlugins = parsed["plugins"];
  if (!Array.isArray(rawPlugins)) throw new TypeError('Plugin marketplace must contain a "plugins" array.');
  return {
    source: location.source,
    version: stringField(parsed, "version"),
    plugins: rawPlugins.map((entry, index) => parseEntry(entry, index, location)),
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

function parseEntry(value: unknown, index: number, location: MarketplaceLocation): MarketplaceEntry {
  if (!isRecord(value)) throw new TypeError(`Plugin marketplace entry ${index + 1} must be an object.`);
  const id = stringField(value, "id") ?? stringField(value, "name");
  if (id === undefined) throw new Error(`Plugin marketplace entry ${index + 1} must define "id" or "name".`);
  return {
    id,
    displayName: stringField(value, "displayName") ?? stringField(value, "name") ?? id,
    source: resolveSource(value, location, id),
    tier: stringField(value, "tier"),
    version: stringField(value, "version"),
    description: stringField(value, "description") ?? stringField(value, "shortDescription"),
    homepage: stringField(value, "homepage") ?? stringField(value, "websiteURL"),
    keywords: stringArrayField(value, "keywords"),
  };
}

function resolveSource(value: Record<string, unknown>, location: MarketplaceLocation, id: string): string {
  const raw = value["source"];
  if (!isRecord(raw)) throw new Error(`Plugin marketplace entry ${id} must define an object "source" (Codex format).`);
  return resolveCodexSource(raw, location, id);
}

/** Codex source object: { source: "local"|"git-subdir"|"url", path|url, ref|sha }. */
function resolveCodexSource(obj: Record<string, unknown>, location: MarketplaceLocation, id: string): string {
  const kind = stringField(obj, "source");
  const path = stringField(obj, "path");
  if (kind === "local" || (kind === undefined && path !== undefined)) {
    if (path === undefined) throw new Error(`Plugin marketplace entry ${id}: local source requires "path".`);
    // `local` is relative to the repo ROOT → absolute path in the cached repo (install = local copy).
    return join(location.repoRoot, cleanSubdir(path));
  }
  if (kind === "git-subdir") {
    const url = stringField(obj, "url");
    if (url === undefined) throw new Error(`Plugin marketplace entry ${id}: git-subdir source requires "url".`);
    const ref = stringField(obj, "ref") ?? stringField(obj, "sha") ?? "HEAD";
    const sub = path !== undefined ? cleanSubdir(path) : undefined;
    const base = `${stripTrailingSlash(url)}/tree/${ref}`;
    return sub !== undefined ? `${base}#path=${sub}` : base;
  }
  if (kind === "url") {
    const url = stringField(obj, "url") ?? path;
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

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArrayField(value: Record<string, unknown>, field: string): readonly string[] | undefined {
  const raw = value[field];
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0);
  return out.length > 0 ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      const manifest: unknown = JSON.parse(await readFile(join(resolved.path, candidate), "utf8"));
      if (!isRecord(manifest)) continue;
      return extractEntryDetails(manifest, resolved.path);
    } catch {
      // Missing/parse error for this candidate — try the next, then give up (null).
    }
  }
  return null;
}

function extractEntryDetails(manifest: Record<string, unknown>, dir: string): MarketplaceEntryDetails {
  // Codex puts the user-facing fields under `interface`; operon uses top-level fields.
  const iface = isRecord(manifest["interface"]) ? manifest["interface"] : {};
  const displayName = stringField(iface, "displayName") ?? stringField(manifest, "displayName") ?? stringField(manifest, "name");
  const description =
    stringField(iface, "shortDescription") ?? stringField(iface, "longDescription") ?? stringField(manifest, "description");
  const logoRel =
    stringField(iface, "logo") ?? stringField(iface, "composerIcon") ?? stringField(manifest, "logo") ?? stringField(manifest, "icon");
  const brandColor = stringField(iface, "brandColor");

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
