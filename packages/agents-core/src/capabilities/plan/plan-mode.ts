import { dirname, join } from "pathe";
import type { Machine } from "../../tool/machine.ts";
import type { AgentRecord } from "../../store/index.ts";
import { readTextFile, writeTextFile } from "../../tool/support/machine-ops.ts";

export type PlanData = null | { readonly id: string; readonly content: string; readonly path: string };

/** Tool names whose results carry plan-mode state in `details`. */
export const PLAN_TOOL_NAMES = ["EnterPlanMode", "ExitPlanMode"] as const;

/** Plan-mode state carried in enter/exit tool result `details`, folded back on session open. */
export interface PlanDetails {
  readonly planActive: boolean;
  readonly planId: string | null;
  readonly planFilePath: string | null;
}

let planCounter = 0;
function newPlanId(): string {
  planCounter += 1;
  return `plan-${Date.now().toString(36)}-${planCounter.toString(36)}`;
}

export class PlanMode {
  private active = false;
  private planId: string | null = null;
  private filePath: string | null = null;
  private machine: Machine | null = null;

  attachMachine(machine: Machine): void {
    this.machine = machine;
  }

  get isActive(): boolean {
    return this.active;
  }

  get planFilePath(): string | null {
    return this.filePath;
  }

  async enter(createFile = true): Promise<void> {
    if (this.active) throw new Error("Already in plan mode.");
    const id = newPlanId();
    const path = this.planFilePathFor(id);
    this.active = true;
    this.planId = id;
    this.filePath = path;
    if (createFile) {
      await this.ensureDir(path);
      await this.writeEmpty(path);
    }
  }

  exit(): void {
    this.active = false;
    this.planId = null;
    this.filePath = null;
  }

  /** Current state for journaling into an enter/exit tool result `details`. */
  details(): PlanDetails {
    return { planActive: this.active, planId: this.planId, planFilePath: this.filePath };
  }

  /** Rebuild from the log: the latest enter/exit result is the current plan-mode state.
   *  Restores in-memory flags only — never re-creates the plan file (no side effects). */
  reconstruct(entries: readonly AgentRecord[]): void {
    let latest: PlanDetails | undefined;
    for (const entry of entries) {
      if (entry.type !== "context.append_message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || !isPlanToolName(msg.toolName)) continue;
      const d = msg.details as Partial<PlanDetails> | undefined;
      if (d && typeof d.planActive === "boolean") {
        latest = { planActive: d.planActive, planId: d.planId ?? null, planFilePath: d.planFilePath ?? null };
      }
    }
    this.active = latest?.planActive ?? false;
    this.planId = latest?.planId ?? null;
    this.filePath = latest?.planFilePath ?? null;
  }

  async data(): Promise<PlanData> {
    if (!this.planId || !this.filePath || !this.machine) return null;
    let content = "";
    try {
      content = await readTextFile(this.machine, this.filePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return { id: this.planId, content, path: this.filePath };
  }

  private planFilePathFor(id: string): string {
    const home = this.safeHome();
    const base = home ? join(home, "plans") : join(this.safeCwd(), "plan");
    return join(base, `${id}.md`);
  }

  private safeHome(): string {
    try {
      return this.machine?.gethome() ?? "";
    } catch {
      return "";
    }
  }

  private safeCwd(): string {
    try {
      return this.machine?.getcwd() ?? "";
    } catch {
      return "";
    }
  }

  private async ensureDir(path: string): Promise<void> {
    await this.machine?.mkdir(dirname(path), { parents: true, existOk: true });
  }

  private async writeEmpty(path: string): Promise<void> {
    if (this.machine) await writeTextFile(this.machine, path, "");
  }
}

function isPlanToolName(name: string): boolean {
  return (PLAN_TOOL_NAMES as readonly string[]).includes(name);
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}
