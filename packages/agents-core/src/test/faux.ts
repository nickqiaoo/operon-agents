import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Api,
  type Context,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Model,
  type RegisterFauxProviderOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { defineModel, type ChatModel } from "../llm/define-model.ts";
import {
  createModelRuntime,
  type ModelRuntime,
} from "../llm/runtime.ts";

export {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
};
export type { Api, Context, FauxResponseStep, Model, ToolCall };

export interface FauxChatProvider extends FauxProviderHandle {
  readonly runtime: ModelRuntime;
  getChatModel(): ChatModel;
  getChatModel(modelId: string): ChatModel | undefined;
  unregister(): void;
}

/**
 * Test-only bridge for pi 0.81's collection-local faux provider.
 *
 * The old compat helper mutated a process-global provider registry. Keeping the
 * same setup name makes the test migration small while every faux model now
 * belongs to an explicit Models runtime.
 */
export function registerFauxProvider(
  options?: RegisterFauxProviderOptions,
): FauxChatProvider {
  const handle = fauxProvider(options);
  const runtime = createModelRuntime({ builtins: false });
  runtime.models.setProvider(handle.provider);

  function getChatModel(modelId?: string): ChatModel | undefined {
    const descriptor = modelId === undefined
      ? handle.getModel()
      : handle.getModel(modelId);
    return descriptor === undefined
      ? undefined
      : defineModel({
          runtime,
          descriptor: descriptor as Model<Api>,
        });
  }

  return {
    ...handle,
    runtime,
    getChatModel: getChatModel as FauxChatProvider["getChatModel"],
    unregister(): void {
      runtime.models.deleteProvider(handle.provider.id);
    },
  };
}
