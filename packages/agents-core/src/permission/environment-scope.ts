import type { ToolCallEnvironment } from "../loop/types.ts";
import type { PermissionRule } from "./types.ts";

/**
 * Environment scoping of permission state. Single-environment sessions never reach any of
 * this with a call environment, so their rules and grants behave exactly as before.
 *
 * Session grants are stored as strings (they persist with the session). A grant earned on a
 * non-root environment is keyed `@<environment>:<approval rule>`; one on the root environment
 * keeps the bare approval rule — the format every existing session already stored. `@` never
 * starts a tool name, so the two cannot collide.
 */
export function sessionGrantKey(approvalRule: string, environment: ToolCallEnvironment | undefined): string {
  return environment === undefined || environment.root ? approvalRule : `@${environment.name}:${approvalRule}`;
}

export interface ParsedGrantKey {
  /** Undefined = the root environment. */
  readonly environment?: string;
  readonly pattern: string;
}

export function parseSessionGrantKey(key: string): ParsedGrantKey {
  if (!key.startsWith("@")) return { pattern: key };
  const colon = key.indexOf(":");
  if (colon <= 1) return { pattern: key };
  return { environment: key.slice(1, colon), pattern: key.slice(colon + 1) };
}

/** The environment a call is judged in, as rule scoping sees it: undefined = the root. */
export function callScopeName(environment: ToolCallEnvironment | undefined): string | undefined {
  return environment === undefined || environment.root ? undefined : environment.name;
}

/**
 * Does `rule` apply to a call in `environment`? An unscoped rule applies to the root only; a
 * scoped one to the environment it names (the root's own name included).
 */
export function ruleAppliesTo(rule: Pick<PermissionRule, "environment">, environment: ToolCallEnvironment | undefined, rootName: string | undefined): boolean {
  const call = callScopeName(environment);
  if (rule.environment === undefined) return call === undefined;
  return call === undefined ? rootName !== undefined && rule.environment === rootName : rule.environment === call;
}
