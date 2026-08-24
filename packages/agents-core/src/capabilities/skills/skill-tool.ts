import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";
import { matchesGlobRuleSubject } from "../../tool/support/rule-match.ts";
import type { SkillRegistry } from "./registry.ts";
import { isInlineSkillType } from "./types.ts";

export const MAX_SKILL_QUERY_DEPTH = 3;

export class NestedSkillTooDeepError extends Error {
  readonly skillName?: string;
  readonly depth: number;
  constructor(depth: number, skillName?: string) {
    const label = skillName !== undefined ? ` "${skillName}"` : "";
    super(`Nested skill invocation${label} exceeded the maximum depth of ${depth} — refusing to recurse further.`);
    this.name = "NestedSkillTooDeepError";
    this.depth = depth;
    if (skillName !== undefined) this.skillName = skillName;
  }
}

export interface SkillToolOptions {
  readonly initialQueryDepth?: number;
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function escapeXmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function skillTool(registry: SkillRegistry, options: SkillToolOptions = {}): Tool {
  const depth = options.initialQueryDepth ?? 0;
  return defineTool({
    name: "Skill",
    description:
      "Load a registered skill's instructions into the conversation. Pass the skill `name` (and optional `args`); its body is returned for you to follow. Choose a skill by its description / when-to-use from the available-skills listing. Only inline skills are loadable here.",
    params: z.object({
      skill: z.string().describe("The skill name to load (from the available-skills listing)."),
      args: z.string().optional().describe("Optional free-text arguments passed to the skill."),
    }),
    resolve: (args) => ({
      approvalRule: "Skill",
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.skill),
      accesses: ToolAccesses.none(),
      display: { kind: "skill_call", title: `Skill: ${args.skill}`, detail: args.args },
      run: async (): Promise<ToolResult> => {
        if (depth >= MAX_SKILL_QUERY_DEPTH) {
          throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
        }
        const skill = registry.getSkill(args.skill);
        if (skill === undefined) {
          return errorResult(`Skill "${args.skill}" not found in the current skill listing.`);
        }
        if (skill.metadata.disableModelInvocation === true) {
          return errorResult(`Skill "${args.skill}" can only be triggered by the user (model invocation is disabled).`);
        }
        if (!isInlineSkillType(skill.metadata.type)) {
          return errorResult(`Skill "${skill.name}" is a flow skill — invoke it via its skill_${toToolSuffix(skill.name)} tool, not Skill.`);
        }
        const skillArgs = args.args ?? "";
        const body = registry.renderSkillPrompt(skill, skillArgs);
        const argsAttr = skillArgs.length > 0 ? ` args="${escapeXmlAttr(skillArgs)}"` : "";
        return {
          content: [
            {
              type: "text",
              text: `<skill-loaded name="${escapeXmlAttr(skill.name)}"${argsAttr}>\n${body}\n</skill-loaded>`,
            },
          ],
          details: { skill: skill.name, source: skill.source, path: skill.path },
        };
      },
    }),
  });
}

function toToolSuffix(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase();
}
