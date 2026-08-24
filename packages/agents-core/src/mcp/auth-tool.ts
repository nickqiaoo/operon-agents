import { ToolAccesses, type Tool, type ToolPlan, type ToolResult } from "../index.ts";
import { qualifyMcpToolName } from "./tool-naming.ts";
import { AlreadyAuthorizedError, type McpOAuthService } from "./oauth/index.ts";

const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export const MCP_OAUTH_AUTHORIZATION_URL_UPDATE = "mcp_oauth_authorization_url";

export interface CreateMcpAuthToolOptions {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly oauthService: McpOAuthService;
  readonly reconnect: (signal?: AbortSignal) => Promise<void>;
  readonly timeoutMs?: number;
}

const description = (serverName: string): string =>
  `Authenticate with MCP server "${serverName}" via OAuth.

This server requires an OAuth login that has not yet been completed. Calling this tool starts the authorization flow:

  1. The tool prints an authorization URL.
  2. **You must show that URL to the user verbatim** and ask them to open it in a browser, sign in, and approve the client.
  3. The tool blocks (up to 15 minutes) until the browser redirects back to the local callback listener.
  4. On success, the MCP server reconnects and the real tools replace this synthetic tool.

Takes no arguments. Treat the URL as sensitive — do not modify it or strip query parameters.`;

export function createMcpAuthTool(options: CreateMcpAuthToolOptions): Tool {
  const { serverName, serverUrl, oauthService, reconnect, timeoutMs } = options;
  const name = qualifyMcpToolName(serverName, "authenticate");

  return {
    schema: {
      name,
      description: description(serverName),
      parameters: { type: "object", properties: {} },
    },
    resolve: (): ToolPlan => ({
      approvalRule: name,
      accesses: ToolAccesses.all(),
      display: { kind: "mcp_oauth", title: name, detail: `Authenticate ${serverName}` },
      run: async (ctx): Promise<ToolResult> => {
        const { signal, onUpdate } = ctx;
        signal.throwIfAborted();

        onUpdate?.({ kind: "status", text: `Discovering OAuth metadata for ${serverName}…` });

        let flow: Awaited<ReturnType<McpOAuthService["beginAuthorization"]>>;
        try {
          flow = await oauthService.beginAuthorization(serverName, serverUrl);
        } catch (error) {
          if (error instanceof AlreadyAuthorizedError) {
            onUpdate?.({ kind: "status", text: `Already authorized; reconnecting ${serverName}…` });
            try {
              await reconnect(signal);
            } catch (reconnectError) {
              return errorResult(serverName, reconnectError);
            }
            return textResult(
              `MCP server "${serverName}" already had valid OAuth credentials. Reconnected; real tools are available now.`,
            );
          }
          return errorResult(serverName, error);
        }

        const urlText = flow.authorizationUrl.toString();
        onUpdate?.({
          kind: "custom",
          customKind: MCP_OAUTH_AUTHORIZATION_URL_UPDATE,
          customData: { serverName, authorizationUrl: urlText },
        });
        onUpdate?.({
          kind: "status",
          text:
            `Open this URL in your browser to authorize "${serverName}":\n\n${urlText}\n\n` +
            `Waiting for the OAuth callback (timeout 15 min). If you cancel, call this tool again to restart.`,
        });

        try {
          await flow.complete({ signal, timeoutMs: timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS });
        } catch (error) {
          return errorResult(serverName, error, urlText);
        }

        onUpdate?.({ kind: "status", text: `Authorized — reconnecting ${serverName}…` });
        try {
          await reconnect(signal);
        } catch (error) {
          return errorResult(serverName, error);
        }

        return textResult(
          `MCP server "${serverName}" authenticated successfully. The real MCP tools have replaced this synthetic authenticate tool.`,
        );
      },
    }),
  };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(serverName: string, error: unknown, authorizationUrl?: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const suffix =
    authorizationUrl !== undefined
      ? `\n\nAuthorization URL (still valid if the listener has not timed out): ${authorizationUrl}`
      : "";
  return {
    isError: true,
    content: [{ type: "text", text: `OAuth flow for MCP server "${serverName}" did not complete: ${message}${suffix}` }],
  };
}
