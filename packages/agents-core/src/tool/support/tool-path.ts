import { resolvePathAccessPath, type PathAccessOperation, type WorkspaceAccessPolicy } from "../policies/path-access.ts";
import type { Environment } from "../environment.ts";
import type { ToolPlan } from "../types.ts";
import { literalRulePattern, matchesGlobRuleSubject, matchesPathRuleSubject } from "./rule-match.ts";

export const SEARCH_ACCESS_POLICY: WorkspaceAccessPolicy = { guardMode: "absolute-outside-allowed", checkSensitive: false };

export function resolveToolPath(
  path: string,
  environment: Environment,
  operation: PathAccessOperation,
  policy?: WorkspaceAccessPolicy,
): Promise<string> {
  return resolvePathAccessPath(path, {
    environment,
    workspace: { workspaceDir: environment.getcwd(), additionalDirs: environment.additionalDirs?.() ?? [] },
    operation,
    policy,
  });
}

export function pathApproval(toolName: string, environment: Environment, path: string): Pick<ToolPlan, "approvalRule" | "matchesRule"> {
  return {
    approvalRule: literalRulePattern(toolName, path),
    matchesRule: (ruleArgs) =>
      matchesPathRuleSubject(ruleArgs, path, {
        cwd: environment.getcwd(),
        pathClass: environment.pathClass(),
        homeDir: environment.gethome(),
      }),
  };
}

export function globApproval(toolName: string, subject: string): Pick<ToolPlan, "approvalRule" | "matchesRule"> {
  return {
    approvalRule: literalRulePattern(toolName, subject),
    matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
  };
}
