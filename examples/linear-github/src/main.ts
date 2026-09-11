// `pnpm dev` / `pnpm start`: the bot's webhook server.
import { serve } from "@hono/node-server";
import { api } from "./app.ts";
import { bot } from "./bot.ts";
import { AGENT_ID, client, MANAGED_URL } from "./bridge.ts";

const PORT = Number(process.env.PORT) || 3000;
// Webhooks come from the internet, so the default binds every interface; the adapters verify
// every request's signature before anything else happens.
const HOST = process.env.HOST || "0.0.0.0";

// The engineer server is a separate process (pnpm server). Say so at boot if it isn't there
// yet, rather than failing the first webhook.
try {
  await client.sessions.list();
} catch (err) {
  console.error(`warning: cannot reach the engineer server at ${MANAGED_URL} (${err instanceof Error ? err.message : String(err)})`);
  console.error("         start it with `pnpm server` in another terminal; sessions will fail until it is up");
}

await bot.initialize();

serve(
  { fetch: api.fetch, port: PORT, hostname: HOST },
  () => console.log(`Linear × GitHub bot (agent "${AGENT_ID}" via ${MANAGED_URL}) listening on http://${HOST}:${PORT}`),
);
