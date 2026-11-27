import { isSensitiveFile } from "../tool/policies/sensitive.ts";
import { isWithinDirectory, relativePathParts, type PathClass } from "../tool/policies/path-access.ts";
import { isReadOnlyBashCommand } from "../tool/support/bash-read-only.ts";
import {
  findGitWorkTreeMarker,
  isGitControlPath,
  type GitWorkTreeMarker,
  type GitWorkTreeEnvironment,
} from "../tool/support/git-worktree.ts";
import type { ToolFileAccess } from "../tool/access.ts";
import { matchPermissionRule, type PermissionRuleMatch } from "./matches-rule.ts";
import { parseSessionGrantKey, callScopeName, ruleAppliesTo } from "./environment-scope.ts";
import type {
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from "./types.ts";

export interface PermissionState {
  mode(): PermissionMode;
  rules(): readonly PermissionRule[];
  sessionApprovalRulePatterns(): readonly string[];
  cwd(): string;
  pathClass(): PathClass;
  environment?(): GitWorkTreeEnvironment | undefined;
  /** Name of the session's root environment (what an explicitly scoped root rule names). */
  rootEnvironmentName?(): string | undefined;
}

/**
 * The workspace a call is judged against. A call on a non-root environment is judged against
 * THAT environment's cwd / path flavour / git work tree — the session's root values would
 * measure a remote path against the local checkout.
 */
interface CallScope {
  readonly key: string;
  readonly cwd: string;
  readonly pathClass: PathClass;
  readonly environment: GitWorkTreeEnvironment | undefined;
}

function scopeOf(state: PermissionState, ctx: PermissionPolicyContext): CallScope {
  const env = ctx.environment;
  if (env === undefined || env.root) {
    return { key: "", cwd: state.cwd(), pathClass: state.pathClass(), environment: state.environment?.() };
  }
  let cwd = "";
  try {
    cwd = env.environment.normpath(env.environment.getcwd());
  } catch {
    cwd = "";
  }
  return { key: env.identity, cwd, pathClass: env.environment.pathClass(), environment: env.environment };
}

const USER_CONFIGURED_SCOPES = new Set<PermissionRuleScope>(["turn-override", "project", "user"]);

const DEFAULT_APPROVE_TOOLS = new Set([
  "Read", "Grep", "Glob", "SetTodoList", "TodoList", "BackgroundList",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "CronList", "WebSearch", "WebFetch", "Agent", "AskUserQuestion", "Skill",
  "GetGoal", "SetGoalBudget", "UpdateGoal",
  // Workflow orchestrates subagents (like Agent); StructuredOutput is the schema
  // tool the Workflow runtime injects into a subagent — neither needs approval.
  "Workflow", "StructuredOutput",
]);

function firstMatchingRule(
  ctx: PermissionPolicyContext,
  rules: readonly PermissionRule[],
  decision: PermissionRuleDecision,
): PermissionRuleMatch | undefined {
  for (const rule of rules) {
    if (rule.decision !== decision) continue;
    const match = matchPermissionRule({ rule, toolName: ctx.toolCall.name, execution: ctx.plan });
    if (match !== undefined) return match;
  }
  return undefined;
}

function userRules(state: PermissionState, ctx: PermissionPolicyContext): PermissionRule[] {
  const rootName = state.rootEnvironmentName?.();
  return state.rules().filter((rule) => USER_CONFIGURED_SCOPES.has(rule.scope) && ruleAppliesTo(rule, ctx.environment, rootName));
}

function userRuleReason(decision: PermissionRuleDecision, match: PermissionRuleMatch) {
  return { rule_decision: decision, has_rule_args: match.hasRuleArgs, match_strategy: match.strategy } as const;
}

function fileAccesses(ctx: PermissionPolicyContext): ToolFileAccess[] {
  return (ctx.plan.accesses ?? []).filter((access): access is ToolFileAccess => access.kind === "file");
}
function writeFileAccesses(ctx: PermissionPolicyContext): ToolFileAccess[] {
  return fileAccesses(ctx).filter((a) => a.operation === "write" || a.operation === "readwrite");
}
function fileAccessReason(access: ToolFileAccess, extra: Record<string, boolean>) {
  return { file_access_operation: access.operation, recursive: access.recursive === true, ...extra };
}

function staged(name: string): PermissionPolicy {
  return { name, evaluate: () => undefined };
}

export const STAGED_POLICY_SLOTS: ReadonlySet<string> = new Set([
  "pre-tool-call-hook",
  "plan-mode-guard-deny",
  "exit-plan-mode-review-ask",
  "plan-mode-tool-approve",
]);

export function createPolicies(
  state: PermissionState,
  overrides?: ReadonlyMap<string, PermissionPolicy>,
): PermissionPolicy[] {
  const slot = (name: string): PermissionPolicy => overrides?.get(name) ?? staged(name);

  // Shared, memoized git-work-tree marker lookup (one walk per manager and environment; each
  // cwd is fixed). Used by both git-control-path-access-ask and git-cwd-write-approve so they
  // probe at most once per environment.
  const markerProbes = new Map<string, Promise<GitWorkTreeMarker | null>>();
  const gitMarker = (scope: CallScope): Promise<GitWorkTreeMarker | null> => {
    const environment = scope.environment;
    const cwd = scope.cwd;
    if (environment === undefined || cwd.length === 0) return Promise.resolve(null);
    let probe = markerProbes.get(scope.key);
    if (probe === undefined) {
      probe = findGitWorkTreeMarker(environment, cwd).catch(() => null);
      markerProbes.set(scope.key, probe);
    }
    return probe;
  };
  return [
    // PreToolUse hook returned a block → deny. [STAGED slot: user HookEngine]
    slot("pre-tool-call-hook"),

    // yolo mode + AskUserQuestion → deny.
    {
      name: "yolo-mode-ask-user-question-deny",
      evaluate(ctx) {
        if (state.mode() !== "yolo" || ctx.toolCall.name !== "AskUserQuestion") return undefined;
        return { kind: "deny", message: "AskUserQuestion is not allowed in yolo mode.", reason: { source: "yolo_mode_ask" } };
      },
    },

    slot("plan-mode-guard-deny"),

    // User-configured deny rule matches → deny.
    {
      name: "user-configured-deny",
      evaluate(ctx) {
        const match = firstMatchingRule(ctx, userRules(state, ctx), "deny");
        if (match === undefined) return undefined;
        const suffix = match.rule.reason ? ` Reason: ${match.rule.reason}` : "";
        return {
          kind: "deny",
          reason: userRuleReason("deny", match),
          message: `Tool "${ctx.toolCall.name}" was denied by permission rule.${suffix}`,
        };
      },
    },

    // Framework control-flow tools (handoff / sub-agent delegation) → approve. They are
    // not side effects; the sub-agent's OWN tools are permission-checked separately
    // rule above this still wins.
    {
      name: "control-flow-approve",
      evaluate(ctx) {
        return ctx.plan.handoff !== undefined || ctx.plan.controlFlow === true ? { kind: "approve" } : undefined;
      },
    },

    // yolo mode → approve (any yolo-mode block must be a deny rule above this).
    { name: "yolo-mode-approve", evaluate: () => (state.mode() === "yolo" ? { kind: "approve" } : undefined) },

    // Approve-for-session memorized rule matches → approve.
    {
      name: "session-approval-history",
      evaluate(ctx) {
        const scope = callScopeName(ctx.environment);
        for (const key of state.sessionApprovalRulePatterns()) {
          const { environment, pattern } = parseSessionGrantKey(key);
          if (environment !== scope) continue;
          const match = matchPermissionRule({
            rule: { decision: "allow", scope: "session-runtime", pattern, reason: "approve for session" },
            toolName: ctx.toolCall.name,
            execution: ctx.plan,
          });
          if (match !== undefined) {
            return { kind: "approve", reason: { has_rule_args: match.hasRuleArgs, match_strategy: match.strategy } };
          }
        }
        return undefined;
      },
    },

    // User-configured ask rule matches → ask. Marked human-only: an explicit "ask me for X"
    // is a deliberate user choice, so the auto-mode judge must not override it.
    {
      name: "user-configured-ask",
      evaluate(ctx) {
        const match = firstMatchingRule(ctx, userRules(state, ctx), "ask");
        return match ? { kind: "ask", reason: userRuleReason("ask", match), classifierApprovable: false } : undefined;
      },
    },

    // User-configured allow rule matches → approve.
    {
      name: "user-configured-allow",
      evaluate(ctx) {
        const match = firstMatchingRule(ctx, userRules(state, ctx), "allow");
        return match ? { kind: "approve", reason: userRuleReason("allow", match) } : undefined;
      },
    },

    slot("exit-plan-mode-review-ask"),
    slot("plan-mode-tool-approve"),

    // Access touches a sensitive file (.env, SSH key, credentials) → ask.
    {
      name: "sensitive-file-access-ask",
      evaluate(ctx) {
        const access = fileAccesses(ctx).find((a) => isSensitiveFile(a.path));
        return access ? { kind: "ask", reason: fileAccessReason(access, { sensitive_path: true }) } : undefined;
      },
    },

    // Access touches a `.git` control path → ask. Heuristic first (a literal `.git` component
    // relative to cwd — no I/O), then the precise work-tree marker (catches linked worktrees /
    // submodules whose control dir lives elsewhere).
    {
      name: "git-control-path-access-ask",
      async evaluate(ctx) {
        const scope = scopeOf(state, ctx);
        const cwd = scope.cwd;
        if (cwd.length === 0) return undefined;
        const pathClass = scope.pathClass;
        const accesses = fileAccesses(ctx);
        if (accesses.length === 0) return undefined;

        const direct = accesses.find((a) =>
          relativePathParts(a.path, cwd, pathClass).some((part) => part.toLowerCase() === ".git"),
        );
        if (direct !== undefined) return { kind: "ask", reason: fileAccessReason(direct, { git_control_path: true }) };

        const marker = await gitMarker(scope);
        if (marker === null) return undefined;
        const inside = accesses.find((a) => isGitControlPath(a.path, marker, pathClass));
        return inside ? { kind: "ask", reason: fileAccessReason(inside, { git_control_path: true }) } : undefined;
      },
    },

    // Write target outside cwd → ask. (reads/searches outside cwd allowed)
    {
      name: "cwd-outside-file-write-ask",
      evaluate(ctx) {
        const scope = scopeOf(state, ctx);
        const cwd = scope.cwd;
        if (cwd.length === 0) return undefined;
        const pathClass = scope.pathClass;
        const access = writeFileAccesses(ctx).find((a) => !isWithinDirectory(a.path, cwd, pathClass));
        return access ? { kind: "ask", reason: fileAccessReason(access, { cwd_outside: true }) } : undefined;
      },
    },

    // workspace mode → approve (everything inside the workspace; the sensitive-file /
    // git-control / cwd-outside-write asks above this are the workspace safety floor).
    { name: "workspace-mode-approve", evaluate: () => (state.mode() === "workspace" ? { kind: "approve" } : undefined) },

    // Default-approve list (read-only / UI helpers) → approve.
    {
      name: "default-tool-approve",
      evaluate(ctx) {
        return DEFAULT_APPROVE_TOOLS.has(ctx.toolCall.name) ? { kind: "approve" } : undefined;
      },
    },

    // A Bash command recognized as read-only → approve, the same as the read-only TOOLS above.
    // It sits below the safety floor deliberately: a read still has to clear the sensitive-file
    // and .git asks, and this only spares the ones that got past them. In `auto` mode that is
    // the point — `git status` and `ls` would otherwise each cost a judge round trip to reach
    // the same answer. Unrecognized commands return undefined and continue down the chain.
    {
      name: "bash-read-only-approve",
      evaluate(ctx) {
        if (ctx.toolCall.name !== "Bash") return undefined;
        const command = (ctx.args as { command?: unknown } | undefined)?.command;
        if (typeof command !== "string") return undefined;
        return isReadOnlyBashCommand(command) ? { kind: "approve", reason: { bash_read_only: true } } : undefined;
      },
    },

    // Write/Edit inside cwd inside a git work tree → approve (changes are recoverable via git).
    // Still overridable by name; degrades to undefined (→ fallback ask) when no environment/marker.
    overrides?.get("git-cwd-write-approve") ?? {
      name: "git-cwd-write-approve",
      async evaluate(ctx) {
        if (ctx.toolCall.name !== "Write" && ctx.toolCall.name !== "Edit") return undefined;
        const scope = scopeOf(state, ctx);
        if (scope.pathClass !== "posix") return undefined;
        const cwd = scope.cwd;
        if (cwd.length === 0) return undefined;
        const writes = writeFileAccesses(ctx);
        if (writes.length === 0) return undefined;
        if (!writes.every((a) => isWithinDirectory(a.path, cwd, scope.pathClass))) return undefined;
        if ((await gitMarker(scope)) === null) return undefined;
        return { kind: "approve", reason: { git_cwd_write: true } };
      },
    },

    // Nothing matched → ask.
    { name: "fallback-ask", evaluate: () => ({ kind: "ask" }) },
  ];
}
