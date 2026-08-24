import type { Capability, SessionContext } from "../capability.ts";
import { SkillRegistry } from "./registry.ts";
import { resolveSkillRoots } from "./scanner.ts";
import { skillTool } from "./skill-tool.ts";
import { flowSkillProvider } from "./flow-provider.ts";
import { SkillCatalogInjector } from "./injector.ts";
import { SkillsService } from "./service.ts";
import type { FlowSkillExecutor, SkillDefinition, SkillRoot } from "./types.ts";

export type { SkillRegistryOptions } from "./registry.ts";
export { SkillRegistry, SkillNotFoundError } from "./registry.ts";
export {
  parseSkillText,
  parseSkillFromMachine,
  parseFrontmatter,
  expandSkillParameters,
  skillArgumentNames,
  SkillParseError,
  FrontmatterError,
  UnsupportedSkillTypeError,
} from "./parser.ts";
export { discoverSkills, resolveSkillRoots } from "./scanner.ts";
export type { ResolveSkillRootsOptions, DiscoverSkillsOptions } from "./scanner.ts";
export { skillTool, MAX_SKILL_QUERY_DEPTH, NestedSkillTooDeepError } from "./skill-tool.ts";
export { flowSkillProvider, flowSkillToolName } from "./flow-provider.ts";
export { SkillCatalogInjector } from "./injector.ts";
export { SkillsService, UnsupportedSkillActivationError } from "./service.ts";
export type { ActivateSkillRequest, SkillActivationResult, SkillActivationTrigger } from "./service.ts";
export {
  normalizeSkillName,
  isInlineSkillType,
  isFlowSkillType,
  isUserActivatableSkillType,
  isSupportedSkillType,
  summarizeSkill,
} from "./types.ts";
export type {
  SkillCatalog,
  SkillDefinition,
  SkillMetadata,
  SkillSource,
  SkillSummary,
  SkillRoot,
  SkillPluginContext,
  SkippedSkill,
  FlowSkillExecutor,
  FlowSkillRequest,
} from "./types.ts";

export interface SkillsOptions {
  readonly registry?: SkillRegistry;
  readonly roots?: readonly SkillRoot[];
  /**
   * Additional skill roots resolved lazily at session-open (merged after `roots`). Use this for
   * roots that aren't known at construction or change over time — e.g. installed plugins'
   * skill dirs, whose owning manager loads on its own schedule. The provider should ensure its
   * source is ready (await any load) and return an empty array when there's nothing to add.
   */
  readonly dynamicRoots?: () => readonly SkillRoot[] | Promise<readonly SkillRoot[]>;
  /**
   * Treat `roots`/`dynamicRoots` as ADDITIONS to the default `<projectDir>/.agents/skills` and
   * `~/.agents/skills` roots instead of a replacement for them. Hosts that hand over plugin skill
   * dirs want this — without it, installing one skill-bearing plugin silently hides every
   * project- and user-level skill. Off by default so tests and fully-controlled hosts keep
   * scanning exactly the roots they pass.
   */
  readonly includeDefaultRoots?: boolean;
  readonly projectDir?: string;
  readonly userHomeDir?: string;
  readonly builtinDir?: string;
  readonly extraDirs?: readonly string[];
  readonly builtinSkills?: readonly SkillDefinition[];
  readonly flowExecutor?: FlowSkillExecutor;
  readonly onWarning?: (message: string, cause?: unknown) => void;
}

export function skillsCapability(options: SkillsOptions = {}): Capability {
  const registry = options.registry ?? new SkillRegistry({ onWarning: options.onWarning });
  const service = new SkillsService(registry);

  return {
    name: "skills",
    tools: [skillTool(registry)],
    toolProviders: [flowSkillProvider(registry, options.flowExecutor)],
    injectors: [new SkillCatalogInjector(registry)],
    service,
    openSession: async (ctx: SessionContext) => {
      registry.setSessionId(ctx.sessionId);
      for (const skill of options.builtinSkills ?? []) registry.registerBuiltinSkill(skill);
      // Static roots + any lazily-provided ones (e.g. enabled plugins' skill dirs). The provider
      // runs per session-open so it reflects the current set even though the harness is shared.
      const dynamic = options.dynamicRoots ? await options.dynamicRoots() : [];
      const explicitRoots = [...(options.roots ?? []), ...dynamic];
      const roots = await resolveSkillRoots(ctx.machine, {
        ...(explicitRoots.length > 0 ? { explicitRoots } : {}),
        ...(options.includeDefaultRoots === true ? { includeDefaults: true } : {}),
        // Default the project root to the session's working directory so
        // `<cwd>/.agents/skills` is scanned per-session (the harness is shared,
        // so this can't be a static option).
        projectDir: options.projectDir ?? ctx.machine.getcwd(),
        ...(options.userHomeDir !== undefined ? { userHomeDir: options.userHomeDir } : {}),
        ...(options.builtinDir !== undefined ? { builtinDir: options.builtinDir } : {}),
        ...(options.extraDirs !== undefined ? { extraDirs: options.extraDirs } : {}),
      });
      await registry.loadRoots(ctx.machine, roots);
      service.attach({ sessionId: ctx.sessionId, events: ctx.events, steer: ctx.steer });
    },
  };
}
