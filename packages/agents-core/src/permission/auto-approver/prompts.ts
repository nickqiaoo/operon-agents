import { CLASSIFIER_BASE_PROMPT, CLASSIFIER_PERMISSIONS_TEMPLATE } from "./prompts-data.ts";
import { DEFAULT_ALLOW_RULES, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY_RULES, DEFAULT_SOFT_DENY_RULES } from "./rules-data.ts";

export { CLASSIFIER_BASE_PROMPT, CLASSIFIER_PERMISSIONS_TEMPLATE };

/** In a rule list, this entry stands for the built-in list at that position. */
export const DEFAULT_RULES_TOKEN = "$defaults";

/**
 * User-customizable rule sections of the classifier prompt. For each section: absent or empty keeps
 * the built-in list; a list REPLACES the built-in one, except that a `"$defaults"` entry splices the
 * built-in list in at its position — `["$defaults", "my extra rule"]` extends rather than replaces.
 */
export interface ClassifierRules {
  /** ALLOW exceptions. They clear SOFT BLOCK rules only, never HARD ones. */
  readonly allow?: readonly string[];
  /** SOFT BLOCK rules: destructive or irreversible actions that explicit user intent can clear. */
  readonly softDeny?: readonly string[];
  /** HARD BLOCK rules: blocked unconditionally — no user message or ALLOW exception clears them. */
  readonly hardDeny?: readonly string[];
  /** @deprecated Former single BLOCK list; read as `softDeny` (appended after it when both are set). */
  readonly deny?: readonly string[];
  /** Environment facts: trusted repos/domains/buckets/services, what counts as sensitive or production. */
  readonly environment?: readonly string[];
}

/** The four sections as the prompt will carry them, `$defaults` expanded. */
export interface ResolvedClassifierRules {
  readonly allow: readonly string[];
  readonly softDeny: readonly string[];
  readonly hardDeny: readonly string[];
  readonly environment: readonly string[];
}

/** The built-in rule lists (the equivalent of `claude auto-mode defaults`). */
export function defaultClassifierRules(): ResolvedClassifierRules {
  return {
    allow: [...DEFAULT_ALLOW_RULES],
    softDeny: [...DEFAULT_SOFT_DENY_RULES],
    hardDeny: [...DEFAULT_HARD_DENY_RULES],
    environment: [...DEFAULT_ENVIRONMENT],
  };
}

function resolveSection(values: readonly string[] | undefined, defaults: readonly string[]): string[] {
  if (values === undefined || values.length === 0) return [...defaults];
  const out: string[] = [];
  for (const value of values) {
    if (value.trim() === DEFAULT_RULES_TOKEN) out.push(...defaults);
    else if (value.trim().length > 0) out.push(value);
  }
  return out;
}

export function resolveClassifierRules(rules: ClassifierRules = {}): ResolvedClassifierRules {
  const soft = rules.softDeny === undefined && rules.deny === undefined ? undefined : [...(rules.softDeny ?? []), ...(rules.deny ?? [])];
  return {
    allow: resolveSection(rules.allow, DEFAULT_ALLOW_RULES),
    softDeny: resolveSection(soft, DEFAULT_SOFT_DENY_RULES),
    hardDeny: resolveSection(rules.hardDeny, DEFAULT_HARD_DENY_RULES),
    environment: resolveSection(rules.environment, DEFAULT_ENVIRONMENT),
  };
}

function render(values: readonly string[]): string {
  return values.length === 0 ? "- None configured" : values.map((v) => `- ${v}`).join("\n");
}

function fillSlot(template: string, slot: string, values: readonly string[]): string {
  const tag = `<${slot}></${slot}>`;
  // Function replacer: rule text may contain `$&`-style sequences String.replace would expand.
  return template.replace(tag, () => render(values));
}

/**
 * Assemble the classifier system prompt: the base prompt with the permissions template in place
 * of `<permissions_template>`, and the template's four slots filled from `rules` (built-ins where a
 * section is not configured).
 */
export function buildClassifierSystemPrompt(rules: ClassifierRules = {}): string {
  const resolved = resolveClassifierRules(rules);
  let permissions = CLASSIFIER_PERMISSIONS_TEMPLATE;
  permissions = fillSlot(permissions, "user_environment_to_replace", resolved.environment);
  permissions = fillSlot(permissions, "user_hard_deny_rules_to_replace", resolved.hardDeny);
  permissions = fillSlot(permissions, "user_soft_deny_rules_to_replace", resolved.softDeny);
  permissions = fillSlot(permissions, "user_allow_rules_to_replace", resolved.allow);
  return CLASSIFIER_BASE_PROMPT.replace("<permissions_template>", () => permissions);
}
