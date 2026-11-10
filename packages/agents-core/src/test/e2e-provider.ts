import {
  applyDeclaredCapability,
  capabilityFromPiModel,
  createModelManager,
  UNKNOWN_CAPABILITY,
  type Api,
  type Model,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

// A vision, non-reasoning model and a reasoning one — both in pi 0.81's registry.
// The old claude-3-5-haiku-20241022 fixture was removed from that catalog.
const VISION_PROVIDER = "openai";
const VISION_MODEL = "gpt-4o";
const THINKING_MODEL = "claude-haiku-4-5";

const builtins = createModelManager();

function getBuiltinModel(provider: string, model: string): Model<Api> {
  const descriptor = builtins.models.getModel(provider, model);
  if (descriptor === undefined) {
    throw new Error(`test fixture is missing from pi catalog: ${provider}/${model}`);
  }
  return descriptor;
}

function testCapabilityDetection(): void {
  const vision = capabilityFromPiModel(getBuiltinModel(VISION_PROVIDER, VISION_MODEL));
  check(
    "capability: detected image_in + context off pi model",
    vision.image_in === true && vision.thinking === false && vision.max_context_tokens === 128000 && vision.tool_use === true,
  );
  const thinking = capabilityFromPiModel(getBuiltinModel("anthropic", THINKING_MODEL));
  check("capability: detected thinking off pi model", thinking.thinking === true);

  // Tags only turn flags ON (union, never downgrade); maxContextSize overrides.
  const overlaid = applyDeclaredCapability(vision, ["video", "audio_in"], 50000);
  check(
    "capability: declared tags union onto detected",
    overlaid.image_in === true && overlaid.video_in === true && overlaid.audio_in === true && overlaid.max_context_tokens === 50000,
  );
  check(
    "capability: UNKNOWN default is tool_use-only",
    UNKNOWN_CAPABILITY.tool_use === true && UNKNOWN_CAPABILITY.image_in === false && UNKNOWN_CAPABILITY.max_context_tokens === undefined,
  );
}

function main(): void {
  testCapabilityDetection();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ PROVIDER E2E PASS — structured capability");
  } else {
    console.log("❌ PROVIDER E2E FAIL");
    process.exit(1);
  }
}

main();
