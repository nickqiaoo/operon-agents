import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentTools,
  type Api,
  type Context,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Model,
  type RegisterFauxProviderOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createModelRuntime,
  defineModel,
  type ChatModel,
  type ModelRuntime,
} from "operon-agents-core";

export {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
};
export type { Api, Context, FauxResponseStep, Model, ToolCall };

/** Names of every tool a faux request offers: pi hands providers a transcript whose system
 *  messages carry the tools (the leading one plus any later `toolsAdded`). */
export function offeredToolNames(context: Pick<Context, "messages">): string[] {
  return getCurrentTools(context.messages).map((tool) => tool.name);
}

export interface FauxChatProvider extends FauxProviderHandle {
  readonly runtime: ModelRuntime;
  getChatModel(): ChatModel;
  getChatModel(modelId: string): ChatModel | undefined;
  unregister(): void;
}

/** Test-only explicit-Models replacement for pi's removed global faux registry. */
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

export { testRunner, openTestSession, sessionOptionsFrom, provisionCapability, testSessionContext, testProvisionContext, testRunContext } from "operon-agents-core/internal";
