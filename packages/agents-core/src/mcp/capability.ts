import { BoundaryInjector, type Capability, type SessionContext, type InjectionContext, type InjectionResult } from "../index.ts";
import type { MCPServer } from "./server.ts";
import { hasResources } from "./server.ts";
import { mcpToolProvider } from "./provider.ts";

export interface MCPCapabilityOptions {
  readonly injectResources?: boolean;
}

interface CollectedResource {
  readonly server: string;
  readonly uri: string;
  readonly name?: string;
  readonly mimeType?: string;
}

class McpResourcesInjector extends BoundaryInjector {
  readonly id = "mcp_resources";
  private readonly getResources: () => readonly CollectedResource[];

  constructor(getResources: () => readonly CollectedResource[]) {
    super();
    this.getResources = getResources;
  }

  protected getInjection(ctx: InjectionContext): InjectionResult | null {
    if (this.restoreInjectedAt(ctx, ["mcp_resources"])) return null;
    const resources = this.getResources();
    if (resources.length === 0) return null;
    const lines = ["Available MCP resources (read via the server's resource tools):"];
    for (const r of resources) {
      lines.push(`- ${r.uri}${r.name ? ` (${r.name})` : ""}${r.mimeType ? ` [${r.mimeType}]` : ""} — server "${r.server}"`);
    }
    return { text: lines.join("\n"), variant: "mcp_resources" };
  }
}

export function mcpCapability(servers: readonly MCPServer[], options: MCPCapabilityOptions = {}): Capability {
  let resources: CollectedResource[] = [];

  const capability: Capability = {
    name: "mcp",
    toolProviders: servers.map((server) => mcpToolProvider(server)),
    service: servers,
    ...(options.injectResources ? { injectors: [new McpResourcesInjector(() => resources)] } : {}),
    // Connect every server in parallel, fault-isolated — session open would otherwise cost
    // the SUM of each server's startup (matching `mcpServersCapability`, which already does).
    openSession: async (ctx: SessionContext) => {
      const perServer = await Promise.all(
        servers.map(async (server): Promise<readonly CollectedResource[]> => {
          try {
            await server.connect();
          } catch (error) {
            const tail = server.stderrSnapshot?.().trimEnd();
            const base = error instanceof Error ? error.message : String(error);
            ctx.events?.emit({
              type: "warning",
              address: "main",
              sessionId: ctx.sessionId,
              message: `MCP server "${server.name}" failed to connect: ${base}${tail ? `\nstderr: ${tail}` : ""}`,
            });
            return [];
          }
          // Watch for a self-initiated drop after a clean connect (subprocess crash / HTTP
          // give-up): warn so the user knows the server's tools have gone absent mid-session.
          server.onUnexpectedClose?.((reason) => {
            const parts = [`MCP server "${server.name}" closed unexpectedly`];
            if (reason.error !== undefined) parts.push(reason.error.message);
            if (reason.stderr !== undefined && reason.stderr.length > 0) parts.push(`stderr: ${reason.stderr.trimEnd()}`);
            ctx.events?.emit({ type: "warning", address: "main", sessionId: ctx.sessionId, message: parts.join("\n") });
          });
          if (!options.injectResources || !hasResources(server)) return [];
          try {
            const list = await server.listResources();
            return list.resources.map((r) => ({
              server: server.name,
              uri: r.uri,
              ...(r.name !== undefined ? { name: r.name } : {}),
              ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
            }));
          } catch {
            // resources are optional context; a failure here never blocks tools.
            return [];
          }
        }),
      );
      // Flattened in `servers` order, so the injected listing doesn't reshuffle per run.
      resources = perServer.flat();
    },
    closeSession: async () => {
      for (const server of [...servers].reverse()) {
        try {
          await server.close();
        } catch {
          // best-effort teardown; the assembler already guards + times out stop().
        }
      }
    },
  };

  return capability;
}
