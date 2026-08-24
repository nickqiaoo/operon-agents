export interface FlagDefinition {
  readonly name: string;
  readonly description: string;
  readonly default: boolean;
}

export const FLAG_DEFINITIONS: readonly FlagDefinition[] = [
  { name: "micro_compaction", description: "Mechanical clearing of old tool results when the cache is cold.", default: false },
  { name: "goal_command", description: "Goal mode (autonomous goal-driven continuation).", default: true },
];

const DEFAULTS: ReadonlyMap<string, boolean> = new Map(FLAG_DEFINITIONS.map((f) => [f.name, f.default]));

export class Flags {
  private readonly overrides: ReadonlyMap<string, boolean>;

  constructor(overrides: Record<string, boolean> = {}) {
    this.overrides = new Map(Object.entries(overrides));
  }

  enabled(name: string): boolean {
    if (this.overrides.has(name)) return this.overrides.get(name)!;
    return DEFAULTS.get(name) ?? false;
  }

  all(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const def of FLAG_DEFINITIONS) out[def.name] = this.enabled(def.name);
    for (const [name, value] of this.overrides) out[name] = value;
    return out;
  }
}
