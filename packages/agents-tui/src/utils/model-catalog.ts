import { createModelRuntime, type ModelRuntime, type ThinkingLevel } from 'operon-agents';

import { THINKING_LEVELS } from './thinking.ts';

/** One model the `/model` picker can offer. `id` is the engine's `provider/model` form. */
export interface ModelCatalogEntry {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly displayName: string;
  readonly contextWindow: number;
  /** Whether the model accepts image input. */
  readonly imageInput: boolean;
  /** Whether the model exposes extended thinking at all. */
  readonly reasoning: boolean;
}

export type ModelCatalog = Readonly<Record<string, ModelCatalogEntry>>;

/** `provider/model` → its two halves; undefined when the id has no slash. */
export function splitModelId(id: string): { provider: string; model: string } | undefined {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

/** The shape both the static catalog and the available-model query hand back. */
interface RegistryModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly contextWindow: number;
  readonly input: readonly string[];
  readonly reasoning: boolean;
}

function entryOf(model: RegistryModel): ModelCatalogEntry {
  return {
    id: `${model.provider}/${model.id}`,
    provider: model.provider,
    model: model.id,
    displayName: model.name || model.id,
    contextWindow: model.contextWindow,
    imageInput: model.input.includes('image'),
    reasoning: model.reasoning,
  };
}

/** A model named on the command line or in the config that the registry does not know. */
function placeholderEntry(id: string): ModelCatalogEntry | undefined {
  const split = splitModelId(id);
  if (split === undefined) return undefined;
  return {
    id,
    provider: split.provider,
    model: split.model,
    displayName: split.model,
    contextWindow: 0,
    imageInput: true,
    reasoning: true,
  };
}

function withExtras(entries: readonly ModelCatalogEntry[], extraIds: readonly string[]): ModelCatalog {
  const catalog: Record<string, ModelCatalogEntry> = {};
  for (const entry of entries) catalog[entry.id] = entry;
  for (const id of extraIds) {
    if (catalog[id] !== undefined) continue;
    const placeholder = placeholderEntry(id);
    if (placeholder !== undefined) catalog[id] = placeholder;
  }
  return catalog;
}

/**
 * The models the picker offers: those whose provider is actually configured on this machine.
 *
 * The engine's registry knows well over a thousand models across every provider it can speak to,
 * which is a catalog, not a choice — a list of models you have no credentials for is noise. The
 * engine answers the real question (`Models.getAvailable()` returns only models whose provider has
 * complete auth), so with one `ANTHROPIC_API_KEY` the picker shows that provider's models, not the
 * whole world's.
 *
 * `extraIds` are always included: the `--model` the session was started with, and the config's
 * default, belong in the list whether or not the registry recognises them (a custom endpoint's
 * model does not appear in any built-in catalog).
 */
export async function buildModelCatalog(
  extraIds: readonly string[] = [],
  runtime: ModelRuntime = createModelRuntime(),
): Promise<ModelCatalog> {
  let available: readonly RegistryModel[] = [];
  try {
    available = (await runtime.models.getAvailable()) as readonly RegistryModel[];
  } catch {
    available = [];
  }
  return withExtras(available.map(entryOf), extraIds);
}

/**
 * Every model the engine can name, configured or not. This is the fallback for an environment with no
 * credentials at all, where an empty picker would be worse than a long one, and the source for
 * `/model <id>` validation.
 */
export function buildFullModelCatalog(
  extraIds: readonly string[] = [],
  runtime: ModelRuntime = createModelRuntime(),
): ModelCatalog {
  let models: readonly RegistryModel[] = [];
  try {
    models = runtime.models.getModels() as readonly RegistryModel[];
  } catch {
    models = [];
  }
  return withExtras(models.map(entryOf), extraIds);
}

export function modelDisplayName(id: string, entry: ModelCatalogEntry | undefined): string {
  return entry?.displayName ?? splitModelId(id)?.model ?? id;
}

export function providerDisplayName(provider: string): string {
  return provider;
}

/** The thinking levels a model can be driven at: every engine level when it reasons, none otherwise. */
export function thinkingLevelsFor(entry: ModelCatalogEntry | undefined): readonly ThinkingLevel[] {
  if (entry !== undefined && !entry.reasoning) return [];
  return THINKING_LEVELS;
}
