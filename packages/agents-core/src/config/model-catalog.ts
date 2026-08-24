import { UNKNOWN_CAPABILITY, applyDeclaredCapability, type ModelCapability } from "../llm/index.ts";
import type { ModelAlias } from "./schema.ts";

export interface ModelCapabilityInfo {
  readonly maxContextSize: number | undefined;
  readonly maxOutputSize: number | undefined;
  readonly capability: ModelCapability;
  readonly known: boolean;
}

export class ModelCatalog {
  private readonly aliases: ReadonlyMap<string, ModelAlias>;

  constructor(models: Record<string, ModelAlias> = {}) {
    this.aliases = new Map(Object.entries(models));
  }

  private find(modelRef: string): ModelAlias | undefined {
    const direct = this.aliases.get(modelRef);
    if (direct) return direct;
    for (const alias of this.aliases.values()) {
      if (`${alias.provider}/${alias.model}` === modelRef || alias.model === modelRef) return alias;
    }
    return undefined;
  }

  info(modelRef: string): ModelCapabilityInfo {
    const alias = this.find(modelRef);
    if (!alias) {
      return { maxContextSize: undefined, maxOutputSize: undefined, capability: UNKNOWN_CAPABILITY, known: false };
    }
    return {
      maxContextSize: alias.maxContextSize,
      maxOutputSize: alias.maxOutputSize,
      capability: applyDeclaredCapability(UNKNOWN_CAPABILITY, alias.capabilities, alias.maxContextSize),
      known: true,
    };
  }

  maxContextSize(modelRef: string): number | undefined {
    return this.find(modelRef)?.maxContextSize;
  }

  has(modelRef: string, capability: string): boolean {
    const alias = this.find(modelRef);
    return alias?.capabilities?.includes(capability) ?? false;
  }
}
