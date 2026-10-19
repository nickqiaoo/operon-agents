/**
 * Code Mode as an extension: one definition for `createHarness({ extensions })`.
 *
 * Two jobs. It registers the `RunCode` tool; and on every model request it rewrites that
 * tool's description with declarations for the tools the request actually carries — so the
 * program is written against exactly what this turn can call — and withholds the tools it
 * hides ({@link CodeModeHide}) from the request, so the program is the way to reach them.
 *
 * Nothing here is a permission boundary. The engine runs every nested call through its own
 * pipeline (`ToolRunContext.dispatch`); the runtime keeps the program from reaching anything
 * else. Take this extension away and the model is back to direct calls — a feature missing,
 * not an invariant broken.
 */
import type { ExtensionDefinition, LlmRequest, ToolSchema } from "operon-agents";
import { DEFAULT_CATALOG_BUDGET, renderToolCatalog, renderToolDeclarations } from "./declarations.ts";
import { RUN_CODE_NAME, runCodeDescription } from "./prompt.ts";
import { createRunCodeTool, DEFAULT_RUN_CODE_LIMITS, type RunCodeLimits } from "./run-code-tool.ts";
import type { CodeRuntime } from "./runtime.ts";
import { createQuickJSRuntime } from "./runtime-quickjs.ts";

export const CODE_MODE_EXTENSION_ID = "code-mode";

/**
 * Which tools only a program can reach. Hidden tools stay in the engine's registry — they are
 * withheld from the model's view, not removed — and stay callable from a program.
 *
 * `catalog` (default): Code Mode as the fallback for deferred tool loading. A model whose provider
 * can add tools mid-conversation already defers the catalog behind SearchTool — there RunCode is
 * withheld and the request goes out untouched. For any other model the catalog tools ({@link
 * CodeModeOptions.catalogTools}, MCP tools by default) leave the request, and the RunCode
 * description declares as many as fit in {@link CodeModeOptions.catalogBudget}; the program finds
 * the rest with `searchTools`. Everything else stays directly callable, and with nothing to hide
 * RunCode is withheld too.
 *
 * `none`: nothing is hidden; RunCode sits beside every tool and the model picks per task (a lone
 * Read is cheaper direct; a sweep is cheaper as a program) — Code Mode for orchestration.
 *
 * `all`: the direct surface shrinks to {@link DEFAULT_DIRECT_TOOLS} plus `directTools`;
 * everything else is reachable only through a program.
 */
export type CodeModeHide = "catalog" | "none" | "all";

/** Tools never hidden (under `all` and `catalog`): RunCode itself, and the ones a program cannot host (they suspend, run long, or manage what runs in the background). */
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
  /** Which tools only a program can reach. Default `catalog`. */
  readonly hide?: CodeModeHide;
  /** Under `all` and `catalog`, tools kept directly callable in addition to {@link DEFAULT_DIRECT_TOOLS}. */
  readonly directTools?: readonly string[];
  /** Tools a program may never call (they are still callable directly). */
  readonly exclude?: readonly string[];
  readonly limits?: Partial<RunCodeLimits>;
  /** The runtime programs execute in. Defaults to QuickJS (WebAssembly, in this process). */
  readonly runtime?: CodeRuntime;
  /**
   * Detail carried into the tool declarations under `none` and `all`. Defaults to `brief` under
   * `none` (the native schemas already carry the full text) and `full` under `all` (the program is
   * all the model has). The `catalog` slice is always brief; `searchTools` returns the full text.
   */
  readonly descriptions?: "brief" | "full";
  /** Under `catalog`, which tools the catalog holds. Defaults to MCP tools (`mcp__…`). */
  readonly catalogTools?: (schema: ToolSchema) => boolean;
  /** Under `catalog`, how many estimated tokens the declared slice may take. Default {@link DEFAULT_CATALOG_BUDGET}. */
  readonly catalogBudget?: number;
}

/** The name SearchTool goes by: present in a request exactly when the model defers its catalog natively. */
const SEARCH_TOOL_NAME = "SearchTool";

