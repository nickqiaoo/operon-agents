// `pnpm server`: the engineer's managed-agents API. The bot in src/ is a client of this server;
// the two run as separate processes.
import { AGENT_ID, MODEL } from "./agent-config.ts";
import { composeServer } from "./compose.ts";
import { githubFromEnv } from "./github.ts";
import { LANGFUSE_DEFAULT_BASE_URL, langfuseFromEnv, langfuseTracing } from "./langfuse.ts";
import { pausingSandboxFactory, type E2BCheckoutOptions } from "./sandbox.ts";

const PORT = Number(process.env.MANAGED_PORT ?? 8088);
const API_KEY = process.env.MANAGED_API_KEY || undefined;
// Loopback unless the API is protected: the bot is the only intended caller.
const HOST = process.env.MANAGED_HOST ?? (API_KEY === undefined ? "127.0.0.1" : "0.0.0.0");

// E2B_API_KEY switches sessions from directories on this host to E2B sandboxes (the SDK reads
// the key itself). Optional peer: imported only when asked for.
async function sandboxFromEnv(): Promise<E2BCheckoutOptions | undefined> {
  if (!process.env.E2B_API_KEY) return undefined;
  const { Sandbox } = await import("e2b");
  return {
    sandbox: pausingSandboxFactory(Sandbox),
    ...(process.env.E2B_TEMPLATE ? { template: process.env.E2B_TEMPLATE } : {}),
    timeoutMs: Number(process.env.E2B_TIMEOUT_MS ?? 15 * 60_000),
  };
}

const github = githubFromEnv();
const sandbox = await sandboxFromEnv();
// LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY: every session's runs are traced to Langfuse.
const langfuse = langfuseFromEnv();
const { managed } = await composeServer({
  model: MODEL,
  github,
  home: new URL("../.agent-home/", import.meta.url).pathname,
  work: new URL("../workspace/", import.meta.url).pathname,
  ...(API_KEY !== undefined ? { apiKey: API_KEY } : {}),
  ...(sandbox !== undefined ? { sandbox } : {}),
  ...(langfuse !== undefined ? { tracing: langfuseTracing(langfuse) } : {}),
  log: true,
});
await managed.listen(PORT, HOST);

console.error(`engineer server listening on http://${HOST}:${PORT}/v1`);
console.error(`agent=${AGENT_ID} model=${MODEL}; a session's environment id is the repository it clones (owner/name)`);
console.error(sandbox !== undefined ? `sessions run in E2B sandboxes${sandbox.template ? ` (template ${sandbox.template})` : ""}` : "sessions run in workspace/ on this host (set E2B_API_KEY for sandboxes)");
if (API_KEY === undefined) console.error("MANAGED_API_KEY is unset: loopback only, no authentication");
console.error(
  langfuse !== undefined
    ? `tracing to Langfuse at ${langfuse.baseUrl ?? LANGFUSE_DEFAULT_BASE_URL} (content: ${langfuse.content ?? "delta"}, redacted)`
    : "tracing off (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to trace sessions to Langfuse)",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void managed.close().finally(() => process.exit(0));
  });
}
