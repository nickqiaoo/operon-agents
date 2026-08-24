import { randomUUID } from "node:crypto";
import { systemReminder } from "../injection.ts";
import type { EventSink } from "../../events/index.ts";
import type { SteerBus } from "../../loop/steer.ts";
import { SkillNotFoundError, type SkillRegistry } from "./registry.ts";
import {
  isUserActivatableSkillType,
  summarizeSkill,
  type SkillDefinition,
  type SkillSource,
  type SkillSummary,
} from "./types.ts";

export type SkillActivationTrigger = "user-slash" | "model-tool" | "nested-skill";

export interface ActivateSkillRequest {
  readonly name: string;
  readonly args?: string;
  readonly trigger?: SkillActivationTrigger;
  readonly address?: string;
}

export interface SkillActivationResult {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly trigger: SkillActivationTrigger;
  readonly skillPath: string;
  readonly skillSource: SkillSource;
  readonly turnId: string | null;
}

export class UnsupportedSkillActivationError extends Error {
  readonly skillName: string;
  readonly skillType?: string;

  constructor(skill: SkillDefinition) {
    super(`Skill "${skill.name}" cannot be activated by the user`);
    this.name = "UnsupportedSkillActivationError";
    this.skillName = skill.name;
    this.skillType = skill.metadata.type;
  }
}

export interface SkillsServiceRuntime {
  readonly sessionId: string;
  readonly events: EventSink;
  readonly steer: SteerBus;
}

export class SkillsService {
  private readonly registry: SkillRegistry;
  private runtime?: SkillsServiceRuntime;

  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  attach(runtime: SkillsServiceRuntime): void {
    this.runtime = runtime;
  }

  listSkills(): readonly SkillSummary[] {
    return this.registry.listSkills().map(summarizeSkill);
  }

  async activateSkill(request: ActivateSkillRequest): Promise<SkillActivationResult> {
    const runtime = this.runtime;
    if (runtime === undefined) throw new Error("SkillsService is not attached to an open session.");

    const skill = this.registry.getSkill(request.name.trim());
    if (skill === undefined) throw new SkillNotFoundError(request.name);
    if (!isUserActivatableSkillType(skill.metadata.type)) throw new UnsupportedSkillActivationError(skill);

    const activationId = randomUUID();
    const skillArgs = request.args ?? "";
    const trigger = request.trigger ?? "user-slash";
    const body = this.registry.renderSkillPrompt(skill, skillArgs);
    const argsAttr = skillArgs.length > 0 ? ` args="${escapeXmlAttr(skillArgs)}"` : "";
    const wrapped = systemReminder(
      `<skill-loaded name="${escapeXmlAttr(skill.name)}"${argsAttr}>\n${body}\n</skill-loaded>`,
    );

    const { wakeTurnId: turnId } = runtime.steer.steer(wrapped, { kind: "user" });
    await runtime.events.emit({
      type: "skill.activated",
      address: request.address ?? "main",
      sessionId: runtime.sessionId,
      activationId,
      skillName: skill.name,
      ...(skillArgs.length > 0 ? { skillArgs } : {}),
      trigger,
      skillPath: skill.path,
      skillSource: skill.source,
    });

    return {
      activationId,
      skillName: skill.name,
      ...(skillArgs.length > 0 ? { skillArgs } : {}),
      trigger,
      skillPath: skill.path,
      skillSource: skill.source,
      turnId,
    };
  }
}

function escapeXmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
