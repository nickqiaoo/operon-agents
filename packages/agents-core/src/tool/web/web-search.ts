import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolAccesses } from "../access.ts";
import type { Tool, ToolResult } from "../types.ts";
import { WebToolError, type WebSearchProvider, type WebSearchRecency, type WebSearchResult } from "./types.ts";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** How many more results to ask for when WebSearch filters them itself, so enough survive. */
const EMULATION_OVERFETCH = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_MS: Record<WebSearchRecency, number> = { day: DAY_MS, week: 7 * DAY_MS, month: 31 * DAY_MS, year: 366 * DAY_MS };

const WebSearchInput = z.object({
  query: z.string().min(1).describe("The query text to search for."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Number of results (default ${DEFAULT_LIMIT}). Prefer a more concrete query over a large limit.`),
  include_content: z
    .boolean()
    .optional()
    .describe("Include each page's full content. Token-heavy; avoid with a large limit."),
  domains: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .optional()
    .describe('Only return results from these sites, e.g. ["docs.python.org"]. A domain also matches its subdomains.'),
  recency: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Only return results published within the last day, week, month or year."),
});

export function webSearchTool(provider: WebSearchProvider): Tool {
  return defineTool({
    name: "WebSearch",
    description:
      "Search the web and return ranked results (title, URL, snippet). Use it for current facts, " +
      "documentation, or to find pages to WebFetch. Set include_content to pull full page text; " +
      "use domains or recency to narrow the results.",
    parameters: WebSearchInput,
    resolve: (args) => {
      const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
      return {
        accesses: ToolAccesses.none(),
        approvalRule: "WebSearch",
        display: { title: `Searching: ${preview}`, query: args.query },
        run: async (ctx): Promise<ToolResult> => {
          try {
            const text = await search(provider, args, ctx.signal);
            return { content: [{ type: "text", text }] };
          } catch (error) {
            return { content: [{ type: "text", text: errorText(error) }], isError: true };
          }
        },
      };
    },
  });
}

async function search(provider: WebSearchProvider, args: z.output<typeof WebSearchInput>, signal: AbortSignal): Promise<string> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const domains = args.domains?.map(normalizeDomain).filter((d) => d.length > 0);
  const filterDomains = domains !== undefined && domains.length > 0;
  const nativeDomains = filterDomains && provider.supports?.domains === true;
  const nativeRecency = args.recency !== undefined && provider.supports?.recency === true;
  const emulating = (filterDomains && !nativeDomains) || (args.recency !== undefined && !nativeRecency);

  let results = await provider.search(args.query, {
    limit: emulating ? Math.min(MAX_LIMIT, limit * EMULATION_OVERFETCH) : limit,
    ...(args.include_content !== undefined ? { includeContent: args.include_content } : {}),
    ...(nativeDomains ? { domains } : {}),
    ...(nativeRecency ? { recency: args.recency } : {}),
    signal,
  });

  const notes: string[] = [];
  // Always enforced, even when the provider filtered: it is cheap, and it makes `domains` mean the
  // same thing for a provider that treats it as a hint.
  if (filterDomains) {
    results = results.filter((r) => hostMatches(r.url, domains));
    if (!nativeDomains) notes.push("This search provider cannot restrict sites itself; results from other sites were removed, so fewer may remain.");
  }
  if (args.recency !== undefined && !nativeRecency) {
    const cutoff = Date.now() - RECENCY_MS[args.recency];
    results = results.filter((r) => {
      const time = r.date === undefined ? Number.NaN : Date.parse(r.date);
      return Number.isNaN(time) || time >= cutoff;
    });
    const undated = results.filter((r) => r.date === undefined || Number.isNaN(Date.parse(r.date))).length;
    notes.push(
      `This search provider cannot filter by date itself; results older than one ${args.recency} were removed by publish date` +
        (undated > 0 ? `, and ${undated} without a date were kept.` : "."),
    );
  }
  return formatResults(results.slice(0, limit), notes);
}

/** `https://Docs.Example.com/x`, `*.example.com` and `example.com.` all name `docs.example.com`/`example.com`. */
function normalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  try {
    if (d.includes("://")) d = new URL(d).hostname;
  } catch {
    // Not a URL; treat it as a bare host.
  }
  return d.replace(/^\*\./, "").replace(/\/.*$/, "").replace(/\.$/, "");
}

function hostMatches(url: string, domains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function formatResults(results: readonly WebSearchResult[], notes: readonly string[]): string {
  const head = notes.map((n) => `Note: ${n}`).join("\n");
  if (results.length === 0) return head ? `No search results found.\n${head}` : "No search results found.";
  const blocks: string[] = [];
  for (const r of results) {
    const lines = [`Title: ${r.title}`];
    if (r.date) lines.push(`Date: ${r.date}`);
    lines.push(`URL: ${r.url}`, `Snippet: ${r.snippet}`);
    if (r.content) lines.push("", r.content);
    blocks.push(lines.join("\n"));
  }
  const body = blocks.join("\n\n---\n\n");
  return head ? `${head}\n\n${body}` : body;
}

function errorText(error: unknown): string {
  if (error instanceof WebToolError) return error.message;
  return `Web search failed: ${error instanceof Error ? error.message : String(error)}`;
}
