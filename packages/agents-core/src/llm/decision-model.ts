import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./runtime.ts";

/**
 * A structured decision model (Jev, Clef, OpenAI Decisions…): it answers fixed questions about a
 * JSON state with probabilities and writes no text, so it has no place in a turn loop. It is a
 * sibling of `ChatModel`, not a kind of it.
 */
export class DecisionModel {
  private readonly runtime: ModelRuntime;
  private readonly descriptor: ClassifierModel<ClassifierApi>;

  constructor(spec: { readonly runtime: ModelRuntime; readonly descriptor: ClassifierModel<ClassifierApi> }) {
    this.runtime = spec.runtime;
    this.descriptor = spec.descriptor;
  }

  get id(): string {
    return this.descriptor.id;
  }

  /** Never rejects: a failed request comes back with `stopReason: "error"`. */
  classify(context: ClassifierContext, call?: { readonly signal?: AbortSignal }): Promise<ClassifierResult> {
    return this.runtime.models.classify(this.descriptor, context, call);
  }
}
