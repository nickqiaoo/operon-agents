import { BoundaryInjector, type InjectionContext, type InjectionResult } from "../injection.ts";
import type { SkillRegistry } from "./registry.ts";

export class SkillCatalogInjector extends BoundaryInjector {
  readonly id = "skill_catalog";
  private readonly registry: SkillRegistry;
  private stale = false;

  constructor(registry: SkillRegistry) {
    super();
    this.registry = registry;
  }

  markStale(): void {
    this.injectedAt = null;
    this.stale = true;
  }

  protected getInjection(ctx: InjectionContext): InjectionResult | null {
    if (!this.stale && this.restoreInjectedAt(ctx, ["catalog"])) return null;
    this.stale = false;
    const listing = this.registry.getModelSkillListing();
    if (listing.trim().length === 0) return null;
    const text =
      "Available skills — load one with the Skill tool (inline) or call its skill_<name> tool (flow) " +
      "when its description / when-to-use matches the task:\n\n" +
      listing;
    return { text, variant: "catalog" };
  }
}
