import { defineModel, type PermissionMode, type ThinkingLevel } from 'operon-agents';

import { ModelSelectorComponent, type ModelSelection } from '../components/dialogs/model-selector.ts';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector.ts';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector.ts';
import { ThinkingSelectorComponent } from '../components/dialogs/thinking-selector.ts';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector.ts';
import { EditorSelectorComponent } from '../components/dialogs/editor-selector.ts';
import { DEFAULT_TUI_CONFIG, loadTuiConfig, saveTuiConfig, type TuiConfig } from '../config.ts';
import { isBuiltInTheme, type ThemeName } from '../theme/index.ts';
import { buildFullModelCatalog, modelDisplayName, splitModelId, thinkingLevelsFor } from '../utils/model-catalog.ts';
import { PERMISSION_MODE_DISPLAY_NAMES, isPermissionMode } from '../utils/permission-mode.ts';
import { DEFAULT_THINKING_LEVEL, isThinkingLevel, THINKING_LEVELS, thinkingLabel } from '../utils/thinking.ts';
import { formatErrorMessage } from '../utils/event-payload.ts';
import { showContextReport, showUsage } from './info.ts';
import type { SlashCommandHost } from './dispatch.ts';

/** Switching models mid-conversation re-sends the whole context: the prefix cache is cold. */
const MODEL_SWITCH_WARNING =
  'Switching models mid-conversation re-reads the whole context at full price — the provider cache does not carry over.';

function hasConversationHistory(host: SlashCommandHost): boolean {
  return host.state.transcriptEntries.some((entry) => entry.kind === 'user' || entry.kind === 'assistant');
}

/** The current on-disk TUI preferences, as reflected in `appState`. */
export function currentTuiConfig(host: Pick<SlashCommandHost, 'state'>): TuiConfig {
  const { appState } = host.state;
  return {
    theme: appState.theme,
    renderLatex: appState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex,
    disablePasteBurst: appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    editorCommand: appState.editorCommand,
    notifications: appState.notifications,
    statusLine: appState.statusLine ?? DEFAULT_TUI_CONFIG.statusLine,
  };
}

// ---------------------------------------------------------------------------
// /plan
// ---------------------------------------------------------------------------

export async function handlePlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  const arg = args.trim().toLowerCase();
  if (arg === 'clear') {
    await session.clearPlan();
    host.setAppState({ planMode: false });
    host.showStatus('Plan cleared; plan mode off.', 'success');
    return;
  }
  const enabled = arg === 'on' ? true : arg === 'off' ? false : !host.state.appState.planMode;
  await applyPlanMode(host, enabled);
}

async function applyPlanMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  const session = host.requireSession();
  try {
    await session.setPlanMode(enabled);
  } catch (error) {
    host.showError(`Failed to switch plan mode: ${formatErrorMessage(error)}`);
    return;
  }
  host.setAppState({ planMode: enabled });
  host.showStatus(`Plan mode: ${enabled ? 'ON' : 'OFF'}`, enabled ? 'primary' : 'textMuted');
}

