/**
 * Extension settings: a manifest declares them as a small JSON Schema subset, the framework keeps
 * the values (validated, defaulted), the extension reads them as `host.settings`, and a host
 * renders one generic form from the schema — no settings page per extension.
 *
 * The schema lives in the manifest, not the code, because the manifest is read before any code is
 * imported: settings can be shown and edited while the extension is not loaded or not yet
 * approved to run.
 *
 * The subset (anything else is refused when the manifest is read, never silently ignored):
 *
 * | keyword                                          | meaning                                    |
 * |--------------------------------------------------|--------------------------------------------|
 * | `type`                                           | object, array, string, integer, number, boolean (required) |
 * | `properties`, `required`                         | an object with fixed fields                |
 * | `additionalProperties` (a schema) + `propertyNames.pattern` | an object whose keys come and go (a table) |
 * | `items`                                          | the elements of an array                   |
 * | `enum`, `default`                                | allowed values, the value when unset       |
 * | `title`, `description`                           | labels for the form                        |
 * | `minimum`, `maximum`, `maxLength`, `pattern`     | constraints                                |
 * | `format`                                         | a string whose options the host provides: `model`, `permission-mode` |
 * | `x-multiline`, `x-order`                         | rendering hints                            |
 *
 * Reading is lenient, writing is strict. A stored value is read through `resolveSettings`: a
 * missing field takes its default, an unknown key is dropped, an invalid field falls back to its
 * default and is reported — an extension update that changed its schema must not stop it from
 * loading. A value to be stored goes through `validateSettings` and is refused on any issue.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import type { PermissionMode } from "operon-agents-core";

/** One problem with a schema or a value, at a dotted path (`types.coder.permissionMode`; `""` is the root). */
export interface SettingsIssue {
  readonly path: string;
  readonly message: string;
}

export type SettingsSchemaType = "object" | "array" | "string" | "integer" | "number" | "boolean";

/** A string whose options the host provides. `model`: a `provider/model` id, rendered as the
 *  host's model picker (only checked to be a string — the host owns the model list).
 *  `permission-mode`: a `PermissionMode`, checked against that enum. */
export type SettingsFormat = "model" | "permission-mode";

/** The JSON Schema subset a manifest's `settings` is written in. */
export interface SettingsSchema {
  readonly type: SettingsSchemaType;
  readonly title?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, SettingsSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: SettingsSchema;
  readonly propertyNames?: { readonly pattern: string };
  readonly items?: SettingsSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: SettingsFormat;
  readonly "x-multiline"?: boolean;
  readonly "x-order"?: number;
}

/** Everything a host needs to render and edit one extension's settings. */
export interface ExtensionSettingsView {
  readonly schema: SettingsSchema;
  /** The resolved value — what the extension reads as `host.settings`. */
  readonly value: Readonly<Record<string, unknown>>;
  /** Where the stored value did not fit the schema (each such field fell back to its default). */
  readonly issues: readonly SettingsIssue[];
}

/** The `permission-mode` format's values. */
export const SETTINGS_PERMISSION_MODES: readonly PermissionMode[] = ["manual", "workspace", "auto", "yolo"] satisfies readonly PermissionMode[];

const TYPES: ReadonlySet<string> = new Set<SettingsSchemaType>(["object", "array", "string", "integer", "number", "boolean"]);
const FORMATS: ReadonlySet<string> = new Set<SettingsFormat>(["model", "permission-mode"]);
const COMMON_KEYWORDS = ["type", "title", "description", "default", "enum", "x-order"];
const KEYWORDS_BY_TYPE: Readonly<Record<SettingsSchemaType, ReadonlySet<string>>> = {
  object: new Set([...COMMON_KEYWORDS, "properties", "required", "additionalProperties", "propertyNames"]),
  array: new Set([...COMMON_KEYWORDS, "items"]),
  string: new Set([...COMMON_KEYWORDS, "maxLength", "pattern", "format", "x-multiline"]),
  integer: new Set([...COMMON_KEYWORDS, "minimum", "maximum"]),
  number: new Set([...COMMON_KEYWORDS, "minimum", "maximum"]),
  boolean: new Set(COMMON_KEYWORDS),
};
/** Known JSON Schema keywords this first version does not support — named in the refusal, so an
 *  author is told "not supported" rather than "unknown". */
