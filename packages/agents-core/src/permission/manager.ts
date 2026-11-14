import type { AuthorizeToolExecutionResult, ResolvedToolExecutionHookContext } from "../loop/types.ts";
import type { Message } from "../protocol/index.ts";
import type { PathClass } from "../tool/policies/path-access.ts";
import type { Tool } from "../tool/types.ts";
import type { GitWorkTreeEnvironment } from "../tool/support/git-worktree.ts";
import type { Logger } from "../logging/index.ts";
import { createPolicies, type PermissionState } from "./policies.ts";
import { permissionPatternError } from "./matches-rule.ts";
import { permissionDenialDetails } from "./denial.ts";
import type {
  AutoApprovalVerdict,
  AutoApprover,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyResult,
  PermissionRule,
  Responder,
} from "./types.ts";

/**
 * How many `auto`-mode blocks go back to the model before a person is asked instead. A block is
 * refused with its reason so the agent can take another route; but an agent that keeps hitting
 * blocks — the same thing three times running, or twenty times in all — needs a human to look,
 * so that block becomes an approval prompt and both counts start over. Any call that goes ahead
 * resets the consecutive count.
 */
export const AUTO_MODE_DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 } as const;

/** What the model reads when the judge blocks a call: the reason, and what to do instead. */
function autoModeBlockMessage(reason: string): string {
  return [
    `Permission for this action was denied by the auto mode safety classifier. Reason: ${reason}`,
    "Do not try to work around this denial — rephrasing, encoding, or reaching the same effect another way is blocked too. If other parts of the task don't need this action, continue with those. If it is genuinely needed, tell the user exactly what you want to run and why, and let them decide: their explicit go-ahead naming this action and its target clears most blocks, or they can approve it outside auto mode.",
  ].join("\n");
}

export interface PermissionManagerOptions {
  readonly mode?: PermissionMode;
  readonly rules?: readonly PermissionRule[];
  readonly responder?: Responder;
  readonly cwd?: string;
  readonly pathClass?: PathClass;
  readonly environment?: GitWorkTreeEnvironment;
  readonly policyOverrides?: ReadonlyMap<string, PermissionPolicy>;
  /** The `auto`-mode judge. Consulted for would-prompt actions when `mode === "auto"`. */
  readonly autoApprover?: AutoApprover;
  /** Supplies the live conversation to the judge (the authorize ctx carries no transcript).
   *  Standalone default; a frame-scoped authorizer (`authorizerFor`) overrides it. */
  readonly getTranscript?: () => readonly Message[];
  /** Supplies the tool registry to the judge so it can project prior tool calls faithfully.
   *  Standalone default; a frame-scoped authorizer (`authorizerFor`) overrides it. */
  readonly getTools?: () => readonly Tool[];
  /** Optional diagnostics sink: load-time warnings (a malformed rule pattern silently never
   *  matches — fail-open for `deny` — so such rules are flagged as they enter the manager)
   *  and `auto`-mode judge outcomes (verdict/reason/duration per consult, judge errors). */
  readonly logger?: Logger;
}

/**
 * Frame-scoped context for the `auto`-mode judge. The manager is a session-level
 * singleton (shared mode / rules / approval memory), but the transcript and tool registry
 * belong to ONE runtime frame — concurrent sub-agent frames each have their own. They are
 * therefore never stored on the manager: each frame binds its own via `authorizerFor`.
 */
export interface AuthorizeProviders {
  readonly getTranscript?: () => readonly Message[];
  readonly getTools?: () => readonly Tool[];
}

export class PermissionManager {
  private currentMode: PermissionMode;
  private readonly ruleList: PermissionRule[];
  private readonly sessionPatterns = new Set<string>();
  private readonly responder: Responder | undefined;
  private readonly cwd: string;
  private readonly pathClass: PathClass;
  private readonly environment: GitWorkTreeEnvironment | undefined;
  private readonly policies: PermissionPolicy[];
  private readonly autoApprover: AutoApprover | undefined;
  private readonly getTranscript: (() => readonly Message[]) | undefined;
  private readonly getTools: (() => readonly Tool[]) | undefined;
  private readonly logger: Logger | undefined;
  private consecutiveBlocks = 0;
  private totalBlocks = 0;

