import type { Component, Focusable } from 'operon-pi-tui';
import type { Harness, HarnessSession, ModelRuntime } from 'operon-agents';

import type { ColorToken, ResolvedTheme, ThemeName } from '../theme/index.ts';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/tui.ts';
import type { StreamingUIController } from '../controllers/streaming-ui.ts';
import type { TasksBrowserController } from '../controllers/tasks-browser.ts';
import type { TUIState } from '../tui-state.ts';
import type { AppState, InlineSkillActivation, ProgressSpinnerHandle, QueuedMessage, TranscriptEntry } from '../types.ts';
import { formatErrorMessage } from '../utils/event-payload.ts';
import { extractInlineSkillActivations, findInlineSkillTokens } from '../utils/inline-skill-tokens.ts';
import { handleCopyCommand } from './copy.ts';
import {
  handleCompactCommand,
  handleEditorCommand,
  handleModelCommand,
  handlePermissionCommand,
  handlePlanCommand,
  handleThemeCommand,
  handleThinkingCommand,
  showPermissionPicker,
  showSettingsSelector,
} from './config.ts';
import { handleContinueCommand } from './continue.ts';
import { handleGoalCommand } from './goal.ts';
import { showContextReport, showMcpServers, showStatusReport, showUsage } from './info.ts';
import { parseSlashInput } from './parse.ts';
import { handlePluginsCommand } from './plugins.ts';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability, type BuiltinSlashCommandName } from './registry.ts';
import { handleReloadTuiCommand } from './reload.ts';
import type { SkillListSession } from './skills.ts';
import { canRestoreSubmittedInput, resolveSlashCommandInput, slashBusyMessage, slashCommandBusyReason } from './resolve.ts';
import { handleExportMdCommand, handleForkCommand, handleInitCommand, handleTitleCommand } from './session.ts';

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

export interface SlashCommandHost {
  state: TUIState;
  session: HarnessSession | undefined;
  readonly harness: Harness;
  readonly version: string;
  /** The model registry a switch resolves against: built-ins plus configured endpoints. */
  readonly models: ModelRuntime;
  deferUserMessages: boolean;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  refreshSlashCommandAutocomplete(): void;
  /** Rebuild the slash-command list contributed by the session's own registry. */
  refreshSessionCommands(session?: HarnessSession): Promise<void>;
  /** Rebuild the skill slash-command list. */
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
  /** A `/goal cancel` is about to fire: the next cleared goal snapshot is a cancel, not a completion. */
  noteGoalCancelled?(): void;
  /** Remember a model as the default for the next launch (written to tui.toml). */
  saveDefaultModel(id: string): Promise<void>;

  // Session
  requireSession(): HarnessSession;
  /** Create the session on first use; undefined (with the error shown) when creation fails. */
  ensureSession(): Promise<HarnessSession | undefined>;
  waitForLazyCreation(): Promise<void>;
  switchToSession(session: HarnessSession, message: string): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;
  sendQueuedMessage(session: HarnessSession, item: QueuedMessage): void;

  // UI
  showProgressSpinner(label: string): ProgressSpinnerHandle;
  applyTheme(theme: ThemeName, resolved?: ResolvedTheme): Promise<void>;
  refreshTerminalThemeTracking(): void;

  // Dispatch
  stop(exitCode?: number): Promise<void>;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(): Promise<void>;
  sendNormalUserInput(text: string): void;
  /** Submit a prompt that activates one or more skills inline, as a single turn. */
  sendInlineSkillUserInput(text: string, activations: readonly InlineSkillActivation[]): Promise<void>;
  sendSkillActivation(session: HarnessSession, skillName: string, skillArgs: string): void;
  /** Run one of the session's own commands (`session.runCommand`). */
  runSessionCommand(session: HarnessSession, commandName: string, args: string): void;
  readonly skillCommandMap: Map<string, string>;
  readonly sessionCommandNames: Set<string>;

