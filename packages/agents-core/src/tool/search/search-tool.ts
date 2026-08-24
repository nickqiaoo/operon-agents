/**
 * The SearchTool builtin — the model-facing half of deferred tool loading.
 *
 * Built per turn over a snapshot of the deferred catalog (in `buildRunTools`),
 * so it can search names/descriptions without needing the live tool registry
 * at call time. Its result exposes matches through pi 0.81's
 * `ToolResultMessage.addedToolNames`; pi materializes the provider-specific
 * re-entry envelope.
 */
import { z } from "zod";
import { tool } from "../define.ts";
import { ToolAccesses } from "../access.ts";
import type { Tool } from "../types.ts";
import type { ToolSchema } from "../../protocol/index.ts";
import { SEARCH_TOOL_NAME, runSearchQuery } from "./deferral.ts";

const SearchInput = z.object({
  query: z
    .string()
    .describe(
      'Query to find deferred tools. Use "select:<tool_name>" (comma-separated for multiple) for direct selection, or keywords to search. Prefix a term with "+" to require it.',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum number of results to return (default 5)."),
});

const DESCRIPTION = `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in <available-deferred-tools> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool matches your query against the deferred tool list and loads the matched tools' full definitions, after which they are callable exactly like the tools defined at the top of the prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;

/** Build the SearchTool over a snapshot of this turn's deferred catalog. The
 *  deferred names are listed in the description so the model knows what it can
 *  load. Names are sorted so the description stays byte-stable across turns
 *  (cacheable) while the deferred set is unchanged. (P1 moves this to
 *  diff-based `<available-deferred-tools>` announcements in history.) */
export function buildSearchTool(deferred: readonly ToolSchema[]): Tool {
  const names = deferred.map((s) => s.name).sort((a, b) => a.localeCompare(b));
  const description = `${DESCRIPTION}\n\n<available-deferred-tools>\n${names.join("\n")}\n</available-deferred-tools>`;
  return tool({
    name: SEARCH_TOOL_NAME,
    description,
    parameters: SearchInput,
    approvalRule: SEARCH_TOOL_NAME,
    accesses: ToolAccesses.none(),
    execute: (args) => {
      const { matches } = runSearchQuery(args.query, deferred, args.max_results ?? 5);
      return {
        content: [
          {
            type: "text",
            text: matches.length > 0 ? `Loaded tools: ${matches.join(", ")}` : "No matching deferred tools found.",
          },
        ],
        addedToolNames: matches,
      };
    },
  });
}
