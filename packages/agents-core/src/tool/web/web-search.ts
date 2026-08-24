import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolAccesses } from "../access.ts";
import type { Tool, ToolResult } from "../types.ts";
import { WebToolError, type WebSearchProvider, type WebSearchResult } from "./types.ts";

const WebSearchInput = z.object({
  query: z.string().min(1).describe("The query text to search for."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Number of results (default 5). Prefer a more concrete query over a large limit."),
  include_content: z
    .boolean()
    .optional()
    .describe("Include each page's full content. Token-heavy; avoid with a large limit."),
});

export function webSearchTool(provider: WebSearchProvider): Tool {
  return defineTool({
    name: "WebSearch",
    description:
      "Search the web and return ranked results (title, URL, snippet). Use it for current facts, " +
      "documentation, or to find pages to FetchURL. Set include_content to pull full page text.",
    params: WebSearchInput,
    resolve: (args) => {
      const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
      return {
        accesses: ToolAccesses.none(),
        approvalRule: "WebSearch",
        display: { title: `Searching: ${preview}` },
        run: async (ctx): Promise<ToolResult> => {
          try {
            const results = await provider.search(args.query, {
              limit: args.limit,
              includeContent: args.include_content,
              signal: ctx.signal,
            });
            return { content: [{ type: "text", text: formatResults(results) }] };
          } catch (error) {
            return { content: [{ type: "text", text: errorText(error) }], isError: true };
          }
        },
      };
    },
  });
}

function formatResults(results: readonly WebSearchResult[]): string {
  if (results.length === 0) return "No search results found.";
  const blocks: string[] = [];
  for (const r of results) {
    const lines = [`Title: ${r.title}`];
    if (r.date) lines.push(`Date: ${r.date}`);
    lines.push(`URL: ${r.url}`, `Snippet: ${r.snippet}`);
    if (r.content) lines.push("", r.content);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n---\n\n");
}

function errorText(error: unknown): string {
  if (error instanceof WebToolError) return error.message;
  return `Web search failed: ${error instanceof Error ? error.message : String(error)}`;
}
