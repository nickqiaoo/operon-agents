import { resolvePathAccessPath, type PathAccessOperation, type WorkspaceAccessPolicy } from "../policies/path-access.ts";
import type { Machine } from "../machine.ts";
import type { ToolPlan } from "../types.ts";
import { literalRulePattern, matchesGlobRuleSubject, matchesPathRuleSubject } from "./rule-match.ts";

export const SEARCH_ACCESS_POLICY: WorkspaceAccessPolicy = { guardMode: "absolute-outside-allowed", checkSensitive: false };

export function resolveToolPath(
  path: string,
  machine: Machine,
  operation: PathAccessOperation,
  policy?: WorkspaceAccessPolicy,
): Promise<string> {
  return resolvePathAccessPath(path, {
    machine,
    workspace: { workspaceDir: machine.getcwd(), additionalDirs: machine.additionalDirs?.() ?? [] },
    operation,
    policy,
  });
}

export function pathApproval(toolName: string, machine: Machine, path: string): Pick<ToolPlan, "approvalRule" | "matchesRule"> {
  return {
    approvalRule: literalRulePattern(toolName, path),
    matchesRule: (ruleArgs) =>
      matchesPathRuleSubject(ruleArgs, path, {
        cwd: machine.getcwd(),
        pathClass: machine.pathClass(),
        homeDir: machine.gethome(),
      }),
  };
}

export function globApproval(toolName: string, subject: string): Pick<ToolPlan, "approvalRule" | "matchesRule"> {
  return {
    approvalRule: literalRulePattern(toolName, subject),
    matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
  };
}
