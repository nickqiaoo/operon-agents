import type { AgentFrameworkConfig } from "./schema.ts";

type PartialConfig = Partial<AgentFrameworkConfig>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Merge is exactly ONE level deep: entries present in both layers are shallow-spread, so a
// higher layer overriding e.g. one `provider.env` var replaces the WHOLE nested object
// (`env`/`customHeaders`/`mcpServer.headers` are second-level and thus wholesale-replaced, not
// field-merged). Callers wanting to tweak a single nested field must restate the full object.
function mergeRecord<T>(base: Record<string, T>, over: Record<string, T> | undefined): Record<string, T> {
  if (!over) return { ...base };
  const out: Record<string, T> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? ({ ...existing, ...value } as T) : value;
  }
  return out;
}

function mergeOne(base: AgentFrameworkConfig, layer: PartialConfig): AgentFrameworkConfig {
  return {
    providers: mergeRecord(base.providers, layer.providers),
    models: mergeRecord(base.models, layer.models),
    defaultModel: layer.defaultModel ?? base.defaultModel,
    modelCredentials: layer.modelCredentials ?? base.modelCredentials,
    permission: {
      mode: layer.permission?.mode ?? base.permission.mode,
      // Concatenate rules across layers — scope encodes the originating tier.
      rules: [...base.permission.rules, ...(layer.permission?.rules ?? [])],
      // `auto`-mode judge tuning: later layer wins (it's a whole-section override, not additive).
      autoApproval: layer.permission?.autoApproval ?? base.permission.autoApproval,
    },
    loopControl: { ...base.loopControl, ...layer.loopControl },
    thinking: layer.thinking ?? base.thinking,
    mcpServers: mergeRecord(base.mcpServers, layer.mcpServers),
    hooks: [...base.hooks, ...(layer.hooks ?? [])],
    plugins: [...base.plugins, ...(layer.plugins ?? [])],
    pluginMarketplaces: dedupe([...base.pluginMarketplaces, ...(layer.pluginMarketplaces ?? [])]),
    flags: { ...base.flags, ...layer.flags },
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const EMPTY: AgentFrameworkConfig = {
  providers: {},
  models: {},
  permission: { rules: [] },
  loopControl: {},
  mcpServers: {},
  hooks: [],
  plugins: [],
  pluginMarketplaces: [],
  flags: {},
};

export function mergeConfigs(...layers: PartialConfig[]): AgentFrameworkConfig {
  return layers.reduce<AgentFrameworkConfig>((acc, layer) => mergeOne(acc, layer), EMPTY);
}
