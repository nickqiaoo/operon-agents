import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ModelManager } from "./model-manager.ts";

/**
 * A structured decision model (Jev, Clef, OpenAI Decisions…): it answers fixed questions about a
 * JSON state with probabilities and writes no text, so it has no place in a turn loop. It is a
 * sibling of `ChatModel`, not a kind of it.
 */
export class DecisionModel {
  private readonly manager: ModelManager;
  private readonly descriptor: ClassifierModel<ClassifierApi>;
  private readonly apiKey: string | undefined;

  constructor(spec: { readonly manager: ModelManager; readonly descriptor: ClassifierModel<ClassifierApi>; readonly apiKey?: string }) {
    this.manager = spec.manager;
    this.descriptor = spec.descriptor;
    this.apiKey = spec.apiKey;
  }

  get id(): string {
    return this.descriptor.id;
  }

  /** Never rejects: a failed request comes back with `stopReason: "error"`. */
  classify(context: ClassifierContext, call?: { readonly signal?: AbortSignal }): Promise<ClassifierResult> {
    return this.manager.models.classify(this.descriptor, context, {
      ...call,
      ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
    });
  }
}
