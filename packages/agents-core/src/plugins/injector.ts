import { BoundaryInjector, type InjectionContext, type InjectionResult } from "../index.ts";
import type { PluginManager } from "./manager.ts";

export type SessionStartSkillResolver = (pluginId: string, skillName: string) => string | undefined;

export class PluginSessionStartInjector extends BoundaryInjector {
  readonly id = "plugin-session-start";
  private readonly manager: PluginManager;
  private readonly resolveSkill: SessionStartSkillResolver;

  constructor(manager: PluginManager, resolveSkill: SessionStartSkillResolver) {
    super();
    this.manager = manager;
    this.resolveSkill = resolveSkill;
  }

  protected getInjection(ctx: InjectionContext): InjectionResult | null {
    if (this.restoreInjectedAt(ctx, ["plugin_session_start"])) return null;
    const sessionStarts = this.manager.sessionStarts();
    if (sessionStarts.length === 0) return null;

    const blocks: string[] = [];
    for (const ss of sessionStarts) {
      const body = this.resolveSkill(ss.pluginId, ss.skillName);
      if (body === undefined) continue; // skill not found in the registry — skip
      blocks.push(`<plugin_session_start plugin="${attr(ss.pluginId)}" skill="${attr(ss.skillName)}">\n${body}\n</plugin_session_start>`);
    }
    if (blocks.length === 0) return null;
    return { text: blocks.join("\n"), variant: "plugin_session_start" };
  }
}

function attr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