  // Controller refs
  readonly streamingUI: StreamingUIController;
  readonly tasksBrowserController: TasksBrowserController;
}

// ---------------------------------------------------------------------------
// Dispatch — entry point from handleUserInput
// ---------------------------------------------------------------------------

export function dispatchInput(host: SlashCommandHost, text: string): void {
  if (parseSlashInput(text) !== null) {
    // A leading skill command combined with further inline skill tokens is one submission.
    if (dispatchInlineSkillCombo(host, text)) return;
    void executeSlashCommand(host, text);
    return;
  }
  const activations = extractInlineSkillActivations(text, host.skillCommandMap);
  if (activations.length > 0) {
    void host.sendInlineSkillUserInput(text, activations);
    return;
  }
  host.sendNormalUserInput(text);
}

/**
 * Handle a leading-slash input that may be a bundled submission. Returns true when the input was
 * claimed, false when it should fall through to the regular single-command path.
 *
 * Bundle rule: two or more known skill tokens with the first one leading the input make the whole
 * input one bundled prompt in which every token activates with NO args.
 */
function dispatchInlineSkillCombo(host: SlashCommandHost, text: string): boolean {
  const intent = resolveSlashCommandInput({
    input: text,
    skillCommandMap: host.skillCommandMap,
    sessionCommandNames: host.sessionCommandNames,
    isStreaming: false,
    isCompacting: false,
  });
  if (intent.kind !== 'skill' && intent.kind !== 'message') return false;

  const tokens = findInlineSkillTokens(text, {
    isKnownSkill: (commandName) => host.skillCommandMap.has(commandName) || host.skillCommandMap.has(`skill:${commandName}`),
    includeLeading: true,
  });
  if (tokens.length >= 2 && tokens[0]!.start === 0) {
    const activations = extractInlineSkillActivations(text, host.skillCommandMap, { includeLeading: true });
    void host.sendInlineSkillUserInput(text, activations);
    return true;
  }

  if (intent.kind !== 'message') return false;
  const activations = extractInlineSkillActivations(text, host.skillCommandMap);
  if (activations.length === 0) return false;
  void host.sendInlineSkillUserInput(text, activations);
  return true;
}

async function executeSlashCommand(host: SlashCommandHost, input: string): Promise<void> {
  const intent = resolveSlashCommandInput({
    input,
    skillCommandMap: host.skillCommandMap,
    sessionCommandNames: host.sessionCommandNames,
    isStreaming: host.state.appState.streamingPhase !== 'idle',
    isCompacting: host.state.appState.isCompacting,
  });

  switch (intent.kind) {
    case 'not-command':
      return;
    case 'blocked':
      host.showError(slashBusyMessage(intent.commandName, intent.reason));
      // The editor buffer was cleared on submit; give the rejected command line back.
      host.restoreInputText(input);
      return;
    case 'invalid':
      host.showError(`Invalid slash command: /${intent.commandName}`);
      return;
    case 'skill': {
      const session = host.session ?? (await ensureSessionForCommand(host));
      if (session === undefined) return;
      const busyReason = slashCommandBusyReason({
        isStreaming: host.state.appState.streamingPhase !== 'idle',
        isCompacting: host.state.appState.isCompacting,
      });
      if (busyReason !== undefined && host.session === undefined) {
        host.showError(slashBusyMessage(intent.commandName, busyReason));
        return;
      }
      host.sendSkillActivation(session, intent.skillName, intent.args);
      return;
    }
    case 'session-command': {
      const session = host.session ?? (await ensureSessionForCommand(host));
      if (session === undefined) return;
      host.runSessionCommand(session, intent.commandName, intent.args);
      return;
    }
    case 'message':
      host.sendNormalUserInput(intent.input);
      return;
    case 'builtin':
      try {
        await handleBuiltInSlashCommand(host, intent.name, intent.args, input);
      } catch (error) {
        host.showError(formatErrorMessage(error));
      }
      return;
  }
}

