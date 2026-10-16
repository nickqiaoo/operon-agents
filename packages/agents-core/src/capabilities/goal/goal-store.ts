import type { Usage } from "../../protocol/index.ts";

export type GoalStatus = "active" | "blocked" | "paused" | "complete";

/** Tool names whose results carry the durable goal record in `details.goal`. */
export const GOAL_TOOL_NAMES = ["UpdateGoal", "SetGoalBudget"] as const;

/** Goal identity carried in goal-tool result `details`, for whoever renders the transcript.
 *  Restore does not read it — it reads {@link GoalDurable}, which also carries the counters. */
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

/** The goal's WHOLE durable state, counters included — what is stored after every change.
 *  `null`: no goal. */
export type GoalDurable = Readonly<Omit<GoalRecord, "budget">> & { readonly budget: GoalBudget };

export interface UpdateGoalInput {
  readonly objective?: string;
  readonly completionCriterion?: string;
  readonly status?: GoalStatus;
  readonly reason?: string;
}

/** Everything the session-level goal operations take as input. */
export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly budget?: GoalBudgetInput;
}

export interface GoalBudgetInput {
  readonly turns?: number;
  readonly tokens?: number;
  readonly wallClockMs?: number;
}

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Goal budget ${name} must be a positive integer.`);
  return value;
}

function normalizeBudget(input: GoalBudgetInput): GoalBudgetInput {
  const budget: { turns?: number; tokens?: number; wallClockMs?: number } = {};
  if (input.turns !== undefined) budget.turns = positiveInt("turns", input.turns);
  if (input.tokens !== undefined) budget.tokens = positiveInt("tokens", input.tokens);
  if (input.wallClockMs !== undefined) budget.wallClockMs = positiveInt("wallClockMs", input.wallClockMs);
  if (Object.keys(budget).length === 0) throw new Error("At least one goal budget field is required.");
  return budget;
}

export class GoalStore {
  private goal: GoalRecord | null = null;
  /** Set by the capability's provision; absent in a bare store (tests, replay). */
  private announce: ((snapshot: GoalSnapshot | null) => Promise<void>) | undefined;
  /** Persists the whole state after each change. Absent in a bare store (tests). */
  private persist: (() => void) | undefined;

  /**
   * Where every goal change becomes durable. Every mutation goes through this store — a tool, a
   * host command (`/goal pause`), the per-turn accounting — so persisting here, rather than in
   * the goal tools' results, is what makes a change from OUTSIDE the loop survive a reopen.
   */
  attachPersistence(persist: () => void): void {
    this.persist = persist;
  }

  private changed(): void {
    this.persist?.();
  }

  /**
   * Where a goal change becomes a `goal.updated` event. The store owns this because the store is
   * what changes: a facade that emitted on the caller's behalf could only cover the calls that
   * went through it, and left anything mutating the goal directly silently unobserved.
   */
  attachAnnouncer(announce: (snapshot: GoalSnapshot | null) => Promise<void>): void {
    this.announce = announce;
  }

  private async announced(snapshot: GoalSnapshot | null): Promise<GoalSnapshot | null> {
    await this.announce?.(snapshot);
    return snapshot;
  }

  /**
   * Start a goal, replacing any goal already running. The budget is validated BEFORE anything
   * changes, so a bad budget leaves the previous goal intact rather than half-replacing it.
   */
  async create(input: CreateGoalInput): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) throw new Error("Goal objective cannot be empty.");
    const budget = input.budget !== undefined ? normalizeBudget(input.budget) : undefined;
    if (this.has()) this.update({ status: "complete" });
    let snapshot = this.update({
      objective,
      completionCriterion: input.completionCriterion?.trim(),
      status: "active",
    });
    if (budget !== undefined) snapshot = this.setBudget(budget);
    if (snapshot === null) throw new Error("Goal was not created.");
    await this.announce?.(snapshot);
    return snapshot;
  }

  /** Change a running goal's status. Returns null (and announces nothing) when there is none. */
  private async transition(status: "active" | "blocked" | "paused", reason?: string): Promise<GoalSnapshot | null> {
    if (this.snapshot() === null) return null;
    return this.announced(this.update({ status, reason }));
  }

  pause(reason?: string): Promise<GoalSnapshot | null> {
    return this.transition("paused", reason);
  }

  resume(reason?: string): Promise<GoalSnapshot | null> {
    return this.transition("active", reason);
  }

  block(reason?: string): Promise<GoalSnapshot | null> {
    return this.transition("blocked", reason);
  }

  /** End the current goal. Returns the snapshot AS IT WAS, or null if there was none. */
  async cancel(reason?: string): Promise<GoalSnapshot | null> {
    const previous = this.snapshot();
    if (previous === null) return null;
    this.update({ status: "complete", reason });
    await this.announce?.(null);
    return previous;
  }

  /** Validate, apply and announce — the budget path a caller outside the loop should use. */
  async changeBudget(budget: GoalBudgetInput): Promise<GoalSnapshot | null> {
    return this.announced(this.setBudget(normalizeBudget(budget)));
  }

  isActive(): boolean {
    return this.goal?.status === "active";
  }

  has(): boolean {
    return this.goal !== null;
  }

  update(input: UpdateGoalInput): GoalSnapshot | null {
    if (input.status === "complete") {
      const had = this.goal !== null;
      this.goal = null;
      if (had) this.changed();
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
      this.changed();
      return this.snapshot();
    }
    if (input.objective !== undefined) this.goal.objective = input.objective;
    if (input.completionCriterion !== undefined) this.goal.completionCriterion = input.completionCriterion;
    if (input.status !== undefined) this.goal.status = input.status;
    if (input.reason !== undefined) this.goal.terminalReason = input.reason;
    else if (input.status === "active") this.goal.terminalReason = undefined;
    this.changed();
    return this.snapshot();
  }

  setBudget(budget: { turns?: number; tokens?: number; wallClockMs?: number }): GoalSnapshot | null {
    if (this.goal === null) return null;
    if (budget.turns !== undefined) this.goal.budget.turnBudget = budget.turns;
    if (budget.tokens !== undefined) this.goal.budget.tokenBudget = budget.tokens;
    if (budget.wallClockMs !== undefined) this.goal.budget.wallClockBudgetMs = budget.wallClockMs;
    this.changed();
    return this.snapshot();
  }

  /**
   * Account one finished turn of the ROOT agent, then auto-block if a budget is reached — one
   * change, journaled once. Returns true when the budget blocked the goal. A subagent's turns
   * are not the goal's: the goal driver never calls this for them.
   */
  accountTurn(usage: Usage): boolean {
    if (this.goal === null) return false;
    this.goal.turnsUsed += 1;
    this.goal.tokensUsed += usage.totalTokens;
    const blocked = this.applyBudget();
    this.changed();
    return blocked;
  }

  enforceBudget(): boolean {
    const blocked = this.applyBudget();
    if (blocked) this.changed();
    return blocked;
  }

  private applyBudget(): boolean {
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

  /** The whole durable state — see {@link GoalDurable}. */
  durable(): GoalDurable | null {
    if (this.goal === null) return null;
    return { ...this.goal, budget: { ...this.goal.budget } };
  }

  /** Restore from the value stored for the goal (undefined: none). Persists nothing. */
  restore(value: unknown): void {
    this.goal = isGoalDurable(value) ? { ...value, budget: { ...value.budget } } : null;
  }

  private wallClockMs(): number {
    return this.goal === null ? 0 : Math.max(0, Date.now() - this.goal.startedAtMs);
  }
}

function isGoalDurable(value: unknown): value is GoalDurable {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const budget = v["budget"] as Record<string, unknown> | undefined;
  return (
    typeof v["objective"] === "string" &&
    (v["status"] === "active" || v["status"] === "blocked" || v["status"] === "paused") &&
    typeof v["turnsUsed"] === "number" &&
    typeof v["tokensUsed"] === "number" &&
    typeof v["startedAtMs"] === "number" &&
    typeof budget === "object" &&
    budget !== null
  );
}
