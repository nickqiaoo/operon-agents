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
  "Run the program detached and return a task_id immediately — for a long program (polling, many slow tool calls) that should not hold the turn. Read its console output and final result with BackgroundOutput. Requires the background capability.";

export interface RunCodePromptInput {
  /** The members of `declare const tools: { … }`, already rendered (see `declarations.ts`). */
  readonly declarations: string;
  readonly maxOutputBytes: number;
  /** True when the other tools are reachable only through a program (the `only` mode). */
  readonly onlyMode: boolean;
}

export function runCodeDescription(input: RunCodePromptInput): string {
  const cap = `${String(Math.max(1, Math.round(input.maxOutputBytes / 1024)))} KB`;
  const onlyNote = input.onlyMode
    ? "\n\nMost tools are reachable ONLY through this program; the few listed beside it are the exceptions."
    : "";
  return `Run a TypeScript program that calls the available tools — to do in ONE call what would otherwise take several model round-trips.

Use it when the same operation applies to many items (read N files and grep each), when later steps depend on earlier results but you already know the logic (branch, filter, aggregate), or when several tools must be combined. Do NOT use it for a single tool call — the program costs more than the call. Plan every step whose logic you already know into one program; make a separate call only where you must read a result before deciding what to do next.${onlyNote}

## Writing the program
- \`code\` is the BODY of an async function: top-level \`await\` and \`return\` work. Erasable TypeScript only — type annotations are fine; \`enum\`, \`namespace\` and decorators are not.
- Pass raw source text: not JSON, not a quoted string, not a markdown code fence.
- Call tools as \`await tools.Name(args)\`, exactly per the declarations below. A call resolves to the tool's text output. A failed call throws \`ToolCallError\` (\`.toolName\`, \`.message\`) — catch it if the program should carry on. If a call needs the user's approval and nobody is there to give it, the program pauses until they answer and then continues without repeating the calls it already made; a rejection reaches it as a \`ToolCallError\`. A tool that asks the user a question (AskUserQuestion) cannot run inside a program; call it directly.
- Independent read-only calls MAY run concurrently under \`Promise.all\`; calls that write run one at a time, in the order they were made. Dependent work sequences with \`await\`.
- Only what you \`console.log(...)\` or \`return\` comes back to you — curate it. Return structured data (objects, arrays) rather than prose, and summarize inside the program instead of returning raw file contents: output beyond ${cap} is cut.
- The program runs in a fresh, isolated environment: no filesystem, network, timers, imports, or state from earlier calls. Every effect goes through \`tools.*\`, with the same permissions as a direct call.
- When the program finishes, unawaited promises are discarded silently — await everything you need.
- \`ALL_TOOLS\` lists every callable tool as \`{ name, description }\`, including any not declared below; call those as \`tools[name](args)\`.
- A long program (polling, many slow calls) can run detached: pass \`run_in_background: true\` and read its output later with BackgroundOutput. A detached program cannot pause for an approval — a call that needs one fails inside it.

## Available tools
\`\`\`ts
declare const tools: {
${input.declarations}
};
declare class ToolCallError extends Error { readonly toolName: string; }
declare const ALL_TOOLS: ReadonlyArray<{ name: string; description: string }>;
\`\`\``;
}
