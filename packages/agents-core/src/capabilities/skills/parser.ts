import path from "pathe";
import type { Machine } from "../../tool/machine.ts";
import type { SkillDefinition, SkillMetadata, SkillSource } from "./types.ts";
import { isSupportedSkillType } from "./types.ts";
import { readTextFile } from "../../tool/support/machine-ops.ts";

export class FrontmatterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FrontmatterError";
    if (cause !== undefined) Object.defineProperty(this, "cause", { value: cause, configurable: true });
  }
}

export class SkillParseError extends Error {
  readonly reason?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SkillParseError";
    if (cause !== undefined) this.reason = cause;
  }
}

export class UnsupportedSkillTypeError extends Error {
  readonly skillType: string;
  constructor(skillType: string) {
    super(`Skill type "${skillType}" is not supported; only "prompt", "inline", and "flow" are supported.`);
    this.name = "UnsupportedSkillTypeError";
    this.skillType = skillType;
  }
}

export interface ParseSkillOptions {
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly source: SkillSource;
}

export interface ParseSkillTextOptions extends ParseSkillOptions {
  readonly text: string;
}

export interface SkillExpandContext {
  readonly skillDir: string;
  readonly sessionId?: string;
  readonly argumentNames?: readonly string[];
}

export interface ParsedFrontmatter {
  readonly data: Record<string, unknown> | null;
  readonly body: string;
}

const FENCE = "---";
const METADATA_ALIASES: Readonly<Record<string, string>> = {
  "when-to-use": "whenToUse",
  when_to_use: "whenToUse",
  "disable-model-invocation": "disableModelInvocation",
  disable_model_invocation: "disableModelInvocation",
};

export async function parseSkillFromMachine(machine: Machine, options: ParseSkillOptions): Promise<SkillDefinition> {
  let text: string;
  try {
    text = await readTextFile(machine, options.skillMdPath);
  } catch (error) {
    throw new SkillParseError(`Failed to read ${options.skillMdPath}`, error);
  }
  return parseSkillText({ ...options, text });
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return { data: null, body: text };

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) throw new FrontmatterError("Missing closing frontmatter fence");

  const yamlLines = lines.slice(1, close);
  const body = lines.slice(close + 1).join("\n");
  if (yamlLines.join("").trim() === "") return { data: {}, body };

  try {
    return { data: parseFrontmatterBlock(yamlLines), body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FrontmatterError(message, error);
  }
}

export function parseSkillText(options: ParseSkillTextOptions): SkillDefinition {
  const isDirectorySkill = path.basename(options.skillMdPath) === "SKILL.md";
  if (isDirectorySkill && options.text.split(/\r?\n/, 1)[0]?.trim() !== FENCE) {
    throw new SkillParseError(`Missing frontmatter in ${options.skillMdPath}`);
  }

  let parsed: ParsedFrontmatter;
  try {
    parsed = parseFrontmatter(options.text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new SkillParseError(`Invalid frontmatter in ${options.skillMdPath}: ${error.message}`, error);
    }
    throw error;
  }

  const frontmatter = parsed.data ?? {};
  const metadata = normalizeMetadata(frontmatter);
  if (!isSupportedSkillType(metadata.type)) {
    throw new UnsupportedSkillTypeError(metadata.type ?? String(frontmatter["type"]));
  }

  const name = nonEmptyString(metadata.name);
  const description = nonEmptyString(metadata.description);
  if (isDirectorySkill && (name === undefined || description === undefined)) {
    const field = name === undefined ? '"name"' : '"description"';
    throw new SkillParseError(`Missing required frontmatter field ${field} in ${options.skillMdPath}`);
  }

  const skillPath = path.resolve(options.skillMdPath);
  const content = parsed.body.trim();
  return {
    name: name ?? options.skillDirName,
    description: description ?? descriptionFromBody(content),
    path: skillPath,
    dir: path.dirname(skillPath),
    content,
    metadata,
    source: options.source,
  };
}

