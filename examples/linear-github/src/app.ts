// The routes, as one fetch-native Hono app: the two webhooks, the optional Linear OAuth
// callback, and a health check. Host-neutral; src/main.ts mounts it on Node.

import { Hono } from "hono";
import { adapters, bot } from "./bot.ts";
import { client, MANAGED_URL } from "./bridge.ts";

export const api = new Hono();

// Signatures are verified inside the adapters (LINEAR_WEBHOOK_SECRET / GITHUB_WEBHOOK_SECRET).
api.post("/api/webhooks/linear", (c) => bot.webhooks.linear(c.req.raw));
api.post("/api/webhooks/github", (c) => bot.webhooks.github(c.req.raw));

// Multi-tenant Linear installs (LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET) land here after the
// workspace admin authorizes the app with actor=app; single-tenant modes never use it.
const LINEAR_REDIRECT_URI = process.env.LINEAR_REDIRECT_URI;
if (LINEAR_REDIRECT_URI) {
  api.get("/api/linear/install/callback", async (c) => {
    const { organizationId } = await adapters.linear.handleOAuthCallback(c.req.raw, { redirectUri: LINEAR_REDIRECT_URI });
    return c.text(`Installed for Linear organization ${organizationId}. You can close this tab.`);
  });
}

api.get("/healthz", async (c) => {
  try {
    await client.sessions.list();
    return c.json({ ok: true, managed: MANAGED_URL });
  } catch (err) {
    return c.json({ ok: false, managed: MANAGED_URL, error: err instanceof Error ? err.message : String(err) }, 503);
  }
});
