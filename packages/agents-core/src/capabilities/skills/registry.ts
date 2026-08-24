import { expandSkillParameters, skillArgumentNames } from "./parser.ts";
import { discoverSkills, type DiscoverSkillsOptions } from "./scanner.ts";
import type { Machine } from "../../tool/machine.ts";
import type { SkillCatalog, SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from "./types.ts";
import { isFlowSkillType, isInlineSkillType, normalizeSkillName } from "./types.ts";

const LISTING_DESC_MAX = 250;

export class SkillNotFoundError extends Error {
  readonly skillName: string;
  constructor(skillName: string) {
    super(`Skill "${skillName}" is not registered`);
    this.name = "SkillNotFoundError";
    this.skillName = skillName;
  }
}

export interface SkillRegistryOptions {
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;
}

export class SkillRegistry implements SkillCatalog {
  private readonly byName = new Map<string, SkillDefinition>();
  private readonly roots: string[] = [];
  private readonly skipped: SkippedSkill[] = [];
  private readonly onWarning: (message: string, cause?: unknown) => void;
  private sessionId?: string;

  constructor(options: SkillRegistryOptions = {}) {
    this.onWarning = options.onWarning ?? (() => {});
    this.sessionId = options.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  async loadRoots(machine: Machine, roots: readonly SkillRoot[]): Promise<void> {
    for (const root of roots) {
      if (!this.roots.includes(root.path)) this.roots.push(root.path);
    }
    const skills = await discoverSkills(machine, {
      roots,
      onWarning: this.onWarning,
      onSkippedByPolicy: (skill) => this.skipped.push(skill),
    } satisfies DiscoverSkillsOptions);
    for (const skill of skills) {
      const key = normalizeSkillName(skill.name);
      if (!this.byName.has(key)) this.byName.set(key, skill);
    }
  }

  registerBuiltinSkill(skill: SkillDefinition): void {
    this.register(skill.source === "builtin" ? skill : { ...skill, source: "builtin" });
  }

  register(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    const key = normalizeSkillName(skill.name);
    if (options.replace === true || !this.byName.has(key)) this.byName.set(key, skill);
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.byName.get(normalizeSkillName(name));
  }

  listSkills(): readonly SkillDefinition[] {
    return [...this.byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listInvocableSkills(): readonly SkillDefinition[] {
    return this.listSkills().filter(
      (skill) => skill.metadata.disableModelInvocation !== true && isInlineSkillType(skill.metadata.type),
    );
  }

  listFlowSkills(): readonly SkillDefinition[] {
    return this.listSkills().filter(
      (skill) => skill.metadata.disableModelInvocation !== true && isFlowSkillType(skill.metadata.type),
    );
  }

  getSkillRoots(): readonly string[] {
    return [...this.roots];
  }

  getSkippedByPolicy(): readonly SkippedSkill[] {
    return [...this.skipped];
  }

  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    const content = expandSkillParameters(skill.content, rawArgs, {
      skillDir: skill.dir,
      sessionId: this.sessionId,
      argumentNames: skillArgumentNames(skill.metadata),
    });
    const plugin = skill.plugin;
    if (plugin?.instructions === undefined || plugin.instructions.trim().length === 0) return content;
    return (
      `<plugin-instructions plugin="${escapeXmlAttr(plugin.id)}">\n${plugin.instructions}\n</plugin-instructions>\n\n${content}`
    );
  }

  getModelSkillListing(): string {
    const groups = renderGroupedSkills([...this.listInvocableSkills(), ...this.listFlowSkills()], formatModelSkill);
    return groups.length === 0 ? "" : groups;
  }
}

const SOURCE_GROUPS: ReadonlyArray<{ readonly source: SkillSource; readonly label: string }> = [
  { source: "project", label: "Project" },
  { source: "user", label: "User" },
  { source: "extra", label: "Extra" },
  { source: "builtin", label: "Built-in" },
];

function renderGroupedSkills(
  skills: readonly SkillDefinition[],
  format: (skill: SkillDefinition) => readonly string[],
): string {
  const lines: string[] = [];
  for (const group of SOURCE_GROUPS) {
    const groupSkills = skills
      .filter((skill) => skill.source === group.source)
      .toSorted((a, b) => a.name.localeCompare(b.name));
    if (groupSkills.length === 0) continue;
    lines.push(`### ${group.label}`);
    for (const skill of groupSkills) lines.push(...format(skill));
  }
  return lines.join("\n");
}

function formatModelSkill(skill: SkillDefinition): readonly string[] {
  const kind = isFlowSkillType(skill.metadata.type) ? " (flow)" : "";
  const lines = [`- ${skill.name}${kind}: ${truncate(skill.description, LISTING_DESC_MAX)}`];
  if (typeof skill.metadata.whenToUse === "string" && skill.metadata.whenToUse.length > 0) {
    lines.push(`  When to use: ${skill.metadata.whenToUse}`);
  }
  return lines;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function escapeXmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
