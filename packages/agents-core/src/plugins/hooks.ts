/**
 * Plugin hook loading — Codex / Claude-style `hooks.json` → flat `HookDef[]` for HookEngine.
 *
 * Supported shapes:
 * 1. Flat list (operon/config style):
 *    [{ "event": "PreToolUse", "matcher": "Write", "command": "..." }]
 * 2. Nested map (Codex / Claude plugin style):
 *    { "hooks": { "PreToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "..." }] }] } }
 *    or the inner map alone: { "PreToolUse": [ ... ] }
 *
 * Path fields in the plugin manifest may be a single path, an array of paths, or an inline object.
 * When the manifest omits `hooks`, the default file `hooks/hooks.json` is loaded if present.
 */
import path from "node:path";
import { HOOK_EVENT_TYPES, type HookDef, type HookEventType } from "../capabilities/user-hooks/types.ts";
import type { Machine } from "../tool/machine.ts";
import { readTextFile } from "../tool/support/machine-ops.ts";
import type { PluginDiagnostic } from "./types.ts";

const DEFAULT_HOOKS_FILE = "hooks/hooks.json";
const KNOWN_EVENTS = new Set<string>(HOOK_EVENT_TYPES);

export interface ParsedPluginHooks {
  readonly hooks: readonly HookDef[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

/**
 * Resolve hook definitions for a plugin root from the raw manifest `hooks` field.
 * Expands `${PLUGIN_ROOT}` (and Claude-compat aliases) in command strings.
 */
export async function loadPluginHooks(
  machine: Machine,
  pluginRoot: string,
  rawHooksField: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly HookDef[]> {
  const docs = await collectHookDocuments(machine, pluginRoot, rawHooksField, diagnostics);
  const out: HookDef[] = [];
  for (const doc of docs) {
    const parsed = parseHooksDocument(doc);
    for (const d of parsed.diagnostics) diagnostics.push(d);
    for (const hook of parsed.hooks) {
      out.push(expandPluginRootInHook(hook, pluginRoot));
    }
  }
  return out;
}

/** Substitute plugin-root placeholders so commands can address files inside the package. */
export function expandPluginRootInHook(hook: HookDef, pluginRoot: string): HookDef {
  return {
    ...hook,
    command: expandPluginRoot(hook.command, pluginRoot),
  };
}

export function expandPluginRoot(command: string, pluginRoot: string): string {
  // Prefer longest / braced forms first so partial replacements don't corrupt them.
  return command
    .replaceAll("${PLUGIN_ROOT}", pluginRoot)
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot)
    .replaceAll("$PLUGIN_ROOT", pluginRoot)
    .replaceAll("$CLAUDE_PLUGIN_ROOT", pluginRoot);
}

/**
 * Parse a hooks document (object or array) into HookDefs.
 * Pure: no I/O.
 */
export function parseHooksDocument(raw: unknown): ParsedPluginHooks {
  const diagnostics: PluginDiagnostic[] = [];
  if (raw === undefined || raw === null) return { hooks: [], diagnostics };

  // Flat HookDef list
  if (Array.isArray(raw)) {
    return { hooks: parseFlatHookList(raw, diagnostics), diagnostics };
  }

  if (!isObject(raw)) {
    diagnostics.push({ severity: "warn", message: "hooks document must be an object or array" });
    return { hooks: [], diagnostics };
  }

  // Wrapped { hooks: <map|array> } (Codex default file shape)
  if ("hooks" in raw && (isObject(raw["hooks"]) || Array.isArray(raw["hooks"]))) {
    return parseHooksDocument(raw["hooks"]);
  }

  // Nested event map: { PreToolUse: [ matcher groups ], SessionStart: [...] }
  return { hooks: parseEventMap(raw, diagnostics), diagnostics };
}

/** Project config.hooks entries into HookDefs, dropping unknown events. */
export function hookDefsFromConfig(
  entries: ReadonlyArray<{ event: string; matcher?: string; command: string; timeout?: number }>,
): HookDef[] {
  const out: HookDef[] = [];
  for (const entry of entries) {
    if (!KNOWN_EVENTS.has(entry.event)) continue;
    if (typeof entry.command !== "string" || entry.command.trim().length === 0) continue;
    out.push({
      event: entry.event as HookEventType,
      ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
      command: entry.command,
      ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
    });
  }
  return out;
}

// ── internal ─────────────────────────────────────────────────────────────────

async function collectHookDocuments(
  machine: Machine,
  pluginRoot: string,
  rawHooksField: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<unknown[]> {
  // No field → try default path; absence is silent.
  if (rawHooksField === undefined) {
    const defaultPath = path.join(pluginRoot, DEFAULT_HOOKS_FILE);
    if (!(await isFile(machine, defaultPath))) return [];
    return [await readJson(machine, defaultPath, diagnostics)];
  }

  // Inline document
  if (isObject(rawHooksField) || Array.isArray(rawHooksField)) {
    return [rawHooksField];
  }

  // Path or path list
  const paths: string[] = [];
  if (typeof rawHooksField === "string") {
    paths.push(rawHooksField);
  } else if (Array.isArray(rawHooksField) && rawHooksField.every((e) => typeof e === "string")) {
    paths.push(...(rawHooksField as string[]));
  } else {
    diagnostics.push({
      severity: "warn",
      message: '"hooks" must be a path, path[], or inline hooks object/array',
    });
    return [];
  }

  const docs: unknown[] = [];
  for (const entry of paths) {
    const absolute = resolvePluginPath(pluginRoot, entry, "hooks", diagnostics);
    if (absolute === undefined) continue;
    if (!(await isFile(machine, absolute))) {
      diagnostics.push({ severity: "warn", message: `"hooks" path not found (${entry})` });
      continue;
    }
    docs.push(await readJson(machine, absolute, diagnostics));
  }
  return docs;
}

function parseFlatHookList(raw: unknown[], diagnostics: PluginDiagnostic[]): HookDef[] {
  const out: HookDef[] = [];
  for (const item of raw) {
    if (!isObject(item)) {
      diagnostics.push({ severity: "warn", message: "hooks list entries must be objects" });
      continue;
    }
    const def = coerceHookDef(item, undefined, diagnostics);
    if (def) out.push(def);
  }
  return out;
}

function parseEventMap(raw: Record<string, unknown>, diagnostics: PluginDiagnostic[]): HookDef[] {
  const out: HookDef[] = [];
  for (const [eventName, groups] of Object.entries(raw)) {
    if (!KNOWN_EVENTS.has(eventName)) {
      diagnostics.push({
        severity: "info",
        message: `hooks event "${eventName}" is not a known HookEventType; skipped`,
      });
      continue;
    }
    if (!Array.isArray(groups)) {
      diagnostics.push({
        severity: "warn",
        message: `hooks["${eventName}"] must be an array of matcher groups`,
      });
      continue;
    }
    for (const group of groups) {
      if (!isObject(group)) {
        diagnostics.push({
          severity: "warn",
          message: `hooks["${eventName}"] entries must be objects`,
        });
        continue;
      }
      const matcher = typeof group["matcher"] === "string" ? group["matcher"] : undefined;
      const inner = group["hooks"];
      // Allow a single command object without nested hooks array
      if (inner === undefined && typeof group["command"] === "string") {
        const def = coerceHookDef(group, eventName as HookEventType, diagnostics, matcher);
        if (def) out.push(def);
        continue;
      }
      if (!Array.isArray(inner)) {
        diagnostics.push({
          severity: "warn",
          message: `hooks["${eventName}"] group is missing a "hooks" array`,
        });
        continue;
      }
      for (const hook of inner) {
        if (!isObject(hook)) continue;
        // Codex may use type: "command" | "prompt" — only command is executable here.
        const type = typeof hook["type"] === "string" ? hook["type"] : "command";
        if (type !== "command") {
          diagnostics.push({
            severity: "info",
            message: `hooks["${eventName}"] entry type "${type}" is not supported (only "command")`,
          });
          continue;
        }
        const def = coerceHookDef(hook, eventName as HookEventType, diagnostics, matcher);
        if (def) out.push(def);
      }
    }
  }
  return out;
}

function coerceHookDef(
  raw: Record<string, unknown>,
  eventFromMap: HookEventType | undefined,
  diagnostics: PluginDiagnostic[],
  matcherFromGroup?: string,
): HookDef | undefined {
  const eventRaw = eventFromMap ?? (typeof raw["event"] === "string" ? raw["event"] : undefined);
  if (eventRaw === undefined || !KNOWN_EVENTS.has(eventRaw)) {
    if (eventRaw !== undefined) {
      diagnostics.push({
        severity: "info",
        message: `hooks event "${eventRaw}" is not a known HookEventType; skipped`,
      });
    } else {
      diagnostics.push({ severity: "warn", message: 'hook entry requires "event"' });
    }
    return undefined;
  }
  const command = typeof raw["command"] === "string" ? raw["command"].trim() : "";
  if (command.length === 0) {
    diagnostics.push({ severity: "warn", message: 'hook entry requires non-empty "command"' });
    return undefined;
  }
  const matcher =
    typeof raw["matcher"] === "string"
      ? raw["matcher"]
      : matcherFromGroup !== undefined
        ? matcherFromGroup
        : undefined;
  // Codex uses seconds or ms in different places; accept timeout / timeoutMs / timeout_ms.
  const timeout = readTimeout(raw);
  return {
    event: eventRaw as HookEventType,
    ...(matcher !== undefined && matcher.length > 0 ? { matcher } : {}),
    command,
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function readTimeout(raw: Record<string, unknown>): number | undefined {
  for (const key of ["timeout", "timeoutMs", "timeout_ms"] as const) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      // Heuristic: values > 1000 are ms; smaller are seconds (Codex often uses seconds).
      if (key === "timeout" && v < 1000) return Math.round(v * 1000);
      return Math.round(v);
    }
  }
  return undefined;
}

function resolvePluginPath(
  pluginRoot: string,
  entry: string,
  field: string,
  diagnostics: PluginDiagnostic[],
): string | undefined {
  if (!entry.startsWith("./")) {
    diagnostics.push({
      severity: "warn",
      message: `"${field}" path must start with "./" (got "${entry}")`,
    });
    return undefined;
  }
  const absolute = path.resolve(pluginRoot, entry);
  if (!isWithin(absolute, pluginRoot)) {
    diagnostics.push({
      severity: "warn",
      message: `"${field}" path resolves outside the plugin (${entry})`,
    });
    return undefined;
  }
  return absolute;
}

async function readJson(machine: Machine, absolute: string, diagnostics: PluginDiagnostic[]): Promise<unknown> {
  try {
    return JSON.parse(await readTextFile(machine, absolute)) as unknown;
  } catch (error) {
    diagnostics.push({
      severity: "warn",
      message: `Failed to parse hooks file ${absolute}: ${(error as Error).message}`,
    });
    return undefined;
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isFile(machine: Machine, p: string): Promise<boolean> {
  try {
    return (await machine.fileInfo(p)).kind === "file";
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
