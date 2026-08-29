/**
 * Code Mode as an extension: one definition for `createHarness({ extensions })`.
 *
 * Two jobs. It registers the `RunCode` tool; and on every model request it rewrites that
 * tool's description with declarations for the tools the request actually carries — so the
 * program is written against exactly what this turn can call — and, in `only` mode, withholds
 * the other tools from the request so the program is the way to reach them.
 *
 * Nothing here is a permission boundary. The engine runs every nested call through its own
 * pipeline (`ToolRunContext.dispatch`); the runtime keeps the program from reaching anything
 * else. Take this extension away and the model is back to direct calls — a feature missing,
 * not an invariant broken.
 */
import type { ExtensionDefinition, ToolSchema } from "operon-agents";
import { renderToolDeclarations } from "./declarations.ts";
import { RUN_CODE_NAME, runCodeDescription } from "./prompt.ts";
import { createRunCodeTool, DEFAULT_RUN_CODE_LIMITS, type RunCodeLimits } from "./run-code-tool.ts";
import type { CodeRuntime } from "./runtime.ts";
import { createQuickJSRuntime } from "./runtime-quickjs.ts";

export const CODE_MODE_EXTENSION_ID = "code-mode";

/**
 * `both` (default): RunCode sits beside the direct tools; the model picks per task (a lone
 * Read is cheaper direct; a sweep is cheaper as a program). `only`: the direct surface shrinks
 * to {@link DEFAULT_DIRECT_TOOLS} plus `directTools`; everything else is reachable only through a
 * program. Hidden tools stay in the engine's registry — they are withheld from the model's
 * view, not removed.
 */
export type CodeModeMode = "both" | "only";

/** Tools that stay directly callable under `only`: RunCode itself, and the ones a program cannot host (they suspend, run long, or manage what runs in the background). */
export const DEFAULT_DIRECT_TOOLS: readonly string[] = [
  RUN_CODE_NAME,
  "AskUserQuestion",
  "Agent",
  "Workflow",
  "BackgroundList",
  "BackgroundOutput",
  "BackgroundStop",
];

export interface CodeModeOptions {
  readonly mode?: CodeModeMode;
  /** Under `only`, tools kept directly callable in addition to {@link DEFAULT_DIRECT_TOOLS}. */
  readonly directTools?: readonly string[];
  /** Tools a program may never call (they are still callable directly). */
  readonly exclude?: readonly string[];
  readonly limits?: Partial<RunCodeLimits>;
  /** The runtime programs execute in. Defaults to QuickJS (WebAssembly, in this process). */
  readonly runtime?: CodeRuntime;
  /**
   * Detail carried into the tool declarations. Defaults to `brief` under `both` (the native
   * schemas already carry the full text) and `full` under `only` (the program is all the model has).
   */
  readonly descriptions?: "brief" | "full";
}

export function codeMode(options: CodeModeOptions = {}): ExtensionDefinition {
  const mode = options.mode ?? "both";
  const runtime = options.runtime ?? createQuickJSRuntime();
  const limits: RunCodeLimits = { ...DEFAULT_RUN_CODE_LIMITS, ...options.limits };
  const excluded = new Set([RUN_CODE_NAME, ...(options.exclude ?? [])]);
  const direct = new Set([...DEFAULT_DIRECT_TOOLS, ...(options.directTools ?? [])]);
  const descriptions = options.descriptions ?? (mode === "only" ? "full" : "brief");
  const describe = (callable: readonly ToolSchema[]): string =>
    runCodeDescription({
      declarations: renderToolDeclarations(callable, { descriptions }),
      maxOutputBytes: limits.maxOutputBytes,
      onlyMode: mode === "only",
    });

  return {
    id: CODE_MODE_EXTENSION_ID,
    setup(api) {
      const tool = createRunCodeTool({
        runtime,
        limits,
        exclude: options.exclude,
        description: describe([]),
      });
      const unregisterTool = api.registerTool(tool);

      // Rendering declarations is cheap, but the tool list is the same step after step; keep the
      // last rendering so a stable list costs nothing and the description stays byte-identical
      // (a provider's prompt cache keys on it).
      let last: { readonly key: string; readonly description: string } | undefined;
      const off = api.on("model.request", (event) => {
        const tools = event.request.tools;
        if (tools === undefined || !tools.some((schema) => schema.name === RUN_CODE_NAME)) return undefined;
        const callable = tools.filter((schema) => !excluded.has(schema.name));
        const key = callable.map((schema) => `${schema.name} ${schema.description} ${JSON.stringify(schema.parameters)}`).join("\n");
        if (last === undefined || last.key !== key) last = { key, description: describe(callable) };
        const description = last.description;
        const visible = mode === "only" ? tools.filter((schema) => direct.has(schema.name)) : tools;
        return {
          request: {
            ...event.request,
            tools: visible.map((schema) => (schema.name === RUN_CODE_NAME ? { ...schema, description } : schema)),
          },
        };
      });

      return () => {
        off();
        unregisterTool();
      };
    },
  };
}
