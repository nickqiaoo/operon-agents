import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolAccesses } from "../access.ts";
import type { Tool, ToolResult } from "../types.ts";
import { WebToolError, type UrlFetchProvider } from "./types.ts";

const DEFAULT_MAX_LENGTH = 50_000;

const FetchURLInput = z.object({
  url: z.string().url().describe("The URL to fetch content from."),
  max_length: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Truncate the returned content to this many characters (default ${DEFAULT_MAX_LENGTH}).`),
});

export function fetchUrlTool(provider: UrlFetchProvider): Tool {
  return defineTool({
    name: "FetchURL",
    description:
      "Fetch a single URL and return its main content as text/markdown. Use after WebSearch, or " +
      "for a known link. Returns the extracted readable body, not raw HTML.",
    params: FetchURLInput,
    resolve: (args) => ({
      accesses: ToolAccesses.none(),
      approvalRule: "FetchURL",
      matchesRule: (rulePattern) => ruleMatchesUrl(rulePattern, args.url),
      display: { title: `Fetching ${args.url}` },
      run: async (ctx): Promise<ToolResult> => {
        try {
          const result = await provider.fetch(args.url, { signal: ctx.signal });
          const limit = args.max_length ?? DEFAULT_MAX_LENGTH;
          const body = result.content.length > limit ? `${result.content.slice(0, limit)}\n\n…[truncated]` : result.content;
          const header = result.title ? `# ${result.title}\nURL: ${result.url}\n\n` : `URL: ${result.url}\n\n`;
          return { content: [{ type: "text", text: header + body }] };
        } catch (error) {
          return { content: [{ type: "text", text: errorText(error) }], isError: true };
        }
      },
    }),
  });
}

function ruleMatchesUrl(pattern: string, url: string): boolean {
  const m = /^FetchURL\((.*)\)$/.exec(pattern);
  if (!m) return false;
  const subject = m[1]!;
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
