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
  harnessModel(): { readonly model: string; readonly modelManager: ModelManager };
  unregister(): void;
}

/** Test-only explicit-Models replacement for pi's removed global faux registry. */
export function registerFauxProvider(
  options?: RegisterFauxProviderOptions,
): FauxChatProvider {
  const handle = fauxProvider(options);
  const runtime = createModelManager({ builtins: false });
  runtime.models.setProvider(handle.provider);

  return {
    ...handle,
    harnessModel: () => ({ model: `${handle.provider.id}/${handle.getModel().id}`, modelManager: runtime }),
    unregister(): void {
      runtime.models.deleteProvider(handle.provider.id);
    },
  };
}
