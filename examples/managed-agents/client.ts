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
  environment_id: "workspace",
});
console.log(`▸ session ${session.id}`);

// The stream is live-only: open it before sending, or what happens in between is missed.
const controller = new AbortController();
const stream = await client.sessions.events.stream(session.id, { signal: controller.signal });
const [sent] = (await client.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: TASK }] }],
})).data;
console.log(`▸ sent ${sent!.id}`);

let ours = false;
for await (const event of stream) {
  // Our message coming back processed is the moment it entered the conversation.
  if (event.id === sent!.id && event.processed_at !== null) ours = true;
  if (event.type === "agent.tool_use") process.stdout.write(`  ⚙︎ ${event.name}\n`);
  if (event.type === "agent.message") process.stdout.write(`${event.content.map((block) => block.text).join("")}\n`);
  if (event.type === "session.error") process.stdout.write(`  ✖ ${event.error.message}\n`);
  if (ours && event.type === "session.status_idle") {
    process.stdout.write(`▸ idle (${event.stop_reason.type})\n`);
    break;
  }
}
controller.abort();