async function ensureSessionForCommand(host: SlashCommandHost): Promise<HarnessSession | undefined> {
  const session = await host.ensureSession();
  if (session === undefined) host.showError(NO_ACTIVE_SESSION_MESSAGE);
  return session;
}

/** Builtins that need an active session; it is created on first use. */
const SESSION_REQUIRING_COMMANDS: ReadonlySet<BuiltinSlashCommandName> = new Set([
  'compact',
  'context',
  'continue',
  'export-md',
  'fork',
  'goal',
  'init',
  'plan',
  'title',
]);

async function handleBuiltInSlashCommand(
  host: SlashCommandHost,
  name: BuiltinSlashCommandName,
  args: string,
  input: string,
): Promise<void> {
  if (host.session === undefined && SESSION_REQUIRING_COMMANDS.has(name)) {
    const session = await ensureSessionForCommand(host);
    if (session === undefined) {
      if (canRestoreSubmittedInput(host)) host.restoreInputText(input);
      return;
    }
    // A first prompt may have started a turn while the session was being created; re-check the
    // availability gate that was resolved before the await.
    const command = findBuiltInSlashCommand(name);
    const busyReason = slashCommandBusyReason({
      isStreaming: host.state.appState.streamingPhase !== 'idle',
      isCompacting: host.state.appState.isCompacting,
    });
    if (busyReason !== undefined && command !== undefined && resolveSlashCommandAvailability(command, args) === 'idle-only') {
      host.showError(slashBusyMessage(name, busyReason));
      if (canRestoreSubmittedInput(host)) host.restoreInputText(input);
      return;
    }
  }
  switch (name) {
    case 'exit':
      void host.stop();
      return;
    case 'help':
      host.showHelpPanel();
      return;
    case 'version':
      host.showStatus(`Operon TUI v${host.version}`);
      return;
    case 'new': {
      await host.waitForLazyCreation();
      const busyReason = slashCommandBusyReason({
        isStreaming: host.state.appState.streamingPhase !== 'idle',
        isCompacting: host.state.appState.isCompacting,
      });
      if (busyReason !== undefined) {
        host.showError(slashBusyMessage(name, busyReason));
        return;
      }
      await host.createNewSession();
      host.state.ui.requestRender();
      return;
    }
    case 'sessions':
      void host.showSessionPicker();
      return;
    case 'continue':
      await handleContinueCommand(host);
      return;
    case 'tasks':
      void host.tasksBrowserController.show();
      return;
    case 'mcp':
      void showMcpServers(host);
      return;
    case 'plugins':
      await handlePluginsCommand(host, args);
      return;
    case 'reload-tui':
      await handleReloadTuiCommand(host);
      return;
    case 'editor':
      await handleEditorCommand(host, args);
      return;
    case 'theme':
      await handleThemeCommand(host, args);
      return;
    case 'model':
      await handleModelCommand(host, args);
      return;
    case 'thinking':
      await handleThinkingCommand(host, args);
      return;
    case 'permission':
      await handlePermissionCommand(host, args);
      return;
    case 'settings':
      showSettingsSelector(host);
      return;
    case 'usage':
      void showUsage(host);
      return;
    case 'context':
      void showContextReport(host);
      return;
    case 'status':
      void showStatusReport(host);
      return;
    case 'title':
      await handleTitleCommand(host, args);
      return;
    case 'plan':
      await handlePlanCommand(host, args);
      return;
    case 'compact':
      await handleCompactCommand(host, args);
      return;
    case 'goal':
      await handleGoalCommand(host, args);
      return;
    case 'init':
      await handleInitCommand(host);
      return;
    case 'fork':
      await handleForkCommand(host, args);
      return;
    case 'export-md':
      await handleExportMdCommand(host, args);
      return;
    case 'copy':
      await handleCopyCommand(host);
      return;
    default:
      host.showError(`Unknown slash command: /${String(name)}`);
      return;
  }
}

export { showPermissionPicker };