const RESERVED = new Set(["x-secret", "oneOf", "anyOf", "allOf", "not", "$ref", "const", "minLength", "minItems", "maxItems", "uniqueItems", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "patternProperties", "if", "then", "else"]);

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(path: string): string {
  return path === "" ? "the root" : `"${path}"`;
}

// ============================================================================
// The schema itself
// ============================================================================

/**
 * Check a manifest's `settings` against the supported subset. Empty ⇒ usable. The root must be an
 * object schema (an extension's settings are a record of named fields), and every `default` must
 * itself be a valid value.
 */
export function validateSettingsSchema(schema: unknown): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  checkSchema(schema, "", issues);
  if (issues.length === 0 && (schema as SettingsSchema).type !== "object") {
    issues.push({ path: "", message: 'settings must be an object schema ("type": "object")' });
  }
  return issues;
}

function checkSchema(schema: unknown, path: string, issues: SettingsIssue[]): void {
  const at = (message: string, sub = path): void => {
    issues.push({ path: sub, message });
  };
  if (!isRecord(schema)) return at("must be a schema object");
  const type = schema.type;
  if (typeof type !== "string" || !TYPES.has(type)) {
    return at(`needs a "type": one of ${[...TYPES].join(", ")}`);
  }
  const allowed = KEYWORDS_BY_TYPE[type as SettingsSchemaType];
  for (const key of Object.keys(schema)) {
    if (allowed.has(key)) continue;
    if (RESERVED.has(key)) at(`"${key}" is not supported in extension settings`);
    else if (Object.values(KEYWORDS_BY_TYPE).some((keys) => keys.has(key))) at(`"${key}" does not apply to a ${type}`);
    else at(`unknown keyword "${key}"`);
  }
  for (const key of ["title", "description"] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") at(`"${key}" must be a string`);
  }
  if (schema["x-order"] !== undefined && typeof schema["x-order"] !== "number") at('"x-order" must be a number');
  if (schema["x-multiline"] !== undefined && typeof schema["x-multiline"] !== "boolean") at('"x-multiline" must be a boolean');
  for (const key of ["minimum", "maximum"] as const) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) at(`"${key}" must be a number`);
  }
  if (schema.maxLength !== undefined && !(Number.isInteger(schema.maxLength) && (schema.maxLength as number) >= 0)) at('"maxLength" must be a non-negative integer');
  if (schema.pattern !== undefined) checkPattern(schema.pattern, '"pattern"', path, issues);
  if (schema.format !== undefined && (typeof schema.format !== "string" || !FORMATS.has(schema.format))) {
    at(`"format" must be one of ${[...FORMATS].join(", ")}`);
  }
  if (type === "object") {
    if (schema.properties !== undefined) {
      if (!isRecord(schema.properties)) at('"properties" must be an object of schemas');
      else for (const [key, sub] of Object.entries(schema.properties)) checkSchema(sub, join(path, key), issues);
    }
    if (schema.required !== undefined) {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string")) at('"required" must be an array of property names');
      else for (const key of schema.required as string[]) if (!(key in properties)) at(`"required" names "${key}", which is not in "properties"`);
    }
    if (schema.additionalProperties !== undefined) {
      if (typeof schema.additionalProperties === "boolean") at('"additionalProperties" must be a schema (unknown keys are always dropped)');
      else checkSchema(schema.additionalProperties, join(path, "*"), issues);
    }
    if (schema.propertyNames !== undefined) {
      if (schema.additionalProperties === undefined) at('"propertyNames" only applies with "additionalProperties"');
      if (!isRecord(schema.propertyNames) || Object.keys(schema.propertyNames).some((key) => key !== "pattern") || schema.propertyNames.pattern === undefined) {
        at('"propertyNames" supports only { "pattern": … }');
      } else checkPattern(schema.propertyNames.pattern, '"propertyNames.pattern"', path, issues);
    }
  }
  if (type === "array") {
    if (schema.items === undefined) at('an array needs "items"');
    else checkSchema(schema.items, join(path, "[]"), issues);
  }
  // Only once the schema is sound can its own values be checked against it.
  if (issues.length > 0) return;
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) at('"enum" must be a non-empty array');
    else {
      const leafOnly = { ...schema, enum: undefined, default: undefined } as SettingsSchema;
      schema.enum.forEach((value, index) => {
        for (const issue of validateSettings(leafOnly, value)) at(`"enum" value ${index}: ${issue.message}`);
      });
    }
  }
  if (schema.default !== undefined) {
    for (const issue of validateSettings(schema as unknown as SettingsSchema, schema.default)) {
      at(`"default" is not a valid value${issue.path !== "" ? ` at "${issue.path}"` : ""}: ${issue.message}`);
    }
  }
}