const isMcpTool = (schema: ToolSchema): boolean => schema.name.startsWith("mcp__");

export function codeMode(options: CodeModeOptions = {}): ExtensionDefinition {
  const hide = options.hide ?? "catalog";
  const runtime = options.runtime ?? createQuickJSRuntime();
  const limits: RunCodeLimits = { ...DEFAULT_RUN_CODE_LIMITS, ...options.limits };
  const excluded = new Set([RUN_CODE_NAME, ...(options.exclude ?? [])]);
  const direct = new Set([...DEFAULT_DIRECT_TOOLS, ...(options.directTools ?? [])]);
  const descriptions = options.descriptions ?? (hide === "all" ? "full" : "brief");
  const inCatalog = options.catalogTools ?? isMcpTool;
  const catalogBudget = options.catalogBudget ?? DEFAULT_CATALOG_BUDGET;
  const describe = (callable: readonly ToolSchema[]): string => {
    if (hide !== "catalog") {
      return runCodeDescription({
        declarations: renderToolDeclarations(callable, { descriptions }),
        maxOutputBytes: limits.maxOutputBytes,
        hidesAll: hide === "all",
      });
    }
    const catalog = renderToolCatalog(callable, { budget: catalogBudget });
    return runCodeDescription({
      declarations: catalog.declarations,
      maxOutputBytes: limits.maxOutputBytes,
      hidesAll: false,
      catalog: { shown: catalog.shown, total: catalog.total },
    });
  };

  /** What the model sees this step: the tools it may call directly, and what RunCode declares. */
  const project = (tools: readonly ToolSchema[]): { readonly visible: readonly ToolSchema[]; readonly declared: readonly ToolSchema[] } | undefined => {
    const callable = tools.filter((schema) => !excluded.has(schema.name));
    if (hide === "none") return { visible: tools, declared: callable };
    if (hide === "all") return { visible: tools.filter((schema) => direct.has(schema.name)), declared: callable };
    if (tools.some((schema) => schema.name === SEARCH_TOOL_NAME)) return undefined;
    const declared = callable.filter((schema) => !direct.has(schema.name) && inCatalog(schema));
    if (declared.length === 0) return undefined;
    const hidden = new Set(declared.map((schema) => schema.name));
    return { visible: tools.filter((schema) => !hidden.has(schema.name)), declared };
  };

  return {
    id: CODE_MODE_EXTENSION_ID,
    session(api) {
      const tool = createRunCodeTool({
        runtime,
        limits,
        exclude: options.exclude,
        description: describe([]),
        // The replay journal lives in this extension's durable KV, so a program paused for an
        // approval can be continued from another process.
        journal: api.state,
      });
      const unregisterTool = api.registerTool(tool);

      // Rendering declarations is cheap, but the tool list is the same step after step; keep the
      // last rendering so a stable list costs nothing and the description stays byte-identical
      // (a provider's prompt cache keys on it).
      let last: { readonly key: string; readonly description: string } | undefined;
      const off = api.on("model.request", (event) => {
        const tools = event.request.tools;
        if (tools === undefined || !tools.some((schema) => schema.name === RUN_CODE_NAME)) return undefined;
        const projection = project(tools);
        // Nothing for RunCode to do this step (`catalog` with native deferral, or nothing to hide).
        if (projection === undefined) return { request: withTools(event.request, tools.filter((schema) => schema.name !== RUN_CODE_NAME)) };
        const key = projection.declared.map((schema) => `${schema.name} ${schema.description} ${JSON.stringify(schema.parameters)} ${JSON.stringify(schema.outputSchema ?? null)}`).join("\n");
        if (last === undefined || last.key !== key) last = { key, description: describe(projection.declared) };
        const description = last.description;
        return {
          request: withTools(event.request, projection.visible.map((schema) => (schema.name === RUN_CODE_NAME ? { ...schema, description } : schema))),
        };
      });

      return () => {
        off();
        unregisterTool();
      };
    },
  };
}

function withTools(request: LlmRequest, tools: readonly ToolSchema[]): LlmRequest {
  return { ...request, tools };
}
