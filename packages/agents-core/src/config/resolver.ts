import type { HookDef } from "../capabilities/user-hooks/types.ts";
import type { PermissionMode, PermissionRule } from "../permission/types.ts";
import { hookDefsFromConfig } from "../plugins/hooks.ts";
import { mergeConfigs } from "./merge.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { Flags } from "./flags.ts";
import { type AgentFrameworkConfig, parseConfig, type ThinkingConfig } from "./schema.ts";

export interface ConfigResolver {
  resolve(): Promise<AgentFrameworkConfig>;
}

export function objectResolver(config: unknown): ConfigResolver {
  return { resolve: async () => parseConfig(config) };
}

export function layeredResolver(...layers: Partial<AgentFrameworkConfig>[]): ConfigResolver {
  return { resolve: async () => parseConfig(mergeConfigs(...layers)) };
}

export interface AutoApprovalOptions {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly environment: readonly string[];
  readonly twoStageMode?: "both" | "fast" | "thinking";
}

export interface CoreOptions {
  readonly permission: {
    readonly mode?: PermissionMode;
    readonly rules: readonly PermissionRule[];
    readonly autoApproval?: AutoApprovalOptions;
  };
  readonly loopControl: {
    readonly maxStepsPerTurn?: number;
    readonly maxRetriesPerStep?: number;
    readonly maxTurns?: number;
  };
  readonly catalog: ModelCatalog;
  readonly flags: Flags;
  readonly defaultModel?: string;
  readonly thinking?: ThinkingConfig;
  /** Plugin marketplace registry locations (URLs / paths) the product may browse. */
  readonly pluginMarketplaces: readonly string[];
  /** Shell hooks from `config.hooks` (unknown events dropped). Pass to `defaultCapabilities({ hooks })`. */
  readonly hooks: readonly HookDef[];
  readonly config: AgentFrameworkConfig;
}

export function toCoreOptions(config: AgentFrameworkConfig): CoreOptions {
  const rules: PermissionRule[] = config.permission.rules.map((r) => ({
    decision: r.decision,
    scope: r.scope,
    pattern: r.pattern,
    reason: r.reason,
  }));
  const autoApproval = config.permission.autoApproval;
  return {
    permission: {
      mode: config.permission.mode,
      rules,
      ...(autoApproval
        ? {
            autoApproval: {
              allow: autoApproval.allow,
              deny: autoApproval.deny,
              environment: autoApproval.environment,
              twoStageMode: autoApproval.twoStageMode,
            },
          }
        : {}),
    },
    loopControl: {
      maxStepsPerTurn: config.loopControl.maxStepsPerTurn,
      maxRetriesPerStep: config.loopControl.maxRetriesPerStep,
      maxTurns: config.loopControl.maxTurns,
    },
    catalog: new ModelCatalog(config.models),
    flags: new Flags(config.flags),
    defaultModel: config.defaultModel,
    thinking: config.thinking,
    pluginMarketplaces: config.pluginMarketplaces,
    hooks: hookDefsFromConfig(config.hooks),
    config,
  };
}

export async function resolveCoreOptions(resolver: ConfigResolver): Promise<CoreOptions> {
  return toCoreOptions(await resolver.resolve());
}
