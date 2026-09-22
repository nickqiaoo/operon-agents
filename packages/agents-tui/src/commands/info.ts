import { StatusPanelComponent } from '../components/messages/status-panel.ts';
import { McpStatusPanelComponent } from '../components/messages/mcp-status-panel.ts';
import { UsagePanelComponent } from '../components/messages/usage-panel.ts';
import { ContextPanelComponent } from '../components/messages/context-panel.ts';
import { PERMISSION_MODE_DISPLAY_NAMES } from '../utils/permission-mode.ts';
import { modelDisplayName } from '../utils/model-catalog.ts';
import { thinkingLabel } from '../utils/thinking.ts';
import { formatErrorMessage } from '../utils/event-payload.ts';
import type { McpServerStatusSnapshot } from '../utils/mcp-server-status.ts';
import type { SlashCommandHost } from './dispatch.ts';

/** `/status` — session identity and the runtime knobs that decide how a turn runs. */
export async function showStatusReport(host: SlashCommandHost): Promise<void> {
  const { appState } = host.state;
  const session = host.session;
  let mcpServers = 0;
  let skills = 0;
  let plugins = 0;
  if (session !== undefined) {
    mcpServers = (session.mcp?.list() ?? []).length;
    skills = session.skills.listSkills().length;
    plugins = session.plugins.summaries().length;
  }
  host.state.transcriptContainer.addChild(
    new StatusPanelComponent({
      version: host.version,
      model: modelDisplayName(appState.model, appState.availableModels[appState.model]),
      thinking: thinkingLabel(appState.thinkingLevel),
      permission: PERMISSION_MODE_DISPLAY_NAMES[appState.permissionMode],
      planMode: appState.planMode,
      workDir: appState.workDir,
      sessionId: appState.sessionId,
      sessionTitle: appState.sessionTitle,
      mcpServers,
      skills,
      plugins,
    }),
  );
  host.state.ui.requestRender();
}

/** `/mcp` — every configured MCP server with its connection state and tool count. */
export async function showMcpServers(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showStatus('No active session; MCP servers connect with the first one.', 'textMuted');
    return;
  }
  let servers: McpServerStatusSnapshot[];
  try {
    servers = await Promise.all(
      (session.mcp?.list() ?? []).map(async (view) => ({
        name: view.name,
        transport: view.transport,
        status: view.status,
        toolCount: view.status === 'connected' ? (await session.mcp?.listTools(view.name).catch(() => []) ?? []).length : 0,
        ...(view.error !== undefined ? { error: view.error } : {}),
      })),
    );
  } catch (error) {
    host.showError(`Failed to read MCP server status: ${formatErrorMessage(error)}`);
    return;
  }
  if (servers.length === 0) {
    host.showStatus('No MCP servers configured.', 'textMuted');
    return;
  }
  host.state.transcriptContainer.addChild(new McpStatusPanelComponent(servers));
  host.state.ui.requestRender();
}

/** `/usage` — tokens spent this session against the active model's context window. */
export function showUsage(host: SlashCommandHost): void {
  const { appState } = host.state;
  host.state.transcriptContainer.addChild(
    new UsagePanelComponent({
      model: modelDisplayName(appState.model, appState.availableModels[appState.model]),
      cumulativeTokens: appState.cumulativeTokens ?? 0,
      contextTokens: appState.contextTokens,
      maxContextTokens: appState.maxContextTokens,
      contextUsage: appState.contextUsage,
    }),
  );
  host.state.ui.requestRender();
}

/** `/context` — what actually fills the window: system prompt, tools, messages, injections. */
export function showContextReport(host: SlashCommandHost): void {
  const session = host.session;
  const breakdown = session?.getContextBreakdown();
  if (breakdown === undefined) {
    host.showStatus('No context measurement yet — it is taken at the first turn boundary.', 'textMuted');
    return;
  }
  host.state.transcriptContainer.addChild(new ContextPanelComponent(breakdown));
  host.state.ui.requestRender();
}
