/**
 * Provider-agnostic tool-search core — the "one core" of deferred tool loading.
 *
 * When an agent has many tools (MCP / capability sprawl), most are marked
 * *deferred*: kept in Operon's execution catalog but out of the model's active
 * context. The model calls SearchTool to discover the few it needs; matches
 * are recorded as `ToolResultMessage.addedToolNames`, and pi 0.81 handles the
 * provider-specific transcript representation.
 *
 * This module holds only the pieces that don't depend on any provider: the
 * keyword search, the query DSL,
 * and query parsing. Transcript folding lives in the agent toolset.
 */
import type { ToolSchema } from "../../protocol/index.ts";

/** Provider-neutral name of the caller-supplied search tool. */
export const SEARCH_TOOL_NAME = "SearchTool";

/** Split a tool name into searchable parts. Handles MCP tools
 *  (`mcp__server__action`) and CamelCase/underscore names. */
function parseToolName(name: string): { parts: string[]; full: string; isMcp: boolean } {
  if (name.startsWith("mcp__")) {
    const withoutPrefix = name.replace(/^mcp__/, "").toLowerCase();
    const parts = withoutPrefix.split("__").flatMap((p) => p.split("_"));
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, " ").replace(/_/g, " "),
      isMcp: true,
    };
  }
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return { parts, full: parts.join(" "), isMcp: false };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTermPatterns(terms: readonly string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const term of terms) {
    if (!patterns.has(term)) patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
  }
  return patterns;
}

/**
 * Keyword search over deferred tool names + descriptions. Scoring uses name
 * parts and the description only — `ToolSchema` carries no dedicated search
 * hint field yet.
 *
 * Query forms:
 *  - `select:A,B,C` — direct multi-select by exact name (handled by the caller
 *    before this function; a bare exact name here also fast-paths).
 *  - `notebook jupyter` — keyword search.
 *  - `+slack send` — `+`-prefixed terms are required; the rest rank.
 */
export function searchDeferredTools(
  query: string,
  deferred: readonly ToolSchema[],
  maxResults = 5,
): string[] {
  const queryLower = query.toLowerCase().trim();

  // Fast path: exact name match (bare name instead of `select:` — seen from
  // subagents / post-compaction). Selecting an already-loaded tool is harmless.
  const exact = deferred.find((t) => t.name.toLowerCase() === queryLower);
  if (exact) return [exact.name];

  // MCP prefix search (`mcp__server`).
  if (queryLower.startsWith("mcp__") && queryLower.length > 5) {
    const prefix = deferred
      .filter((t) => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((t) => t.name);
    if (prefix.length > 0) return prefix;
  }

  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0);
  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of queryTerms) {
    if (term.startsWith("+") && term.length > 1) requiredTerms.push(term.slice(1));
    else optionalTerms.push(term);
  }
  const scoringTerms = requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms;
  const patterns = compileTermPatterns(scoringTerms);

  // Pre-filter to tools matching ALL required terms.
  let candidates = deferred;
  if (requiredTerms.length > 0) {
    candidates = deferred.filter((tool) => {
      const parsed = parseToolName(tool.name);
      const desc = tool.description.toLowerCase();
      return requiredTerms.every((term) => {
        const pattern = patterns.get(term)!;
        return (
          parsed.parts.includes(term) ||
          parsed.parts.some((part) => part.includes(term)) ||
          pattern.test(desc)
        );
      });
    });
  }

  const scored = candidates.map((tool) => {
    const parsed = parseToolName(tool.name);
    const desc = tool.description.toLowerCase();
    let score = 0;
    for (const term of scoringTerms) {
      const pattern = patterns.get(term)!;
      if (parsed.parts.includes(term)) score += parsed.isMcp ? 12 : 10;
      else if (parsed.parts.some((part) => part.includes(term))) score += parsed.isMcp ? 6 : 5;
      if (parsed.full.includes(term) && score === 0) score += 3;
      if (pattern.test(desc)) score += 2;
    }
    return { name: tool.name, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.name);
}

/** Result of running the SearchTool query DSL against a deferred catalog. */
export interface SearchOutcome {
  readonly matches: string[];
  readonly queryType: "select" | "keyword";
}

/** Run the full query DSL (`select:` direct-select vs keyword search) against
 *  the deferred catalog. */
export function runSearchQuery(
  query: string,
  deferred: readonly ToolSchema[],
  maxResults = 5,
): SearchOutcome {
  const selectMatch = query.match(/^select:(.+)$/i);
  if (selectMatch) {
    const requested = selectMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const found: string[] = [];
    for (const name of requested) {
      const tool = deferred.find((t) => t.name === name) ?? deferred.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (tool && !found.includes(tool.name)) found.push(tool.name);
    }
    return { matches: found, queryType: "select" };
  }
  return { matches: searchDeferredTools(query, deferred, maxResults), queryType: "keyword" };
}
