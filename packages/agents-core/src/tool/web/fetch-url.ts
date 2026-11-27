import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolAccesses } from "../access.ts";
import type { Tool, ToolResult } from "../types.ts";
import { WebToolError, type UrlFetchProvider, type UrlFetchResult } from "./types.ts";

const DEFAULT_MAX_LENGTH = 50_000;
const MAX_LENGTH_CAP = 100_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CACHE_ENTRIES = 16;

const WebFetchInput = z.object({
  url: z.string().url().describe("The URL to fetch content from."),
  max_length: z
    .number()
    .int()
    .min(1)
    .max(MAX_LENGTH_CAP)
    .optional()
    .describe(`Return at most this many characters (default ${DEFAULT_MAX_LENGTH}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Character position to start from (default 0). To keep reading a page that was cut off, pass the offset the previous result gave."),
});

export interface WebFetchToolOptions {
  /**
   * How long a fetched page is reused — paging through it with `offset` reads one copy instead of
   * fetching (and paying for) it again, and the offsets stay valid on a page that changes. The
   * cache lives with this tool instance: build one tool per session to keep sessions apart.
   * `0` disables it. Default 15 minutes.
   */
  readonly cacheTtlMs?: number;
  /** Pages kept at once, least recently used dropped first. Default 16. */
  readonly cacheEntries?: number;
}

export function webFetchTool(provider: UrlFetchProvider, options: WebFetchToolOptions = {}): Tool {
  const cache = new PageCache(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, options.cacheEntries ?? DEFAULT_CACHE_ENTRIES);
  return defineTool({
    name: "WebFetch",
    description:
      "Fetch a single URL and return its main content as text/markdown. Use after WebSearch, or " +
      "for a known link. Returns the extracted readable body, not raw HTML. Long pages come back " +
      "in parts; continue with offset.",
    parameters: WebFetchInput,
    resolve: (args) => ({
      accesses: ToolAccesses.none(),
      approvalRule: "WebFetch",
      matchesRule: (rulePattern) => ruleMatchesUrl(rulePattern, args.url),
      display: { title: args.offset ? `Fetching ${args.url} (from ${args.offset})` : `Fetching ${args.url}`, url: args.url },
      run: async (ctx): Promise<ToolResult> => {
        try {
          const result = await cache.get(args.url, () => provider.fetch(args.url, { signal: ctx.signal }));
          return { content: [{ type: "text", text: render(result, args.offset ?? 0, args.max_length ?? DEFAULT_MAX_LENGTH) }] };
        } catch (error) {
          return { content: [{ type: "text", text: errorText(error) }], isError: true };
        }
      },
    }),
  });
}

function render(result: UrlFetchResult, offset: number, maxLength: number): string {
  const header = result.title ? `# ${result.title}\nURL: ${result.url}\n\n` : `URL: ${result.url}\n\n`;
  const total = result.content.length;
  if (offset > 0 && offset >= total) {
    return `${header}[offset ${offset} is past the end of this page, which has ${total} characters.]`;
  }
  const end = Math.min(total, offset + maxLength);
  const body = result.content.slice(offset, end);
  if (end < total) {
    return `${header}${body}\n\n[Showing characters ${offset}–${end} of ${total}. To continue, call WebFetch again with offset=${end}.]`;
  }
  if (offset > 0) return `${header}${body}\n\n[Showing characters ${offset}–${end} of ${total}; this is the end of the page.]`;
  return header + body;
}

/** Fetched pages by requested URL. Holds the promise, so concurrent reads of one page fetch it once. */
class PageCache {
  private readonly entries = new Map<string, { readonly page: Promise<UrlFetchResult>; readonly at: number }>();
  private readonly ttlMs: number;
  private readonly capacity: number;

  constructor(ttlMs: number, capacity: number) {
    this.ttlMs = ttlMs;
    this.capacity = capacity;
  }

  async get(url: string, load: () => Promise<UrlFetchResult>): Promise<UrlFetchResult> {
    if (this.ttlMs <= 0 || this.capacity <= 0) return load();
    const now = Date.now();
    const hit = this.entries.get(url);
    if (hit !== undefined && now - hit.at < this.ttlMs) {
      this.entries.delete(url);
      this.entries.set(url, hit);
      return hit.page;
    }
    const page = load();
    this.entries.delete(url);
    this.entries.set(url, { page, at: now });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
    // A failure is not a page: the next call should try again, not be handed the same error.
    page.catch(() => {
      if (this.entries.get(url)?.page === page) this.entries.delete(url);
    });
    return page;
  }
}

function ruleMatchesUrl(pattern: string, url: string): boolean {
  const subject = pattern;
  if (subject === "*" || subject === url) return true;
  // Bare-host rule (e.g. "example.com") matches the URL's host.
  try {
    return new URL(url).host === subject;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  if (error instanceof WebToolError) return error.message;
  return `Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
}
