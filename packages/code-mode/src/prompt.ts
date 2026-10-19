/**
 * The RunCode tool description. This text IS the prompt — it teaches the model when a program
 * beats a run of direct calls, how to write one, and what it gets back. The tool declarations
 * are rendered into it per request (`extension.ts`), so the model programs against exactly
 * the tools this turn offers. Keep it in sync with `runtime-quickjs.ts` and `run-code-tool.ts`.
 */

export const RUN_CODE_NAME = "RunCode";

export const CODE_PARAM_DESCRIPTION =
  "The program: the body of an async TypeScript function. Raw source text — not JSON, not a quoted string, not a markdown code fence.";

export const DESCRIPTION_PARAM_DESCRIPTION =
  'Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: "Count TODO markers across packages"; "Read failing test and its fixture".';

export const BACKGROUND_PARAM_DESCRIPTION =
  "Run the program detached and return a task_id immediately — for a long program (polling, many slow tool calls) that should not hold the turn. Its console output and final result go to a log file whose path the result names; Read that file, and use BackgroundOutput(task_id) for its status. Requires the background capability.";

export interface RunCodePromptInput {
  /** The members of `declare const tools: { … }`, already rendered (see `declarations.ts`). */
  readonly declarations: string;
  readonly maxOutputBytes: number;
  /** True when the other tools are reachable only through a program (`hide: "all"`). */
  readonly hidesAll: boolean;
  /**
   * Present under `hide: "catalog"`: the declared tools are a budgeted slice of a larger set that
   * is reachable only through the program; `shown` of `total` are declared below.
   */
  readonly catalog?: { readonly shown: number; readonly total: number };
}

export function runCodeDescription(input: RunCodePromptInput): string {
  const cap = `${String(Math.max(1, Math.round(input.maxOutputBytes / 1024)))} KB`;
  const catalog = input.catalog;
  const partial = catalog !== undefined && catalog.shown < catalog.total;
  const onlyNote = catalog !== undefined
    ? `\n\nThe ${String(catalog.total)} tools of the catalog below are NOT offered as direct calls — this program is the only way to reach them, so use it even for a single call to one of them.${
      partial
        ? " Only some are declared here; to use any other, first run a program that returns `await searchTools(\"<intent + key nouns>\")`, then call the tool in the next program exactly as the returned declaration says."
        : ""
    }`
    : input.hidesAll
      ? "\n\nMost tools are reachable ONLY through this program; the few listed beside it are the exceptions."
      : "";
  const heading = catalog === undefined
    ? "## Available tools"
    : partial
      ? `## Available tools (PARTIAL — ${String(catalog.shown)} of ${String(catalog.total)} declared; find the rest with searchTools)`
      : "## Available tools (complete)";
  return `Run a TypeScript program that calls the available tools — to do in ONE call what would otherwise take several model round-trips.

Use it when the same operation applies to many items (read N files and grep each), when later steps depend on earlier results but you already know the logic (branch, filter, aggregate), or when several tools must be combined. Do NOT use it for a single tool call — the program costs more than the call. Plan every step whose logic you already know into one program; make a separate call only where you must read a result before deciding what to do next.${onlyNote}

## Writing the program
- \`code\` is the BODY of an async function: top-level \`await\` and \`return\` work. Erasable TypeScript only — type annotations are fine; \`enum\`, \`namespace\` and decorators are not.
- Pass raw source text: not JSON, not a quoted string, not a markdown code fence.
- Call tools as \`await tools.Name(args)\`, exactly per the declarations below. A call resolves to what its declaration says: \`Promise<string>\` is the tool's text output; an object type is that object, already parsed — read its fields as declared. A failed call throws \`ToolCallError\` (\`.toolName\`, \`.message\`) — catch it if the program should carry on. A call that needs the user's approval waits for their answer (when nobody is there to give it, the program pauses until they answer and then continues without repeating the calls it already made); a rejection reaches it as a \`ToolCallError\`. A tool that asks the user a question (AskUserQuestion) cannot run inside a program; call it directly.
- Independent read-only calls MAY run concurrently under \`Promise.all\`; calls that write run one at a time, in the order they were made. Dependent work sequences with \`await\`.
- What you \`return\` comes back to you — make it the answer: structured data (objects, arrays) rather than prose, summarized inside the program instead of raw file contents. \`console.log\` lines come back too, after the return value under "Logs:"; use them for notes along the way, not for the result. Output beyond ${cap} is cut, logs first.
- The program runs in a fresh, isolated environment: no filesystem, network, timers, imports, or state from earlier calls. Every effect goes through \`tools.*\`, with the same permissions as a direct call.
- When the program finishes, unawaited promises are discarded silently — await everything you need.
- \`ALL_TOOLS\` lists every callable tool as \`{ name, description }\`, including any not declared below. \`await searchTools("github issues")\` returns the best matches with their full declarations (\`{ name, description, declaration }[]\`; also \`searchTools({ query, limit })\`) — never guess a tool's arguments: look it up, then call it as \`tools[name](args)\`.
- A long program (polling, many slow calls) can run detached: pass \`run_in_background: true\`; its console output and result go to a log file you Read later (the result names the path). A detached program cannot pause for an approval — a call that needs one fails inside it.

${heading}
\`\`\`ts
declare const tools: {
${input.declarations}
};
declare class ToolCallError extends Error { readonly toolName: string; }
declare const ALL_TOOLS: ReadonlyArray<{ name: string; description: string }>;
declare function searchTools(query: string | { query: string; limit?: number }): Promise<Array<{ name: string; description: string; declaration: string }>>;
\`\`\``;
}