  constructor(options: PermissionManagerOptions = {}) {
    this.currentMode = options.mode ?? "manual";
    this.ruleList = [...(options.rules ?? [])];
    this.responder = options.responder;
    this.cwd = options.cwd ?? "";
    this.pathClass = options.pathClass ?? "posix";
    this.environment = options.environment;
    this.autoApprover = options.autoApprover;
    this.getTranscript = options.getTranscript;
    this.getTools = options.getTools;
    this.logger = options.logger;
    for (const rule of this.ruleList) this.warnIfMalformed(rule);

    const state: PermissionState = {
      mode: () => this.currentMode,
      rules: () => this.ruleList,
      sessionApprovalRulePatterns: () => [...this.sessionPatterns],
      cwd: () => this.cwd,
      pathClass: () => this.pathClass,
      environment: () => this.environment,
    };
    this.policies = createPolicies(state, options.policyOverrides);
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }
  /** The approve-for-session grants made so far (approval-rule subjects), in grant order. */
  get sessionGrants(): readonly string[] {
    return [...this.sessionPatterns];
  }
  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }
  addRule(rule: PermissionRule): void {
    this.warnIfMalformed(rule);
    this.ruleList.push(rule);
  }

  /** A malformed pattern makes the rule silently never match — fail-open for `deny`. Surface
   *  it once, when the rule enters the manager, rather than swallowing it on every match. */
  private warnIfMalformed(rule: PermissionRule): void {
    const error = permissionPatternError(rule.pattern);
    if (error === undefined) return;
    this.logger?.log(
      "warn",
      `Permission rule with malformed pattern ${JSON.stringify(rule.pattern)} (decision "${rule.decision}") will never match — for a deny rule this fails open. ${error}`,
      { pattern: rule.pattern, decision: rule.decision },
    );
  }
  /**
   * Bind frame-scoped judge context (this frame's live transcript + tool registry) to an
   * authorizer. Shared session state (mode/rules/approval memory) stays on the manager;
   * the providers live only in the returned closure, so concurrent frames can't overwrite
   * each other's.
   */
  authorizerFor(providers: AuthorizeProviders): (ctx: ResolvedToolExecutionHookContext) => Promise<AuthorizeToolExecutionResult | undefined> {
    return (ctx) => this.authorizeWith(ctx, providers);
  }

  /** Standalone authorize: judge context falls back to the constructor-supplied providers. */
  readonly authorize = async (
    ctx: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined> => this.authorizeWith(ctx, undefined);

  private async authorizeWith(
    ctx: ResolvedToolExecutionHookContext,
    providers: AuthorizeProviders | undefined,
  ): Promise<AuthorizeToolExecutionResult | undefined> {
    let result: PermissionPolicyResult | undefined;
    let policyName: string | undefined;
    for (const policy of this.policies) {
      result = await policy.evaluate(ctx);
      if (result) {
        policyName = policy.name;
        break;
      }
    }

    if (!result || result.kind === "approve") return this.proceed();
    if (result.kind === "deny") {
      return { block: true, reason: result.message ?? "Denied by permission policy.", blockDetails: permissionDenialDetails("blocked-by-permissions") };
    }

    // `auto` mode: hand this would-prompt action to the model judge instead of a human.
    // The static chain already short-circuited approve/deny above, so the judge only ever
    // sees genuine asks — including the safety floor (sensitive file / .git / cwd-outside),
    // which is what keeps the judge honest. `classifierApprovable === false` (e.g. an
    // explicit user ask rule) stays human-only. Fail-closed: a thrown judge escalates.
    if (this.currentMode === "auto" && this.autoApprover && result.classifierApprovable !== false) {
      let verdict: AutoApprovalVerdict | undefined;
      const startedAt = Date.now();
      try {
        verdict = await this.autoApprover.classify({
          ctx,
          transcript: (providers?.getTranscript ?? this.getTranscript)?.() ?? [],
          approvalRule: ctx.plan.approvalRule,
          tools: (providers?.getTools ?? this.getTools)?.(),
        });
        // Without this trail, a mis-tuned or dead judge is indistinguishable from "auto
        // mode just always asks" — every escalation looks like a normal approval prompt.
        this.logger?.log(verdict.decision === "allow" ? "debug" : "info", `auto-approval judge: ${verdict.decision}`, {
          toolName: ctx.toolCall.name,
          approvalRule: ctx.plan.approvalRule,
          durationMs: Date.now() - startedAt,
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
          ...(verdict.category !== undefined ? { category: verdict.category } : {}),
        });
      } catch (error) {
        // judge unavailable → escalate to the human path below
        this.logger?.log("warn", "auto-approval judge threw; escalating to approval", {
          toolName: ctx.toolCall.name,
          approvalRule: ctx.plan.approvalRule,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (verdict?.decision === "allow") return this.proceed(); // judge cleared it → no prompt
      if (verdict?.decision === "block") {
        const reason = verdict.reason ?? "Blocked by the auto-approval judge.";
        this.consecutiveBlocks += 1;
        this.totalBlocks += 1;
        const limits = AUTO_MODE_DENIAL_LIMITS;
        if (this.consecutiveBlocks < limits.maxConsecutive && this.totalBlocks < limits.maxTotal) {
          return {
            block: true,
            reason: autoModeBlockMessage(reason),
            blockDetails: permissionDenialDetails("automode-blocked", verdict.category),
          };
        }
        this.logger?.log("warn", "auto-mode denial limit reached; asking for approval instead", {
          toolName: ctx.toolCall.name,
          approvalRule: ctx.plan.approvalRule,
          consecutiveBlocks: this.consecutiveBlocks,
          totalBlocks: this.totalBlocks,
          reason,
        });
        this.consecutiveBlocks = 0;
        this.totalBlocks = 0;
      }
      // escalate, or a block past the denial limit → the responder / interrupt handling below
    }

    //   • no Responder injected here (the Runner-driven / durable path) → reify + bubble
    //     `interrupt`; the loop suspends and the Runner's onInterrupt decides live/durable.
    //   • a Responder IS injected (standalone / live use) → answer in place.
    if (this.responder === undefined) {
      return {
        interrupt: {
          kind: "approval",
          toolCallId: ctx.toolCall.id,
          toolName: ctx.toolCall.name,
          approvalRule: ctx.plan.approvalRule,
          policyName,
          display: ctx.plan.display,
        },
      };
    }
    const response = await this.responder.requestApproval(
      {
        toolCallId: ctx.toolCall.id,
        toolName: ctx.toolCall.name,
        approvalRule: ctx.plan.approvalRule,
        display: ctx.plan.display,
      },
      { signal: ctx.signal },
    );
    const resolved = result.resolveApproval?.(response);
    if (resolved?.kind === "deny") {
      return { block: true, reason: resolved.message ?? "Denied.", blockDetails: permissionDenialDetails("blocked-by-permissions") };
    }
    if (response.decision === "approved") {
      if (response.scope === "session") this.sessionPatterns.add(ctx.plan.approvalRule);
      return this.proceed();
    }
    return {
      block: true,
      reason: response.feedback ?? `Tool ${ctx.toolCall.name} was ${response.decision} by the user.`,
      blockDetails: permissionDenialDetails("rejected-by-user"),
    };
  }

  /** The call goes ahead: the agent made progress, so its run of auto-mode blocks is over. */
  private proceed(): undefined {
    this.consecutiveBlocks = 0;
    return undefined;
  }

  applyApproval(approvalRule: string, response: { decision: "approved" | "rejected" | "cancelled"; scope?: "session" }): boolean {
    if (response.decision === "approved") {
      if (response.scope === "session") this.sessionPatterns.add(approvalRule);
      return true;
    }
    return false;
  }
}
