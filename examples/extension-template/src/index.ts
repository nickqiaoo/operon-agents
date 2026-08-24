// Extension template. Three hard rules:
//
// 1. Only `import type` the framework types — runtime capability always comes from the api/ctx handed
//    to setup. A value import bundles the whole framework into your artifact and creates the
//    dual-instance disaster of one framework copy inside the extension and another in the host.
// 2. Every side effect (timers, listeners, child processes, open connections) must be collected into
//    the cleanup function returned by setup, or be a registration such as api.on / api.registerTool
//    (those are revoked automatically on unload). Side effects outside the cleanup function are not
//    reclaimed by the framework.
// 3. Tools that share a resource (a single browser instance, say) belong in one extension rather than
//    being split across extensions that depend on each other. To consume a process-level service
//    published by another extension (or by the host), name it via uses: ["service-name"] on the
//    definition and read services["service-name"] in setup(api, { services }) — the framework
//    validates and resolves it at load time and passes it in. There is no "look up a service by name"
//    inside an extension. Publishing is likewise not a manifest concern: a definition carrying a
//    create half publishes itself, and its id is the service name (see examples/peers-extension).
//
// Build: `pnpm build` → manifest.json + index.js under dist/ is the complete artifact. esbuild rolls
// third-party dependencies into index.js, so users have zero install steps.
import type { ExtensionDefinition } from "operon-agents";

const plugin: ExtensionDefinition = {
  // Must match the id in manifest.json — the loader verifies this.
  id: "example-plugin",
  setup(api) {
    // Scoping rule: one definition is reused across sessions and setup runs once per session, so
    // per-session state is declared inside setup (as below). Declaring it at module level shares it
    // across every session and resets it on reload. State that must survive a reload belongs in the
    // api's state (backed by SessionStore).
    let greetCount = 0;
    // A flat, dependency-free tool description: JSON Schema parameters plus execute.
    // Note that args arrive unvalidated — models usually respect the schema, but check the fields
    // that matter yourself.
    api.registerTool({
      name: "Greet",
      description: "Greet someone by name and count how many greetings this session made.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Who to greet." } },
        required: ["name"],
      },
      execute: (args) => {
        const name = typeof (args as { name?: unknown }).name === "string" ? (args as { name: string }).name : "stranger";
        greetCount += 1;
        return `Hello, ${name}! (greeting #${greetCount} this session)`;
      },
    });

    // Observe the session lifecycle. Durable state goes through state, which is backed by
    // SessionStore and readable again after a reload.
    api.on("session.start", async ({ state, reason }) => {
      const opens = ((await state.get<number>("opens")) ?? 0) + 1;
      await state.set("opens", opens);
      console.log(`[example-plugin] session started (${reason}), open #${opens}`);
    });

    // Rule 2: whatever setup opened is closed here.
    const timer = setInterval(() => {}, 60_000);
    return () => {
      clearInterval(timer);
    };
  },
};

export default plugin;
