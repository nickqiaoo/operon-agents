/**
 * The workspace tier: one scope per workspace key, composed once by the `workspace` hook and
 * shared by every session under it — MCP connections included — and closed when the last
 * session leaves. A session that brings its own machine instance gets a private workspace.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness, createMcpServers, defaultCapabilities, T, LocalMachine } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const dirA = mkdtempSync(join(tmpdir(), "scope-ws-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "scope-ws-b-"));
  try {
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const model = faux.getChatModel()!;

    let composed = 0;
    let connects = 0;
    let shutdowns = 0;
    const keys: string[] = [];
    const transportFactory = (name: string) => ({
      name,
      async connect() { connects += 1; },
      async close() {},
      async listTools() { return [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }]; },
      async callTool() { return { content: [{ type: "text", text: "hi" }] }; },
    });

    const harness = createHarness({
      model,
      workDir: dirA,
      permission: { mode: "yolo" },
      workspace: async (scope, ctx) => {
        composed += 1;
        keys.push(ctx.key);
        const servers = createMcpServers({ srv: { transport: "http", url: "http://srv.example" } }, { transportFactory });
        await servers.connect({ scope, sessionId: "", signal: new AbortController().signal });
        scope.register(T.McpServers, servers, { dispose: async () => { shutdowns += 1; await servers.shutdown(); } });
      },
      session: (scope) => defaultCapabilities({ scope }),
    });

    const s1 = await harness.createSession({ workDir: dirA });
    const s2 = await harness.createSession({ workDir: dirA });
    check("share: two sessions in one directory compose the workspace once", composed === 1 && keys[0] === `dir::${dirA}`);
    check("share: the MCP servers connected once, not per session", connects === 1);
    check("share: both sessions see the same T.McpServers", s1.core.get(T.McpServers) !== undefined && s1.core.get(T.McpServers) === s2.core.get(T.McpServers));
    check("share: the session scope hangs under the workspace scope", s1.core.scope.parent?.kind === "workspace" && s1.core.scope.parent === s2.core.scope.parent);
    check("view: session.listMcpServers() reads the shared connections", s1.listMcpServers().some((v) => v.name === "srv" && v.status === "connected"));
    check("view: the session-tier mcp service is the shared handle", s1.core.get(T.Mcp) === s1.core.get(T.McpServers));
    check("view: the skill registry is workspace-shared too when registered (not here)", s1.core.get(T.SkillRegistry) === undefined);

    const result = await s1.prompt("hi");
    check("run: a prompt completes over a workspace-backed session", result.status === "completed");

    const s3 = await harness.createSession({ workDir: dirB });
    check("isolate: another directory gets its own workspace", composed === 2 && connects === 2 && s3.core.get(T.McpServers) !== s1.core.get(T.McpServers));

    const s4 = await harness.createSession({ workDir: dirA, machine: new LocalMachine(dirA) });
    check("isolate: a session with its own machine instance gets a private workspace", composed === 3 && keys[2] === `private::${s4.id}`);

    const s5 = await harness.createSession({ workDir: dirB, workspaceKey: "tenant-1" });
    const s6 = await harness.createSession({ workDir: dirA, workspaceKey: "tenant-1" });
    check("key: an explicit workspaceKey shares across directories", composed === 4 && s5.core.get(T.McpServers) === s6.core.get(T.McpServers));

    await s1.close();
    check("release: closing one session keeps the shared workspace alive", shutdowns === 0 && !s2.core.scope.parent!.closed);
    await s2.close();
    check("release: the last session out closes the workspace (MCP shut down)", shutdowns === 1);
    await harness.close();
    check("release: harness.close() takes the remaining workspaces down", shutdowns === 4 && harness.scope.closed);
    faux.unregister();
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ SCOPE-WORKSPACE E2E PASS — shared per-directory MCP + private workspaces + keyed sharing + ref-counted teardown");
  } else {
    console.log("❌ SCOPE-WORKSPACE E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
