import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";
import type { ToolProvider } from "../tool-provider.ts";
import { matchesGlobRuleSubject } from "../../tool/support/rule-match.ts";
import type { SkillRegistry } from "./registry.ts";
import type { FlowSkillExecutor, SkillDefinition } from "./types.ts";

export function flowSkillToolName(skillName: string): string {
  const suffix = skillName.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase() || "skill";
  return `skill_${suffix}`;
}

function flowSkillTool(skill: SkillDefinition, registry: SkillRegistry, executor?: FlowSkillExecutor): Tool {
  const toolName = flowSkillToolName(skill.name);
  return defineTool({
    name: toolName,
    description: `${skill.description}${
      typeof skill.metadata.whenToUse === "string" && skill.metadata.whenToUse.length > 0
        ? ` When to use: ${skill.metadata.whenToUse}`
        : ""
    } Runs the "${skill.name}" flow skill as a sub-agent and returns its result.`,
    params: z.object({
      input: z.string().describe(`The task / arguments for the "${skill.name}" flow skill.`),
    }),
    resolve: (args) => ({
      approvalRule: toolName,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, skill.name),
      accesses: ToolAccesses.all(),
      controlFlow: true,
      display: { kind: "skill_call", title: `Flow skill: ${skill.name}`, detail: args.input },
      run: async (ctx): Promise<ToolResult> => {
        if (executor === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `Flow skill "${skill.name}" cannot run here: no FlowSkillExecutor is wired. Provide one in skillsCapability({ flowExecutor }) to run flow skills as sub-agents.`,
              },
            ],
            isError: true,
          };
        }
        const instructions = registry.renderSkillPrompt(skill, "");
        const output = await executor({ skill, instructions, input: args.input, signal: ctx.signal });
        return { content: [{ type: "text", text: output }], details: { skill: skill.name, source: skill.source } };
      },
    }),
  });
}

export function flowSkillProvider(registry: SkillRegistry, executor?: FlowSkillExecutor): ToolProvider {
  return {
    id: "skill-flow",
    listTools: () => registry.listFlowSkills().map((skill) => flowSkillTool(skill, registry, executor)),
  };
}
