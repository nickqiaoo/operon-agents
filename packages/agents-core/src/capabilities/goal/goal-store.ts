import type { Usage } from "../../protocol/index.ts";
import type { AgentRecord } from "../../store/index.ts";

export type GoalStatus = "active" | "blocked" | "paused" | "complete";

/** Tool names whose results carry the durable goal record in `details.goal`. */
export const GOAL_TOOL_NAMES = ["UpdateGoal", "SetGoalBudget"] as const;

/** Durable goal identity carried in goal-tool result `details` (counters are NOT stored — they
 *  are re-derived from the log's per-turn `usage` entries, exactly as live accrued them). */
export interface GoalPersisted {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly budget: GoalBudget;
  readonly startedAtMs: number;
  readonly terminalReason?: string;
}

export interface GoalDetails {
  readonly goal: GoalPersisted | null;
}

export interface GoalBudget {
  readonly turnBudget: number | null;
  readonly tokenBudget: number | null;
  readonly wallClockBudgetMs: number | null;
}

export interface GoalSnapshot {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: Exclude<GoalStatus, "complete">;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly terminalReason?: string;
  readonly budget: GoalBudget & {
    readonly remainingTurns: number | null;
    readonly remainingTokens: number | null;
    readonly remainingWallClockMs: number | null;
  };
}

interface GoalRecord {
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  budget: { turnBudget: number | null; tokenBudget: number | null; wallClockBudgetMs: number | null };
  turnsUsed: number;
  tokensUsed: number;
  startedAtMs: number;
  terminalReason?: string;
}

export interface UpdateGoalInput {
  readonly objective?: string;
  readonly completionCriterion?: string;
  readonly status?: GoalStatus;
  readonly reason?: string;
}

export class GoalStore {
  private goal: GoalRecord | null = null;

  isActive(): boolean {
    return this.goal?.status === "active";
  }

  has(): boolean {
    return this.goal !== null;
  }

  update(input: UpdateGoalInput): GoalSnapshot | null {
    if (input.status === "complete") {
      this.goal = null;
      return null;
    }
    if (this.goal === null) {
      if (input.objective === undefined) {
        throw new Error("UpdateGoal: an `objective` is required to create a goal.");
      }
      this.goal = {
        objective: input.objective,
        completionCriterion: input.completionCriterion,
        status: input.status ?? "active",
        budget: { turnBudget: null, tokenBudget: null, wallClockBudgetMs: null },
        turnsUsed: 0,
        tokensUsed: 0,
        startedAtMs: Date.now(),
        terminalReason: input.reason,
      };
      return this.snapshot();
    }
    if (input.objective !== undefined) this.goal.objective = input.objective;
    if (input.completionCriterion !== undefined) this.goal.completionCriterion = input.completionCriterion;
    if (input.status !== undefined) this.goal.status = input.status;
    if (input.reason !== undefined) this.goal.terminalReason = input.reason;
    else if (input.status === "active") this.goal.terminalReason = undefined;
    return this.snapshot();
  }

  setBudget(budget: { turns?: number; tokens?: number; wallClockMs?: number }): GoalSnapshot | null {
    if (this.goal === null) return null;
    if (budget.turns !== undefined) this.goal.budget.turnBudget = budget.turns;
    if (budget.tokens !== undefined) this.goal.budget.tokenBudget = budget.tokens;
    if (budget.wallClockMs !== undefined) this.goal.budget.wallClockBudgetMs = budget.wallClockMs;
    return this.snapshot();
  }

  recordTurn(usage: Usage): void {
    if (this.goal === null) return;
    this.goal.turnsUsed += 1;
    this.goal.tokensUsed += usage.totalTokens;
  }

