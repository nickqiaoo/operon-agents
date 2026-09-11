/**
 * The generated API the model programs against: each tool's JSON Schema rendered as a
 * TypeScript method on `declare const tools`. A model has read far more `declare const x: {…}`
 * than JSON Schema, so this is the shape it calls correctly.
 *
 * Pure: schemas in, text out. Names are rendered as quoted keys when they are not identifiers
 * (`"mcp__github__list-issues"`), never aliased, so every tool stays reachable as written.
 * Local `$ref`s are followed (a schema may point into its own `$defs`); a cycle degrades to
 * `unknown` rather than recursing, as does anything the renderer does not understand.
 */
import type { ToolSchema } from "operon-agents-core";

export interface DeclarationOptions {
  /**
   * How much description to carry into JSDoc. `brief` (default) keeps each tool's first
   * paragraph, capped, and drops parameter descriptions — right when the model also sees the
   * native schemas. `full` keeps everything — right when the program is the only way to call.
   */
  readonly descriptions?: "brief" | "full";
  /** What each method resolves to. Defaults to `Promise<string>`: a binding returns the tool's text. */
  readonly returnType?: string;
}

type JsonSchema = Readonly<Record<string, unknown>>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const BRIEF_MAX_CHARS = 240;
const MAX_DEPTH = 8;

/** Render the members of `declare const tools: { … }` — one method per tool, sorted by name. */
export function renderToolDeclarations(tools: readonly ToolSchema[], options: DeclarationOptions = {}): string {
  const full = options.descriptions === "full";
  const returnType = options.returnType ?? "Promise<string>";
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines: string[] = [];
  for (const tool of sorted) {
    const doc = full ? tool.description : briefOf(tool.description);
    lines.push(...docLines(doc, 1));
    lines.push(`  ${renderKey(tool.name)}(${renderArgs(tool.parameters, full)}): ${returnType};`);
  }
  return lines.join("\n");
}

/** The first paragraph, whitespace collapsed, capped — enough to pick a tool, not to operate it. */
export function briefOf(description: string): string {
  const paragraph = description.split(/\n\s*\n/, 1)[0] ?? "";
  const collapsed = paragraph.replace(/\s+/g, " ").trim();
  return collapsed.length > BRIEF_MAX_CHARS ? `${collapsed.slice(0, BRIEF_MAX_CHARS - 1)}…` : collapsed;
}

function renderArgs(parameters: JsonSchema, full: boolean): string {
  const root = parameters;
  const type = renderType(parameters, root, 0, new Set(), full);
  const required = Array.isArray(parameters.required) && parameters.required.length > 0;
  // A tool with nothing required can be called as `tools.X()`.
  return required ? `args: ${type}` : `args?: ${type}`;
}

function renderType(schema: unknown, root: JsonSchema, depth: number, seen: ReadonlySet<object>, full: boolean): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if (!isRecord(schema)) return "unknown";
  if (depth > MAX_DEPTH) return "unknown";

  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, root);
    if (target === undefined || seen.has(target)) return "unknown";
    return renderType(target, root, depth + 1, new Set([...seen, target]), full);
  }
  if (Object.hasOwn(schema, "const")) return literal(schema.const);
  if (Array.isArray(schema.enum)) return unionOf(schema.enum.map(literal));

  const composed = composeVariants(schema, root, depth, seen, full);
  if (composed !== undefined) return composed;

  const type = schema.type;
  if (Array.isArray(type)) {
    return unionOf(type.map((one) => renderType({ ...schema, type: one }, root, depth, seen, full)));
  }
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return renderArray(schema, root, depth, seen, full);
    case "object":
      return renderObject(schema, root, depth, seen, full);
    default:
      if (isRecord(schema.properties)) return renderObject(schema, root, depth, seen, full);
      if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return renderArray(schema, root, depth, seen, full);
      return "unknown";
  }
}

/** `anyOf` / `oneOf` become a union, `allOf` an intersection; `undefined` when the schema has neither. */
function composeVariants(schema: JsonSchema, root: JsonSchema, depth: number, seen: ReadonlySet<object>, full: boolean): string | undefined {
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (variants !== undefined) {
    return unionOf(variants.map((variant) => renderType(variant, root, depth + 1, seen, full)));
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((part) => renderType(part, root, depth + 1, seen, full)).filter((part) => part !== "unknown");
    if (parts.length === 0) return "unknown";
    return parts.length === 1 ? parts[0]! : parts.map(parenthesize).join(" & ");
  }
  return undefined;
}

function renderArray(schema: JsonSchema, root: JsonSchema, depth: number, seen: ReadonlySet<object>, full: boolean): string {
  if (Array.isArray(schema.prefixItems)) {
    const members = schema.prefixItems.map((item) => renderType(item, root, depth + 1, seen, full));
    return `[${members.join(", ")}]`;
  }
  const item = schema.items === undefined ? "unknown" : renderType(schema.items, root, depth + 1, seen, full);
  return `${parenthesize(item)}[]`;
}

function renderObject(schema: JsonSchema, root: JsonSchema, depth: number, seen: ReadonlySet<object>, full: boolean): string {
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties === undefined || Object.keys(properties).length === 0) {
    const additional = schema.additionalProperties;
    if (additional === false) return "{}";
    if (isRecord(additional)) return `Record<string, ${renderType(additional, root, depth + 1, seen, full)}>`;
    return "Record<string, unknown>";
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const members: string[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const doc = full && isRecord(property) && typeof property.description === "string" ? inlineDoc(property.description) : "";
    members.push(`${doc}${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderType(property, root, depth + 1, seen, full)}`);
  }
  return `{ ${members.join("; ")} }`;
}

/** Follow a local JSON pointer (`#/$defs/Name`, `#/definitions/Name`, any `#/a/b` path). */
function resolveRef(ref: string, root: JsonSchema): object | undefined {
  if (!ref.startsWith("#")) return undefined;
  const path = ref.slice(1).split("/").filter((segment) => segment.length > 0).map(unescapePointer);
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return isRecord(current) ? current : undefined;
}

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function unionOf(members: readonly string[]): string {
  const unique = [...new Set(members)];
  return unique.length === 0 ? "never" : unique.join(" | ");
}

function parenthesize(type: string): string {
  return /[|&]/.test(type) && !type.startsWith("{") && !type.startsWith("[") ? `(${type})` : type;
}

function literal(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value) ?? "unknown";
}

function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** A JSDoc block for a description, one line per source line, at `indent` levels; nothing when empty. */
function docLines(description: string, indent: number): string[] {
  const text = description.trim();
  if (text.length === 0) return [];
  const pad = "  ".repeat(indent);
  const safe = text.replaceAll("*/", "*\\/");
  const lines = safe.split("\n");
  if (lines.length === 1) return [`${pad}/** ${lines[0]} */`];
  return [`${pad}/**`, ...lines.map((line) => `${pad} * ${line}`.trimEnd()), `${pad} */`];
}

function inlineDoc(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim().replaceAll("*/", "*\\/");
  return collapsed.length === 0 ? "" : `/** ${collapsed} */ `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