function checkPattern(pattern: unknown, label: string, path: string, issues: SettingsIssue[]): void {
  if (typeof pattern !== "string") {
    issues.push({ path, message: `${label} must be a string` });
    return;
  }
  try {
    new RegExp(pattern, "u");
  } catch (error) {
    issues.push({ path, message: `${label} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}` });
  }
}

// ============================================================================
// Values
// ============================================================================

/**
 * Check a value to be stored against `schema` — strict: a wrong type, an unknown key, a missing
 * required field or a broken constraint is an issue, each at its path. Empty ⇒ it may be stored.
 */
export function validateSettings(schema: SettingsSchema, value: unknown): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  checkValue(schema, value, "", issues, true);
  return issues;
}

/** The problems with `value` itself, for a leaf; for a container, its shape and — strictly —
 *  everything under it. */
function checkValue(schema: SettingsSchema, value: unknown, path: string, issues: SettingsIssue[], strict: boolean): void {
  const at = (message: string, sub = path): void => {
    issues.push({ path: sub, message });
  };
  switch (schema.type) {
    case "object": {
      if (!isRecord(value)) return at("must be an object");
      if (!strict) return;
      for (const [key, item] of Object.entries(value)) {
        const property = schema.properties?.[key];
        if (property !== undefined) {
          if (item !== undefined) checkValue(property, item, join(path, key), issues, true);
          continue;
        }
        if (schema.additionalProperties === undefined) {
          at("is not a known setting", join(path, key));
          continue;
        }
        const keyIssue = keyProblem(schema, key);
        if (keyIssue !== undefined) at(keyIssue, join(path, key));
        else checkValue(schema.additionalProperties, item, join(path, key), issues, true);
      }
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) at("is required", join(path, key));
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) return at("must be an array");
      if (!strict) return;
      value.forEach((item, index) => checkValue(schema.items!, item, join(path, index), issues, true));
      break;
    }
    case "string": {
      if (typeof value !== "string") return at("must be a string");
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) at(`must be at most ${schema.maxLength} characters`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) at(`must match ${schema.pattern}`);
      if (schema.format === "permission-mode" && !(SETTINGS_PERMISSION_MODES as readonly string[]).includes(value)) {
        at(`must be a permission mode: ${SETTINGS_PERMISSION_MODES.join(", ")}`);
      }
      break;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return at("must be a number");
      if (schema.type === "integer" && !Number.isInteger(value)) return at("must be an integer");
      if (schema.minimum !== undefined && value < schema.minimum) at(`must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) at(`must be at most ${schema.maximum}`);
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") at("must be true or false");
      break;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => sameValue(allowed, value))) {
    at(`must be one of ${schema.enum.map((allowed) => JSON.stringify(allowed)).join(", ")}`);
  }
}

function keyProblem(schema: SettingsSchema, key: string): string | undefined {
  const pattern = schema.propertyNames?.pattern;
  return pattern !== undefined && !new RegExp(pattern, "u").test(key) ? `the key "${key}" must match ${pattern}` : undefined;
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Read a stored value through `schema` — lenient: what is missing takes its default, an unknown
 * key is dropped, and an invalid field falls back to its default and is reported in `issues`.
 * Never throws for a bad value; the result is always an object (the root is an object schema).
 */
export function resolveSettings(schema: SettingsSchema, stored: unknown): { readonly value: Record<string, unknown>; readonly issues: SettingsIssue[] } {
  const issues: SettingsIssue[] = [];
  let source = stored;
  if (stored !== undefined && !isRecord(stored)) {
    issues.push({ path: "", message: "the stored settings are not an object; using the defaults" });
    source = undefined;
  }
  const value = resolveValue(schema, source, "", issues);
  return { value: isRecord(value) ? value : {}, issues };
}

function resolveValue(schema: SettingsSchema, value: unknown, path: string, issues: SettingsIssue[]): unknown {
  if (value === undefined) return defaultOf(schema, path);
  const problems: SettingsIssue[] = [];
  checkValue(schema, value, path, problems, false);
  if (problems.length > 0) {
    issues.push(...problems.map((issue) => ({ ...issue, message: `${issue.message}; using the default` })));
    return defaultOf(schema, path);
  }
  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const resolved = resolveValue(property, record[key], join(path, key), issues);
      if (resolved !== undefined) out[key] = resolved;
    }
    if (schema.additionalProperties !== undefined) {
      for (const [key, item] of Object.entries(record)) {
        if (schema.properties?.[key] !== undefined || item === undefined) continue;
        const keyIssue = keyProblem(schema, key);
        if (keyIssue !== undefined) {
          issues.push({ path: join(path, key), message: `${keyIssue}; dropped` });
          continue;
        }
        const resolved = resolveValue(schema.additionalProperties, item, join(path, key), issues);
        if (resolved !== undefined) out[key] = resolved;
      }
    }
    const missing = (schema.required ?? []).filter((key) => out[key] === undefined);
    if (missing.length > 0) {
      issues.push({ path, message: `${missing.map((key) => `"${key}"`).join(", ")} ${missing.length > 1 ? "are" : "is"} required; using the default` });
      return defaultOf(schema, path);
    }
    return out;
  }
  if (schema.type === "array") {
    return (value as unknown[]).flatMap((item, index) => {
      const resolved = resolveValue(schema.items!, item, join(path, index), issues);
      return resolved === undefined ? [] : [resolved];
    });
  }
  return value;
}

/**
 * What an unset field reads as: its `default` (itself resolved, so an object default gains the
 * defaults of the fields it leaves out); for an object without one, the defaults of its fields —
 * `undefined` when that comes to nothing or misses a required field.
 */
function defaultOf(schema: SettingsSchema, path: string): unknown {
  if (schema.default !== undefined) {
    // A default was checked against the schema when the manifest was read.
    return resolveValue({ ...schema, default: undefined }, structuredClone(schema.default), path, []);
  }
  if (schema.type !== "object" || schema.properties === undefined) return path === "" && schema.type === "object" ? {} : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = defaultOf(property, join(path, key));
    if (value !== undefined) out[key] = value;
  }
  if ((schema.required ?? []).some((key) => out[key] === undefined)) return undefined;
  return Object.keys(out).length > 0 || path === "" ? out : undefined;
}

// ============================================================================
// Storage
// ============================================================================

/**
 * Where extensions' settings values are kept, by extension id — what `setSettings` writes and
 * every `harness` half run reads. A value is stored as it was given (validated, but without the
 * defaults filled in), so a default an update changes still reaches a field the user never set.
 * Replace it with `createHarness({ extensionSettings })` to keep settings in the host's own store.
 */
export interface ExtensionSettingsStore {
  /** The stored value, or `undefined` when none was ever stored. */
  get(extensionId: string): Promise<unknown | undefined>;
  put(extensionId: string, value: unknown): Promise<void>;
}

/**
 * The default store: one JSON file per extension, `<directory>/<id>.json` — for a harness with an
 * `extensionDir`, `<extensionDir>/.settings`. Apart from the extension's own `dataDir` on purpose:
 * an extension cannot rewrite its settings past validation, and an update of its bundle leaves
 * them alone. Writes go to a temporary file first and are renamed into place.
 */
export function createFileSettingsStore(directory: string): ExtensionSettingsStore {
  const fileOf = (extensionId: string): string => {
    if (!/^[A-Za-z0-9._-]+$/.test(extensionId) || extensionId.startsWith(".")) throw new Error(`not an extension id: ${JSON.stringify(extensionId)}`);
    return joinPath(directory, `${extensionId}.json`);
  };
  let counter = 0;
  return {
    async get(extensionId) {
      let text: string;
      try {
        text = await readFile(fileOf(extensionId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      return JSON.parse(text) as unknown;
    },
    async put(extensionId, value) {
      const file = fileOf(extensionId);
      await mkdir(directory, { recursive: true });
      counter += 1;
      const temporary = `${file}.${process.pid}.${counter}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(temporary, file);
    },
  };
}