export function expandSkillParameters(body: string, rawArgs: string, context: SkillExpandContext): string {
  const tokens = tokenizeArgs(rawArgs);
  let content = body;

  for (let index = 0; index < (context.argumentNames?.length ?? 0); index++) {
    const argName = context.argumentNames?.[index];
    if (argName === undefined) continue;
    const escaped = escapeRegExp(argName);
    content = content.replaceAll(new RegExp(`\\$${escaped}(?![\\[\\w])`, "g"), escapeXmlTags(tokens[index] ?? ""));
  }

  content = content
    .replaceAll(/\$ARGUMENTS\[(\d+)\]/g, (_m, idx: string) => escapeXmlTags(tokens[Number.parseInt(idx, 10)] ?? ""))
    .replaceAll(/\$(\d+)(?!\w)/g, (_m, idx: string) => escapeXmlTags(tokens[Number.parseInt(idx, 10)] ?? ""))
    .replaceAll("$ARGUMENTS", escapeXmlTags(rawArgs));

  const hasPlaceholder = content !== body;
  content = content
    .replaceAll("${SKILL_DIR}", context.skillDir)
    .replaceAll("${SESSION_ID}", context.sessionId ?? "");

  if (!hasPlaceholder && rawArgs.length > 0) return `${content}\n\nARGUMENTS: ${escapeXmlTags(rawArgs)}`;
  return content;
}

export function skillArgumentNames(metadata: SkillMetadata): readonly string[] {
  const value = metadata.arguments;
  const isValidName = (name: string): boolean => name.trim() !== "" && !/^\d+$/.test(name);
  if (typeof value === "string") return value.split(/\s+/).filter(isValidName);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && isValidName(item));
}

function parseFrontmatterBlock(lines: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = stripComment(raw);
    if (line.trim() === "" || /^\s/.test(raw)) {
      i += 1; // blank, comment, or a stray indented line with no owning key
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (match === null) {
      i += 1;
      continue;
    }
    const key = match[1] as string;
    const inline = (match[2] ?? "").trim();

    if (inline === "|" || inline === ">" || /^[|>][+-]?$/.test(inline)) {
      const { text, next } = collectBlockScalar(lines, i + 1, inline.startsWith(">"));
      out[key] = text;
      i = next;
      continue;
    }
    if (inline === "") {
      const { value, next } = collectBlock(lines, i + 1);
      out[key] = value;
      i = next;
      continue;
    }
    out[key] = parseScalar(inline);
    i += 1;
  }
  return out;
}

function collectBlock(lines: readonly string[], start: number): { value: unknown; next: number } {
  const items: unknown[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;
    if (!/^\s/.test(raw)) break; // dedent → block ended
    const listMatch = /^\s*-\s*(.*)$/.exec(raw);
    if (listMatch === null) break; // not a list item (nested map etc.) — leave uninterpreted
    items.push(parseScalar((listMatch[1] ?? "").trim()));
  }
  return { value: items, next: i };
}

function collectBlockScalar(lines: readonly string[], start: number, folded: boolean): { text: string; next: number } {
  const body: string[] = [];
  let indent: number | null = null;
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") {
      body.push("");
      continue;
    }
    const lead = raw.length - raw.trimStart().length;
    if (lead === 0) break; // dedent to column 0 → block ended
    if (indent === null) indent = lead;
    body.push(raw.slice(Math.min(indent, lead)));
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  const text = folded ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n");
  return { text, next: i };
}

function parseScalar(value: string): unknown {
  if (value === "") return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevelCommas(inner).map((item) => parseScalar(item.trim()));
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}

function splitTopLevelCommas(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

function stripComment(line: string): string {
  // A `#` only starts a comment when preceded by whitespace or at line start (not inside a URL/value).
  const match = /(^|\s)#.*$/.exec(line);
  if (match === null) return line;
  // Don't strip when the `#` is inside a quoted scalar.
  const before = line.slice(0, match.index);
  const quotes = (before.match(/["']/g) ?? []).length;
  if (quotes % 2 === 1) return line;
  return before;
}

function normalizeMetadata(raw: Record<string, unknown>): SkillMetadata {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    out[METADATA_ALIASES[rawKey] ?? rawKey] = value;
  }
  for (const field of ["type", "name", "description", "whenToUse"] as const) {
    const normalized = nonEmptyString(out[field]);
    if (normalized !== undefined) out[field] = normalized;
  }
  return out as SkillMetadata;
}

function descriptionFromBody(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return "No description provided.";
  return firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
}

function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let hasContent = false;
  for (const char of raw) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else {
        current += char;
        hasContent = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        out.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) out.push(current);
  return out;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function escapeXmlTags(text: string): string {
  return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