  enforceBudget(): boolean {
    if (this.goal === null || this.goal.status !== "active") return false;
    const { budget } = this.goal;
    const overTurns = budget.turnBudget !== null && this.goal.turnsUsed >= budget.turnBudget;
    const overTokens = budget.tokenBudget !== null && this.goal.tokensUsed >= budget.tokenBudget;
    const overTime = budget.wallClockBudgetMs !== null && this.wallClockMs() >= budget.wallClockBudgetMs;
    if (overTurns || overTokens || overTime) {
      this.goal.status = "blocked";
      this.goal.terminalReason = overTurns
        ? "turn budget reached"
        : overTokens
          ? "token budget reached"
          : "time budget reached";
      return true;
    }
    return false;
  }

  snapshot(): GoalSnapshot | null {
    if (this.goal === null || this.goal.status === "complete") return null;
    const { budget } = this.goal;
    return {
      objective: this.goal.objective,
      completionCriterion: this.goal.completionCriterion,
      status: this.goal.status,
      turnsUsed: this.goal.turnsUsed,
      tokensUsed: this.goal.tokensUsed,
      wallClockMs: this.wallClockMs(),
      terminalReason: this.goal.terminalReason,
      budget: {
        turnBudget: budget.turnBudget,
        tokenBudget: budget.tokenBudget,
        wallClockBudgetMs: budget.wallClockBudgetMs,
        remainingTurns: budget.turnBudget === null ? null : Math.max(0, budget.turnBudget - this.goal.turnsUsed),
        remainingTokens: budget.tokenBudget === null ? null : Math.max(0, budget.tokenBudget - this.goal.tokensUsed),
        remainingWallClockMs:
          budget.wallClockBudgetMs === null ? null : Math.max(0, budget.wallClockBudgetMs - this.wallClockMs()),
      },
    };
  }

  /** Durable record for journaling into a goal-tool result `details` (null when no goal). */
  persisted(): GoalPersisted | null {
    if (this.goal === null) return null;
    return {
      objective: this.goal.objective,
      completionCriterion: this.goal.completionCriterion,
      status: this.goal.status,
      budget: { ...this.goal.budget },
      startedAtMs: this.goal.startedAtMs,
      terminalReason: this.goal.terminalReason,
    };
  }

  /**
   * Rebuild from the log by replaying it in order through the SAME mutations as live:
   * each goal-tool result re-applies the durable record; each per-turn `usage` entry accrues a
   * turn iff the goal is active then auto-blocks on budget — mirroring `goalDriver`. So counters
   * and budget status come out identical to the live run, and correct for the current log.
   */
  reconstruct(entries: readonly AgentRecord[]): void {
    this.goal = null;
    for (const entry of entries) {
      if (entry.type === "context.append_message") {
        const msg = entry.message;
        if (msg.role !== "toolResult" || !isGoalToolName(msg.toolName)) continue;
        const details = msg.details as Partial<GoalDetails> | undefined;
        if (details === undefined || !("goal" in details)) continue;
        this.applyPersisted(details.goal ?? null);
      } else if (entry.type === "usage.record" && this.isActive()) {
        // Matches goalDriver: account the finished turn, then auto-block if a budget hit.
        this.recordTurn(entry.usage);
        this.enforceBudget();
      }
    }
  }

  private applyPersisted(p: GoalPersisted | null): void {
    if (p === null) {
      this.goal = null;
      return;
    }
    if (this.goal === null) {
      this.goal = {
        objective: p.objective,
        completionCriterion: p.completionCriterion,
        status: p.status,
        budget: { ...p.budget },
        turnsUsed: 0,
        tokensUsed: 0,
        startedAtMs: p.startedAtMs,
        terminalReason: p.terminalReason,
      };
      return;
    }
    // Update of an existing goal: replace the durable fields, keep accrued counters.
    this.goal.objective = p.objective;
    this.goal.completionCriterion = p.completionCriterion;
    this.goal.status = p.status;
    this.goal.budget = { ...p.budget };
    this.goal.startedAtMs = p.startedAtMs;
    this.goal.terminalReason = p.terminalReason;
  }

  private wallClockMs(): number {
    return this.goal === null ? 0 : Math.max(0, Date.now() - this.goal.startedAtMs);
  }
}

function isGoalToolName(name: string): boolean {
  return (GOAL_TOOL_NAMES as readonly string[]).includes(name);
}
