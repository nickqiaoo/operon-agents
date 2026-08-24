import { globMatch } from "../tool/support/path-glob-match.ts";
import type { ToolPlan } from "../tool/types.ts";
import type { PermissionRule } from "./types.ts";

export interface ParsedPattern {
  readonly toolName: string;
  readonly argPattern?: string;
}

export type PermissionRuleMatchStrategy = "tool_name_only" | "matches_rule";

export interface PermissionRuleMatch {
  readonly rule: PermissionRule;
  readonly strategy: PermissionRuleMatchStrategy;
  readonly hasRuleArgs: boolean;
}

export interface PermissionRuleMatchInput {
  readonly rule: PermissionRule;
  readonly toolName: string;
  readonly execution: Pick<ToolPlan, "matchesRule">;
}

export function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) throw new Error("permission pattern: empty string");

  const openIdx = trimmed.indexOf("(");
  if (openIdx === -1) return { toolName: trimmed };

  if (!trimmed.endsWith(")")) {
    throw new Error(`permission pattern: missing closing paren in "${pattern}"`);
  }

  const toolName = trimmed.slice(0, openIdx);
  const argPattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) throw new Error(`permission pattern: empty tool name in "${pattern}"`);
  // `Tool()` stays tool-name-only so tools without a `matchesRule` still match.
  if (argPattern.length === 0) return { toolName };
  return { toolName, argPattern };
}

/**
 * Validate a rule pattern without matching. Returns an error message if malformed, else
 * undefined. A malformed pattern makes {@link matchPermissionRule} silently return "no match"
 * — for a `deny` rule that is fail-open — so callers should surface this at rule-load time
 * (the match path stays silent to avoid re-logging on every tool call).
 */
export function permissionPatternError(pattern: string): string | undefined {
  try {
    parsePattern(pattern);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function matchPermissionRule({ rule, toolName, execution }: PermissionRuleMatchInput): PermissionRuleMatch | undefined {
  let parsed: ParsedPattern;
  try {
    parsed = parsePattern(rule.pattern);
  } catch {
    return undefined;
  }

  if (parsed.toolName !== "*" && !globMatch(toolName, parsed.toolName)) {
    return undefined;
  }

  if (parsed.argPattern === undefined) {
    return { rule, strategy: "tool_name_only", hasRuleArgs: false };
  }

  return execution.matchesRule?.(parsed.argPattern) === true
    ? { rule, strategy: "matches_rule", hasRuleArgs: true }
    : undefined;
}
