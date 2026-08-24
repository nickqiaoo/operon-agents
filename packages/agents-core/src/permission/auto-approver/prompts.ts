import { CLASSIFIER_BASE_PROMPT, CLASSIFIER_PERMISSIONS_TEMPLATE } from "./prompts-data.ts";

export { CLASSIFIER_BASE_PROMPT, CLASSIFIER_PERMISSIONS_TEMPLATE };

/** User-customizable rule sections injected into the classifier prompt. */
export interface ClassifierRules {
  /** Extra ALLOW exceptions. Each becomes a `- <text>` bullet; REPLACES the template defaults. */
  readonly allow?: readonly string[];
  /** Extra BLOCK conditions. Each becomes a `- <text>` bullet; REPLACES the template defaults. */
  readonly deny?: readonly string[];
  /** Environment facts (trusted repo/orgs/domains/buckets/services); REPLACES the template defaults. */
  readonly environment?: readonly string[];
}

// Stage-2 XML output instructions that replace the tool-use line from the base prompt. The
// classifier emits `<block>yes|no</block>` (plus an optional `<reason>`), which the parser
// reads back — this avoids depending on forced tool-calls / tool_choice, which the model
// abstraction does not expose.
const XML_OUTPUT_FORMAT = [
  "## Output Format",
  "",
  "If the action should be blocked:",
  "<block>yes</block><reason>one short sentence</reason>",
  "",
  "If the action should be allowed:",
  "<block>no</block>",
  "",
  "Do NOT include a <reason> tag when the action is allowed.",
  "Your ENTIRE response MUST begin with <block>. Do NOT output any analysis, reasoning, or commentary before <block>. No \"Looking at...\" or similar preamble.",
].join("\n");

const TOOL_USE_LINE = "Use the classify_result tool to report your classification.";

function replaceTaggedSection(prompt: string, tag: string, values: readonly string[] | undefined): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  // No user values → keep the template's own defaults (the tag's existing contents).
  if (values === undefined || values.length === 0) return prompt.replace(re, (_m, defaults: string) => defaults);
  const rendered = values.map((v) => `- ${v}`).join("\n");
  return prompt.replace(re, () => rendered);
}

/**
 * Assemble the full classifier system prompt: base prompt + permissions template, with the
 * three user sections substituted (user values replace the template defaults), and the
 * trailing tool-use line swapped for XML output.
 */
export function buildClassifierSystemPrompt(rules: ClassifierRules = {}): string {
  let prompt = CLASSIFIER_BASE_PROMPT.replace("<permissions_template>", () => CLASSIFIER_PERMISSIONS_TEMPLATE);
  prompt = replaceTaggedSection(prompt, "user_allow_rules_to_replace", rules.allow);
  prompt = replaceTaggedSection(prompt, "user_deny_rules_to_replace", rules.deny);
  prompt = replaceTaggedSection(prompt, "user_environment_to_replace", rules.environment);
  return prompt.replace(TOOL_USE_LINE, XML_OUTPUT_FORMAT);
}
