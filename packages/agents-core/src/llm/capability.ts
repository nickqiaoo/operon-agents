import type { Api, Model } from "../protocol/index.ts";

export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly max_context_tokens: number | undefined;
}

export const UNKNOWN_CAPABILITY: ModelCapability = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: undefined,
});

export function capabilityFromPiModel(model: Model<Api>): ModelCapability {
  return {
    image_in: model.input.includes("image"),
    video_in: false, // pi's Model.input is only ("text" | "image")
    audio_in: false,
    thinking: model.reasoning,
    tool_use: true,
    max_context_tokens: model.contextWindow > 0 ? model.contextWindow : undefined,
  };
}

const TAG_FLAGS: Readonly<Record<string, keyof ModelCapability>> = {
  image_in: "image_in",
  image: "image_in",
  vision: "image_in",
  video_in: "video_in",
  video: "video_in",
  audio_in: "audio_in",
  audio: "audio_in",
  thinking: "thinking",
  reasoning: "thinking",
  always_thinking: "thinking",
  tool_use: "tool_use",
  tools: "tool_use",
};

export function applyDeclaredCapability(
  base: ModelCapability,
  tags: readonly string[] | undefined,
  maxContextSize?: number,
): ModelCapability {
  const flags = { ...base };
  for (const raw of tags ?? []) {
    const key = TAG_FLAGS[raw.trim().toLowerCase()];
    if (key !== undefined && key !== "max_context_tokens") flags[key] = true;
  }
  return {
    ...flags,
    max_context_tokens:
      maxContextSize !== undefined && maxContextSize > 0 ? maxContextSize : base.max_context_tokens,
  };
}
