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
import {
  createModelManager,
  defineModel,
  type ChatModel,
  type ModelManager,
} from "operon-agents-core";

export {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
};
export type { Api, Context, FauxResponseStep, Model, ToolCall };

export interface FauxChatProvider extends FauxProviderHandle {
  readonly runtime: ModelManager;
  getChatModel(): ChatModel;
  getChatModel(modelId: string): ChatModel | undefined;
  unregister(): void;
}

/** Test-only explicit-Models replacement for pi's removed global faux registry. */
export function registerFauxProvider(
  options?: RegisterFauxProviderOptions,
): FauxChatProvider {
  const handle = fauxProvider(options);
  const runtime = createModelManager({ builtins: false });
  runtime.models.setProvider(handle.provider);

  function getChatModel(modelId?: string): ChatModel | undefined {
    const descriptor = modelId === undefined
      ? handle.getModel()
      : handle.getModel(modelId);
    return descriptor === undefined
      ? undefined
      : defineModel({
          manager: runtime,
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
