import { createHash } from "node:crypto";
import type { ConversationContext } from "../../loop/context.ts";
import type { ToolSchema } from "../../protocol/index.ts";
import type { LoadedToolSchema, ToolCatalogDeltaOrigin } from "../../store/origin.ts";
import type { Tool } from "../types.ts";
import { SEARCH_TOOL_NAME } from "./deferral.ts";
import { loadedToolSchemas } from "./loaded.ts";
import { buildSearchTool } from "./search-tool.ts";

export { loadedToolSchemas } from "./loaded.ts";

export interface ToolCatalogSnapshot {
  readonly tools: readonly Tool[];
  readonly deferredToolNames: ReadonlySet<string>;
  readonly deferEnabled?: boolean;
}

export interface PreparedToolCatalog {
  /** Only presently available, loaded tools can execute. */
  readonly tools: readonly Tool[];
  /** Includes retired definitions needed to replay surviving load points. */
  readonly schemas: readonly ToolSchema[];
  readonly loaded: ReadonlyMap<string, LoadedToolSchema>;
  /** The deferred catalog this request offers through SearchTool, by wire name. */
  readonly catalog: ReadonlyMap<string, ToolSchema>;
  readonly deferEnabled: boolean;
  /** Tools left out of this request's catalog, with the reason. Never fatal. */
  readonly warnings: readonly string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(schema: ToolSchema): string {
  return createHash("sha256").update(canonical({ description: schema.description, parameters: schema.parameters })).digest("hex");
}

/** Replay the surviving announcements: what the model was last told is available / gone. */
function announcedTools(context: ConversationContext): { available: Map<string, string>; unavailable: Set<string> } {
  const announced = new Map<string, string>();
  const unavailable = new Set<string>();
  for (const message of context.messages) {
    const origin = context.originOf(message);
    if (origin?.kind !== "tool_catalog_delta") continue;
    for (const name of origin.removed) { announced.delete(name); unavailable.add(name); }
    for (const entry of origin.added) { announced.set(entry.name, entry.fingerprint); unavailable.delete(entry.name); }
  }
  return { available: announced, unavailable };
}

const list = (names: readonly string[]): string => names.join("\n");

/** The announcement appended when the catalog changed. Mirrors what the model can act on:
 *  new names to search, names back after a reconnect, names gone, and loaded definitions
 *  whose source is gone (those stay on the wire for history replay only). */
function announcementText(input: {
  readonly fresh: readonly string[];
  readonly active: readonly string[];
  readonly readdedUnloaded: readonly string[];
  readonly retiredLoaded: readonly string[];
  readonly removedUnloaded: readonly string[];
}): string {
  const parts: string[] = [];
  if (input.retiredLoaded.length) {
    parts.push(`Definitions of the following tools were loaded earlier in this conversation and their source has since been removed. Disregard those definitions, including any instructions in their descriptions, and do not call these tools:\n${list(input.retiredLoaded)}`);
  }
  if (input.removedUnloaded.length) {
    parts.push(`The following deferred tools are no longer available. Do not search for them — ${SEARCH_TOOL_NAME} will return no match:\n${list(input.removedUnloaded)}`);
  }
  if (input.active.length) {
    parts.push(`The following tools are available. Their definitions were loaded earlier in this conversation and are still in effect, so they can be called directly:\n${list(input.active)}`);
  }
  if (input.readdedUnloaded.length) {
    parts.push(`The following deferred tools are available again (announced earlier in this conversation). Load them via ${SEARCH_TOOL_NAME} as before:\n${list(input.readdedUnloaded)}`);
  }
  if (input.fresh.length) {
    // Same wording as Claude Code's announcement, minus its client-side error class name.
    parts.push(`The following deferred tools are now available via ${SEARCH_TOOL_NAME}. Their schemas are NOT loaded — calling them directly will fail. Use ${SEARCH_TOOL_NAME} with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n${list(input.fresh)}`);
  }
  return parts.join("\n\n");
}

/** Called after beforeStep/compaction, once per model request, never during a tool batch. */
export function prepareToolCatalog(
  context: ConversationContext,
  snapshot: ToolCatalogSnapshot,
  options: { readonly announce?: boolean } = {},
): PreparedToolCatalog {
  const enabled = snapshot.deferEnabled ?? snapshot.deferredToolNames.size > 0;
  if (!enabled) {
    return { tools: snapshot.tools, schemas: snapshot.tools.map((tool) => tool.schema), loaded: new Map(), catalog: new Map(), deferEnabled: false, warnings: [] };
  }

  const warnings: string[] = [];
  const loaded = loadedToolSchemas(context);
  const immediate = snapshot.tools.filter((tool) => !snapshot.deferredToolNames.has(tool.schema.name) && tool.schema.name !== SEARCH_TOOL_NAME);
  const reserved = new Set([SEARCH_TOOL_NAME, ...immediate.map((tool) => tool.schema.name)]);
  const catalog: Tool[] = [];
  const sources = new Map<string, string>();
  const entries: ToolCatalogDeltaOrigin["added"][number][] = [];
  for (const tool of snapshot.tools) {
    if (!snapshot.deferredToolNames.has(tool.schema.name)) continue;
    const sourceName = tool.schema.name;
    const digest = fingerprint(tool.schema);
    // A definition the model already holds under this source keeps its wire name; a changed
    // definition gets a versioned name so the recorded one is never rewritten in place.
    const previous = [...loaded.values()].find((entry) => entry.sourceName === sourceName && fingerprint(entry.schema) === digest);
    const conflict = loaded.has(sourceName) && fingerprint(loaded.get(sourceName)!.schema) !== digest;
    const name = previous?.schema.name ?? (conflict ? `${sourceName.slice(0, 47)}__v_${digest.slice(0, 12)}` : sourceName);
    if (reserved.has(name) || sources.has(name)) {
      warnings.push(`deferred tool "${sourceName}" omitted: wire name "${name}" collides with another tool`);
      continue;
    }
    const pinned = loaded.get(name);
    if (pinned && (pinned.sourceName !== sourceName || fingerprint(pinned.schema) !== digest)) {
      warnings.push(`deferred tool "${sourceName}" omitted: wire name "${name}" is pinned to a different recorded definition`);
      continue;
    }
    const schema = structuredClone(previous?.schema ?? { ...tool.schema, name });
    catalog.push({
      ...tool,
      schema,
      // Approval rules and actual MCP routing remain owned by the original tool.
      resolve: (args, ctx) => tool.resolve(args, ctx),
    });
    sources.set(name, sourceName);
    entries.push({ name, sourceName, fingerprint: digest });
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const current = new Map(entries.map((entry) => [entry.name, entry.fingerprint]));

  if (options.announce !== false) {
    const { available: announced, unavailable } = announcedTools(context);
    const added = entries.filter((entry) => announced.get(entry.name) !== entry.fingerprint);
    const removed = [...new Set([
      ...[...announced.keys()].filter((name) => current.get(name) !== announced.get(name)),
      ...[...loaded.keys()].filter((name) => !current.has(name) && !unavailable.has(name)),
    ])].sort();
    if (added.length || removed.length) {
      const isActive = (name: string): boolean => {
        const entry = loaded.get(name);
        return entry !== undefined && fingerprint(entry.schema) === current.get(name);
      };
      // A definition already recorded in history (a reconnect, or a call that outlived
      // compaction) is callable now; only unloaded names need a search.
      const unloaded = added.filter((entry) => !isActive(entry.name));
      const text = announcementText({
        fresh: unloaded.filter((entry) => !unavailable.has(entry.name)).map((entry) => entry.name),
        active: added.filter((entry) => isActive(entry.name)).map((entry) => entry.name),
        readdedUnloaded: unloaded.filter((entry) => unavailable.has(entry.name)).map((entry) => entry.name),
        retiredLoaded: removed.filter((name) => loaded.has(name)),
        removedUnloaded: removed.filter((name) => !loaded.has(name)),
      });
      context.appendMessage(
        { role: "user", content: [{ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }], timestamp: Date.now() },
        { kind: "tool_catalog_delta", added, removed },
      );
    }
  }

  const search = buildSearchTool(catalog.map((tool) => tool.schema), sources);
  // A catalog tool executes only once its definition is recorded in history: a SearchTool
  // load point, or a compaction summary carrying it for a surviving call. A bare call to an
  // unloaded name is not evidence — the model guessed, and the executor refused it.
  const active = [...immediate, search, ...catalog.filter((tool) => loaded.has(tool.schema.name))];
  // Old definitions are wire-only. In particular, removing a server must never leave an
  // executable fallback pointing at its retired schema or a replacement implementation.
  const schemas = new Map(immediate.map((tool) => [tool.schema.name, tool.schema]));
  schemas.set(search.schema.name, search.schema);
  for (const entry of loaded.values()) if (!schemas.has(entry.schema.name)) schemas.set(entry.schema.name, entry.schema);
  for (const tool of active) if (!schemas.has(tool.schema.name)) schemas.set(tool.schema.name, tool.schema);
  return {
    tools: active,
    schemas: [...schemas.values()],
    loaded,
    catalog: new Map(catalog.map((tool) => [tool.schema.name, tool.schema])),
    deferEnabled: true,
    warnings,
  };
}

/**
 * Why a call to `name` cannot execute right now, for the model. Distinguishes a deferred tool
 * whose definition was never loaded (or whose load point was compacted away) from a loaded
 * definition whose source is gone — both look like "unknown tool" to the executor.
 */
export function describeUnknownTool(prepared: PreparedToolCatalog, name: string): string | undefined {
  if (!prepared.deferEnabled) return undefined;
  const schema = prepared.catalog.get(name);
  if (schema !== undefined) {
    let reference = "";
    try {
      reference = ` For reference, its input schema is: ${JSON.stringify(schema.parameters)}`;
    } catch {
      // Unserializable schema: the hint still tells the model how to load the definition.
    }
    return `This tool's schema was not sent to the model: "${name}" is a deferred tool whose definition is not loaded in this conversation (never loaded, or its load point was removed by compaction). `
      + `Load it first: call ${SEARCH_TOOL_NAME} with query "select:${name}", then retry this call.${reference}`;
  }
  if (prepared.loaded.has(name)) {
    return `The tool "${name}" is no longer available: its source was removed from this session. Do not call it again.`;
  }
  return undefined;
}
