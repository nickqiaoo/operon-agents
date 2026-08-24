import { ManagedAgentsClient } from "operon-managed-agents/client";

const BASE = process.env.BASE ?? `http://localhost:${process.env.PORT ?? 8088}/v1`;
const TASK = process.argv[2] ?? "inspect the workspace and summarize what you find";
const client = new ManagedAgentsClient({
  baseUrl: BASE,
  ...(process.env.MANAGED_API_KEY !== undefined ? { apiKey: process.env.MANAGED_API_KEY } : {}),
});

const session = await client.sessions.create({
  title: "managed SDK demo",
  agent: "default",
  environment: "workspace",
});
console.log(`▸ session ${session.id}`);

// The stream belongs to the session, not to the prompt. Open it once and keep it while
// foreground turns, detached commands, subagents and workflows come and go.
const controller = new AbortController();
const stream = await client.sessions.events.stream(session.id, { signal: controller.signal });
const consume = (async () => {
  for await (const event of stream) {
    if (event.type === "assistant.delta") process.stdout.write(event.delta);
    if (event.type === "tool.call.started") {
      process.stdout.write(`\n  ⚙︎ ${event.toolName}\n`);
    }
    if (event.type === "turn.ended" && event.address === "main") {
      process.stdout.write(`\n▸ turn ${event.reason}\n`);
      controller.abort();
      return;
    }
  }
})();

const receipt = await client.sessions.messages.create(session.id, { input: TASK });
console.log(`▸ ${receipt.status}: ${receipt.deliveryId}`);
await consume;
