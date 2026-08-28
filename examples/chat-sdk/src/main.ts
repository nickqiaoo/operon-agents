// Serves the chat page and its assets, plus the /api routes from src/app.ts.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import * as esbuild from "esbuild";
import { Hono } from "hono";
import { api } from "./app.ts";
import { AGENT_ID, client, MANAGED_URL } from "./managed-agents.ts";

const PORT = Number(process.env.PORT) || 3000;

// The demo getUser trusts every caller, so the default only listens on the loopback
// interface; set HOST only after wiring real auth into src/bot.ts. (Explicit 127.0.0.1 rather
// than "localhost": Node would resolve "localhost" to ::1 on some systems and refuse IPv4
// connections.)
const HOST = process.env.HOST || "127.0.0.1";

// The analyst server is a separate process (pnpm server). Say so at boot if it isn't there
// yet, rather than 500ing the first click -- but don't refuse to start over a race between two
// terminals.
try {
  await client.sessions.list();
} catch (err) {
  console.error(`warning: cannot reach the analyst server at ${MANAGED_URL} (${err instanceof Error ? err.message : String(err)})`);
  console.error("         start it with `pnpm server` in another terminal; chats will fail until it is up");
}

const webFile = (name: string) => fileURLToPath(new URL(`../web/${name}`, import.meta.url));

// Dev rebuilds the bundle on each request (~100ms), so web/ edits show on reload -- production
// caches the first build.
const NODE_ENV = process.env.NODE_ENV || "development";
const PRODUCTION = NODE_ENV === "production";
let cachedBundle: string | undefined;
async function bundleApp(): Promise<string> {
  if (PRODUCTION && cachedBundle) return cachedBundle;
  const result = await esbuild.build({
    entryPoints: [webFile("app.tsx")],
    bundle: true,
    format: "esm",
    sourcemap: PRODUCTION ? false : "inline",
    minify: PRODUCTION,
    // React's entry points branch on this at require time; without the define, the browser
    // bundle would reference a `process` that isn't there.
    define: { "process.env.NODE_ENV": JSON.stringify(NODE_ENV) },
    write: false,
  });
  const text = result.outputFiles?.[0]?.text;
  if (text === undefined) throw new Error("esbuild produced no output");
  if (PRODUCTION) cachedBundle = text;
  return text;
}

const app = new Hono();

app.get("/", async (c) => c.html(await readFile(webFile("index.html"), "utf8")));
app.get("/app.css", async (c) => c.body(await readFile(webFile("app.css"), "utf8"), 200, { "content-type": "text/css" }));
app.get("/app.js", async (c) => c.body(await bundleApp(), 200, { "content-type": "text/javascript" }));

app.route("/", api);

serve(
  {
    fetch: app.fetch,
    port: PORT,
    hostname: HOST,
    // Agent turns hold the response open for minutes -- requestTimeout: 0 disables Node's
    // 5-minute reap.
    serverOptions: { requestTimeout: 0 },
  },
  () => console.log(`Research analyst (agent "${AGENT_ID}" via ${MANAGED_URL}) running at http://${HOST}:${PORT}`),
);