// ---------------------------------------------------------------------------
// /compact
// ---------------------------------------------------------------------------

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  const instruction = args.trim();
  try {
    const pending = await session.compact(instruction.length > 0 ? { instruction } : {});
    host.showStatus(`Compaction ${pending.id} runs at the next step boundary.`, 'textMuted');
  } catch (error) {
    host.showError(`Failed to request compaction: ${formatErrorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// /model
// ---------------------------------------------------------------------------

export async function handleModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const id = args.trim();
  if (id.length === 0) {
    showModelPicker(host);
    return;
  }
  if (splitModelId(id) === undefined) {
    host.showError('A model is named provider/model, for example anthropic/claude-opus-4-8.');
    return;
  }
  await performModelSwitch(host, { id, thinking: host.state.appState.thinkingLevel });
}

export function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): void {
  const models = host.state.appState.availableModels;
  if (Object.keys(models).length <= 1) {
    host.showStatus(
      'Only the active model is configured. Set another provider\'s API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) and it will appear here; /model <provider/model> switches to anything the engine knows.',
      'textMuted',
    );
    return;
  }
  const picker = new ModelSelectorComponent({
    models,
    currentValue: host.state.appState.model,
    selectedValue,
    currentThinkingLevel: host.state.appState.thinkingLevel,
    searchable: true,
    pageSize: 12,
    ...(hasConversationHistory(host) ? { warning: MODEL_SWITCH_WARNING } : {}),
    onSelect: (selection) => {
      host.restoreEditor();
      void performModelSwitch(host, selection);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

async function performModelSwitch(host: SlashCommandHost, selection: ModelSelection): Promise<void> {
  const split = splitModelId(selection.id);
  if (split === undefined) {
    host.showError(`Model must be provider/model, got ${JSON.stringify(selection.id)}.`);
    return;
  }
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  try {
    session.setModel(defineModel({ provider: split.provider, model: split.model, runtime: host.models }));
  } catch (error) {
    host.showError(`Failed to switch model: ${formatErrorMessage(error)}`);
    return;
  }
  const patch: { model: string; thinkingLevel?: ThinkingLevel } = { model: selection.id };
  if (selection.thinking !== undefined && selection.thinking !== host.state.appState.thinkingLevel) {
    session.setThinking(selection.thinking);
    patch.thinkingLevel = selection.thinking;
  }
  // A model switched to by id may not be in the configured list; fall back to the full registry
  // so the context gauge still gets its window.
  const entry = host.state.appState.availableModels[selection.id] ?? buildFullModelCatalog([], host.models)[selection.id];
  host.setAppState({ ...patch, ...(entry !== undefined && entry.contextWindow > 0 ? { maxContextTokens: entry.contextWindow } : {}) });
  const levelSuffix = patch.thinkingLevel === undefined ? '' : ` (thinking ${thinkingLabel(patch.thinkingLevel)})`;
  host.showStatus(`Model: ${modelDisplayName(selection.id, entry)}${levelSuffix}`, 'success');
  await persistModelSelection(host, selection.id);
}

/** Remember the pick so the next launch starts on it (the CLI's `--model` still wins). */
async function persistModelSelection(host: SlashCommandHost, id: string): Promise<void> {
  try {
    await host.saveDefaultModel(id);
  } catch (error) {
    host.showStatus(`Model switched, but could not be saved as the default: ${formatErrorMessage(error)}`, 'warning');
  }
}

// ---------------------------------------------------------------------------
// /thinking
// ---------------------------------------------------------------------------

export async function handleThinkingCommand(host: SlashCommandHost, args: string): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    showThinkingPicker(host);
    return;
  }
  if (!isThinkingLevel(arg)) {
    host.showError(`Thinking level must be one of ${THINKING_LEVELS.join(', ')}.`);
    return;
  }
  await applyThinkingLevel(host, arg);
}

function showThinkingPicker(host: SlashCommandHost): void {
  const entry = host.state.appState.availableModels[host.state.appState.model];
  const levels = thinkingLevelsFor(entry);
  if (levels.length === 0) {
    host.showStatus('The active model does not support extended thinking.', 'warning');
    return;
  }
  host.mountEditorReplacement(
    new ThinkingSelectorComponent({
      levels,
      currentValue: host.state.appState.thinkingLevel,
      onSelect: (level) => {
        host.restoreEditor();
        void applyThinkingLevel(host, level);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyThinkingLevel(host: SlashCommandHost, level: ThinkingLevel): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  session.setThinking(level);
  host.setAppState({ thinkingLevel: level });
  host.showStatus(`Thinking level: ${thinkingLabel(level)}`, 'success');
}

// ---------------------------------------------------------------------------
// /permission
// ---------------------------------------------------------------------------

export function showPermissionPicker(host: SlashCommandHost, initialMode?: PermissionMode): void {
  host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      initialValue: initialMode,
      onSelect: (mode) => {
        host.restoreEditor();
        void applyPermissionChoice(host, mode);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export async function handlePermissionCommand(host: SlashCommandHost, args: string): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    showPermissionPicker(host);
    return;
  }
  if (!isPermissionMode(arg)) {
    host.showError('Permission mode must be one of manual, workspace, yolo, auto.');
    return;
  }
  await applyPermissionChoice(host, arg);
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  try {
    await session.setPermissionMode(mode);
  } catch (error) {
    host.showError(`Failed to switch permission mode: ${formatErrorMessage(error)}`);
    return;
  }
  host.setAppState({ permissionMode: mode });
  host.showStatus(`Permission mode: ${PERMISSION_MODE_DISPLAY_NAMES[mode]}`, mode === 'auto' ? 'warning' : 'success');
}

// ---------------------------------------------------------------------------
// /theme
// ---------------------------------------------------------------------------

export async function handleThemeCommand(host: SlashCommandHost, args: string): Promise<void> {
  const name = args.trim();
  if (name.length === 0) {
    showThemePicker(host);
    return;
  }
  await applyThemeChoice(host, name);
}

function showThemePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
      onSelect: (theme) => {
        host.restoreEditor();
        void applyThemeChoice(host, theme);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyThemeChoice(host: SlashCommandHost, theme: ThemeName): Promise<void> {
  try {
    await host.applyTheme(theme);
  } catch (error) {
    host.showError(`Failed to apply theme "${theme}": ${formatErrorMessage(error)}`);
    return;
  }
  host.refreshTerminalThemeTracking();
  await saveTuiPreference(host, { theme });
  host.showStatus(`Theme: ${theme}${isBuiltInTheme(theme) ? '' : ' (custom)'}`, 'success');
}

// ---------------------------------------------------------------------------
// /editor
// ---------------------------------------------------------------------------

export async function handleEditorCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = args.trim();
  if (command.length === 0) {
    showEditorPicker(host);
    return;
  }
  await applyEditorChoice(host, command);
}

function showEditorPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue: host.state.appState.editorCommand ?? '',
      onSelect: (value) => {
        host.restoreEditor();
        void applyEditorChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyEditorChoice(host: SlashCommandHost, value: string): Promise<void> {
  const editorCommand = value.trim().length === 0 ? null : value.trim();
  host.setAppState({ editorCommand });
  await saveTuiPreference(host, { editorCommand });
  host.showStatus(editorCommand === null ? 'External editor: $VISUAL / $EDITOR' : `External editor: ${editorCommand}`, 'success');
}

// ---------------------------------------------------------------------------
// /settings
// ---------------------------------------------------------------------------

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
      onSelect: (value) => {
        host.restoreEditor();
        handleSettingsSelection(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function handleSettingsSelection(host: SlashCommandHost, value: SettingsSelection): void {
  switch (value) {
    case 'model':
      showModelPicker(host);
      return;
    case 'thinking':
      showThinkingPicker(host);
      return;
    case 'permission':
      showPermissionPicker(host);
      return;
    case 'theme':
      showThemePicker(host);
      return;
    case 'editor':
      showEditorPicker(host);
      return;
    case 'usage':
      void showUsage(host);
      return;
    case 'context':
      void showContextReport(host);
      return;
  }
}

/** Merge one preference into `tui.toml`, leaving everything else as it is on disk. */
async function saveTuiPreference(host: SlashCommandHost, patch: Partial<TuiConfig>): Promise<void> {
  try {
    const onDisk = await loadTuiConfig().catch(() => currentTuiConfig(host));
    await saveTuiConfig({ ...onDisk, ...patch });
  } catch (error) {
    host.showStatus(`Could not save the preference: ${formatErrorMessage(error)}`, 'warning');
  }
}

export { DEFAULT_THINKING_LEVEL };
