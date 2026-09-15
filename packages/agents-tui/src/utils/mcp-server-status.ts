
/** A server row as the TUI shows it: the engine's view plus a tool count it looks up. */
export interface McpServerStatusSnapshot {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

export const MCP_STARTUP_STATUS_ROW_LIMIT = 4;

function mcpStartupStatusPriority(status: McpServerStatusSnapshot['status']): number {
  switch (status) {
    case 'failed':
      return 0;
    case 'needs-auth':
      return 1;
    case 'pending':
      return 2;
    case 'connected':
      return 3;
    case 'disabled':
      return 4;
  }
}

export function selectMcpStartupStatusRows(servers: readonly McpServerStatusSnapshot[]): McpServerStatusSnapshot[] {
  return [...servers]
    .filter((server) => server.status !== 'disabled')
    .toSorted((a, b) => mcpStartupStatusPriority(a.status) - mcpStartupStatusPriority(b.status))
    .slice(0, MCP_STARTUP_STATUS_ROW_LIMIT);
}

export function formatMcpStartupStatusSummary(servers: readonly McpServerStatusSnapshot[]): string {
  const counts = new Map<string, number>();
  for (const server of servers) counts.set(server.status, (counts.get(server.status) ?? 0) + 1);
  const parts: string[] = [];
  const labels: Record<string, string> = { failed: 'failed', 'needs-auth': 'need auth', pending: 'connecting', connected: 'connected', disabled: 'disabled' };
  for (const status of ['failed', 'needs-auth', 'pending', 'connected', 'disabled']) {
    const n = counts.get(status);
    if (n !== undefined && n > 0) parts.push(`${String(n)} ${labels[status] ?? status}`);
  }
  return parts.join(', ');
}

export function mcpServerStatusKey(server: McpServerStatusSnapshot): string {
  return JSON.stringify([server.status, server.transport, server.toolCount, server.error]);
}
