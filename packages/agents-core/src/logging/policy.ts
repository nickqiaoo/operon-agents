/**
 * Coarse opt-outs for the bulky LLM/tool payloads in debug logs, read from the environment.
 * Mirrors OpenAI Agents' `dontLogModelData` / `dontLogToolData`: when set, the loop still logs
 * the "llm request/response" and "tool invoke/result" lines, but without the message/args/result
 * bodies. Read per-call so the host can flip them without a load-order race.
 */
function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true" || v === "yes";
}

export const logDataPolicy = {
  get dontLogModelData(): boolean {
    return envFlag("AGENTS_LOG_NO_MODEL_DATA");
  },
  get dontLogToolData(): boolean {
    return envFlag("AGENTS_LOG_NO_TOOL_DATA");
  },
};
