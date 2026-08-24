import type { Message } from "../../protocol/index.ts";
import { BoundaryInjector, type InjectionContext, type InjectionResult } from "../injection.ts";
import type { PlanMode } from "./plan-mode.ts";

const DEDUP_MIN_TURNS = 2;
const FULL_REFRESH_TURNS = 5;

type PlanModeVariant = "full" | "sparse";

export class PlanModeInjector extends BoundaryInjector {
  readonly id = "plan_mode";
  private wasActive = false;
  private hydrated = false;
  private readonly planMode: PlanMode;

  constructor(planMode: PlanMode) {
    super();
    this.planMode = planMode;
  }

  override onContextCleared(): void {
    super.onContextCleared();
    this.wasActive = false;
    this.hydrated = false;
  }

  protected getInjection(ctx: InjectionContext): InjectionResult | null {
    const active = this.planMode.isActive;
    const planFilePath = this.planMode.planFilePath;

    if (!this.hydrated) {
      const restored = this.restoreInjectedAt(ctx, ["full", "sparse", "exit"]);
      this.wasActive = active && restored;
      this.hydrated = true;
    }

    if (!active) {
      if (!this.wasActive) return null;
      this.wasActive = false;
      this.injectedAt = null;
      return { text: exitReminder(), variant: "exit" };
    }

    if (!this.wasActive) {
      this.injectedAt = null;
      this.wasActive = true;
    }

    const variant = this.pickVariant(ctx.history);
    if (variant === null) return null;
    return { text: variant === "full" ? fullReminder(planFilePath) : sparseReminder(planFilePath), variant };
  }

  private pickVariant(history: readonly Message[]): PlanModeVariant | null {
    if (this.injectedAt === null) return "full";
    let assistantTurnsSince = 0;
    for (let i = this.injectedAt + 1; i < history.length; i++) {
      const message = history[i];
      if (message?.role === "assistant") assistantTurnsSince += 1;
      else if (message?.role === "user") return "full";
    }
    if (assistantTurnsSince >= FULL_REFRESH_TURNS) return "full";
    if (assistantTurnsSince >= DEDUP_MIN_TURNS) return "sparse";
    return null;
  }
}

function withFooter(body: string, planFilePath: string | null): string {
  return planFilePath ? `${body}\n\nPlan file: ${planFilePath}` : body;
}

function fullReminder(planFilePath: string | null): string {
  const body = `Plan mode is active. You MUST NOT edit files (except the current plan file) or otherwise change the system unless a tool request is explicitly approved. Prefer read-only tools; Bash follows the normal permission rules. This supersedes other instructions.

Workflow:
  1. Understand — explore with Glob, Grep, Read.
  2. Design — converge on the best approach; aim for a single recommendation.
  3. Review — re-read key files to confirm understanding.
  4. Write the plan to the plan file with Write/Edit.
  5. Call ExitPlanMode for user approval.

If the plan offers multiple distinct approaches, pass them as ExitPlanMode \`options\` so the user can choose. End your turn with ExitPlanMode (approval) — do not end any other way.`;
  return withFooter(body, planFilePath);
}

function sparseReminder(planFilePath: string | null): string {
  const body =
    "Plan mode still active (see full instructions earlier). Read-only except the plan file. Write/Edit the plan file, then call ExitPlanMode. If the plan has multiple approaches, pass options to ExitPlanMode.";
  return withFooter(body, planFilePath);
}

function exitReminder(): string {
  return "Plan mode is no longer active. The read-only and plan-file-only restrictions no longer apply. Continue with the approved plan using the normal tool and permission rules.";
}
