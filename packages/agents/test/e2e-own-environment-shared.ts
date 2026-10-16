/**
 * A session that brings its own environment — a sandbox, on a server — runs its tools on a
 * different machine than the harness. The process-shared MCP connections were connected from the
 * harness's machine, so the default capability bundle must leave them out for that session, the
 * same way it already leaves out the process-wide skill scan.
 *
 * Covers the default path (no `session` hook), which used to call `defaultCapabilities` without
 * `ownEnvironment` and so handed a sandboxed session the harness's connections anyway.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "./faux.ts";
import { createHarness, createMcpServers, LocalEnvironment } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "own-env-shared-"));
  const sandboxDir = mkdtempSync(join(tmpdir(), "own-env-sandbox-"));
  const faux = registerFauxProvider();
  try {
    const harness = createHarness({
      model: faux.getChatModel()!,
      workDir: dir,
      permission: { mode: "yolo" },
      harness: async () => {
        const servers = createMcpServers(
          { ws: { transport: "http", url: "http://ws.example" } },
          {
            transportFactory: (name: string) => ({
              name,
              async connect() {},
              async close() {},
              async listTools() { return [{ name: "ws_tool", description: "ws_tool", inputSchema: { type: "object", properties: {} } }]; },
              async callTool() { return { content: [{ type: "text", text: "hi" }] }; },
            }),
          },
        );
        await servers.connect({ sessionId: "" });
        return { mcpServers: servers, close: () => servers.shutdown() };
      },
    });

    const onHarness = await harness.createSession({ workDir: dir });
    check("harness env: the session sees the process-shared servers", (onHarness.mcp?.list() ?? []).map((v) => v.name).join(",") === "ws");

    const sandboxed = await harness.createSession({ workDir: sandboxDir, environment: new LocalEnvironment(sandboxDir) });
    check("own env: the session does not get the process-shared servers", (sandboxed.mcp?.list() ?? []).length === 0);

    check("own env: the shared set still serves the other session", (onHarness.mcp?.list() ?? []).length === 1);
    await sandboxed.close();
    await onHarness.close();
    await harness.close();
  } finally {
    faux.unregister();
    rmSync(dir, { recursive: true, force: true });
    rmSync(sandboxDir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ OWN-ENVIRONMENT E2E PASS — a session on its own environment does not get the harness's connections");
}

await main();
