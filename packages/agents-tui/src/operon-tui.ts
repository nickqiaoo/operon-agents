/**
 * `OperonTui` — the terminal client's coordinator.
 *
 * It owns the layout, the app state, and the session lifecycle, and delegates everything else to
 * the controllers in `controllers/`: `SessionEventHandler` routes the engine's event stream,
 * `StreamingUIController` owns live rendering, `SessionReplayRenderer` rebuilds a resumed
 * transcript from the session journal, `EditorKeyboardController` owns the key map, and
 * `TasksBrowserController` owns the background-task panel. Each one reaches back through an
 * explicit `*Host` interface, so none of them needs this class's concrete type.
 *
 * The engine is reached only through the public Harness API — `HarnessSession.prompt` / `steer`,
 * `onEvent`, `setApprovalHandler` / `setQuestionHandler`, and the session's own control methods.
 */

import type { Component, Focusable } from 'operon-pi-tui';
import { deleteAllKittyImages, getCapabilities, Spacer, TuiAltScreen, TuiMainScreen } from 'operon-pi-tui';
import { defineModel, type ApprovalRequest, type Message, type ModelRuntime, type ApprovalResponse, type BackgroundTaskInfo, type Harness, type HarnessSession, type PermissionMode, type SkillSummary, type ThinkingLevel } from 'operon-agents';
import { resolve } from 'node:path';

import { appendInputHistory, loadInputHistory } from './app/utils/history/input-history.ts';
import { getInputHistoryFile } from './app/utils/paths.ts';
import { detectFdPath } from './app/utils/process/fd-detect.ts';
import { restoreTerminalModes } from './app/utils/terminal-restore.ts';
import { quoteShellArg } from './app/utils/shell-quote.ts';
import { copyTextToClipboard } from './app/utils/clipboard/clipboard-text.ts';

import {
  BUILTIN_SLASH_COMMANDS,
  buildExtensionSlashCommands,
  buildSkillSlashCommands,
  goalObjectiveLengthWarning,
  sortSlashCommands,
  type SkillListSession,
  type TuiSlashCommand,
} from './commands/index.ts';
import { dispatchInput, type SlashCommandHost } from './commands/dispatch.ts';
import { handlePlanCommand } from './commands/config.ts';
import { GutterContainer } from './components/chrome/gutter-container.ts';
import { MoonLoader, type SpinnerStyle } from './components/chrome/moon-loader.ts';
import { WelcomeComponent } from './components/chrome/welcome.ts';
import { pickRandomWorkingTip } from './components/chrome/working-tips.ts';
import { ApprovalPanelComponent, type ApprovalPanelResponse } from './components/dialogs/approval-panel.ts';
import { ApprovalPreviewViewer, type ApprovalPreviewBlock } from './components/dialogs/approval-preview.ts';
import { CompactionComponent } from './components/dialogs/compaction.ts';
import { HelpPanelComponent } from './components/dialogs/help-panel.ts';
import { QuestionDialogComponent } from './components/dialogs/question-dialog.ts';
import { SessionPickerComponent, type SessionRow } from './components/dialogs/session-picker.ts';
import { FileMentionProvider, type SlashAutocompleteCommand } from './components/editor/file-mention-provider.ts';
import { AssistantMessageComponent } from './components/messages/assistant-message.ts';
import { BackgroundAgentStatusComponent } from './components/messages/background-agent-status.ts';
import { CronMessageComponent } from './components/messages/cron-message.ts';
import { buildGoalMarker } from './components/messages/goal-markers.ts';
import { GoalCompletionMessageComponent, GoalSetMessageComponent } from './components/messages/goal-panel.ts';
import { ShellRunComponent } from './components/messages/shell-run.ts';
import { SkillActivationComponent } from './components/messages/skill-activation.ts';
import { NoticeMessageComponent, StatusMessageComponent } from './components/messages/status-message.ts';
import { StepSummaryComponent } from './components/messages/step-summary.ts';
import { ThinkingComponent } from './components/messages/thinking.ts';
import { ToolCallComponent } from './components/messages/tool-call.ts';
import { ReplayTurnBoundaryComponent, UserMessageComponent } from './components/messages/user-message.ts';
import { ActivityPaneComponent, type ActivityPaneMode } from './components/panes/activity-pane.ts';
import { QueuePaneComponent } from './components/panes/queue-pane.ts';
import { DEFAULT_TUI_CONFIG, loadTuiConfig, saveTuiConfig, TuiConfigParseError, type TuiConfig } from './config.ts';
import { MAIN_AGENT_ID, NO_ACTIVE_SESSION_MESSAGE, NO_MODEL_MESSAGE, PRODUCT_NAME, SESSION_LIST_PAGE_SIZE } from './constant/tui.ts';
import { CHROME_GUTTER } from './constant/rendering.ts';
import { ClipboardImageHintController } from './controllers/clipboard-image-hint.ts';
import { EditorKeyboardController } from './controllers/editor-keyboard.ts';
import { SessionEventHandler } from './controllers/session-event-handler.ts';
import { SessionReplayRenderer } from './controllers/session-replay.ts';
import { StreamingUIController } from './controllers/streaming-ui.ts';
import { TasksBrowserController } from './controllers/tasks-browser.ts';
import { adaptPanelResponse } from './reverse-rpc/approval/adapter.ts';
import { ApprovalController } from './reverse-rpc/approval/controller.ts';
import { createApprovalRequestHandler } from './reverse-rpc/approval/handler.ts';
import { registerReverseRPCHandlers } from './reverse-rpc/index.ts';
import { QuestionController } from './reverse-rpc/question/controller.ts';
import { createQuestionAskHandler } from './reverse-rpc/question/handler.ts';
import type { ApprovalPanelData, QuestionPanelData } from './reverse-rpc/types.ts';
import { currentTheme, getBuiltInPalette, getColorPalette, isBuiltInTheme } from './theme/index.ts';
import type { ColorToken, ResolvedTheme, ThemeName } from './theme/index.ts';
import { createTUIState, type TUIState } from './tui-state.ts';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type InlineSkillActivation,
  type LivePaneState,
  type OperonTuiOptions,
  type ProgressSpinnerHandle,
  type PromptPart,
  type QueuedMessage,
  type SteerInputItem,
  type StepRetryState,
  type TranscriptEntry,
  type TUIStartupOptions,
} from './types.ts';
import { hasDispose, hasHiddenContent, isExpandable, isExpandedComponent } from './utils/component-capabilities.ts';
import { isDeadTerminalError } from './utils/dead-terminal.ts';
import { formatErrorMessage } from './utils/event-payload.ts';
import { pickDetachableToolCalls } from './utils/foreground-task.ts';
import { ImageAttachmentStore, type ImageAttachment } from './utils/image-attachment-store.ts';
import { extractMediaAttachments, type ExtractionResult } from './utils/image-placeholder.ts';
import { installInputLatencyProbe } from './utils/input-latency.ts';
import { buildFullModelCatalog, buildModelCatalog, splitModelId } from './utils/model-catalog.ts';
import { hasPatchChanges } from './utils/object-patch.ts';
import { beginScreenTakeover, endScreenTakeover, type ScreenTakeover } from './utils/screen-takeover.ts';
import { sessionRowsForPicker } from './utils/session-picker-rows.ts';
import { formatBashOutputForDisplay } from './utils/shell-output.ts';
import { formatStepRetryDetail, formatStepRetryLabel } from './utils/step-retry.ts';
import { combineStartupNotice } from './utils/startup.ts';
import { combineSteerInput } from './utils/steer-input.ts';
import { installTerminalFocusTracking } from './utils/terminal-focus.ts';
import { notifyTerminalOnce } from './utils/terminal-notification.ts';
import { installTerminalThemeTracking } from './utils/terminal-theme.ts';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard.ts';
import { getTranscriptComponentEntry, markTranscriptComponent } from './utils/transcript-component-metadata.ts';
import { nextTranscriptId } from './utils/transcript-id.ts';
import {
  expandCutoffIndex,
  groupTurns,
  TRANSCRIPT_EXPAND_TURNS,
  TRANSCRIPT_HYSTERESIS,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
  TRANSCRIPT_KEEP_RECENT_STEPS,
  TRANSCRIPT_MAX_TURNS,
  TRANSCRIPT_WINDOW_ENABLED,
  turnsToTrim,
} from './utils/transcript-window.ts';

export type { TUIState } from './tui-state.ts';
export { createTUIState } from './tui-state.ts';
export type { OperonTuiOptions, TUIStartupOptions, TUIStartupState } from './types.ts';

/** What `main.ts` hands the TUI: the harness to drive plus the resolved startup choices. */
export interface OperonTuiStartupInput {
  readonly startup: TUIStartupOptions;
  /** The registry `main.ts` built from `providers.toml` and handed to the harness. */
  readonly modelRuntime: ModelRuntime;
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
}

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';
type LoadingTipKind = 'moon' | 'composing';

function loadingTipKind(mode: EffectiveActivityPaneMode): LoadingTipKind | undefined {
  if (mode === 'waiting' || mode === 'tool') return 'moon';
  if (mode === 'composing') return 'composing';
  return undefined;
}

function waitingSpinnerLabel(retry: StepRetryState | null): string {
  return retry === null ? '' : formatStepRetryLabel(retry);
}

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function createInitialAppState(input: OperonTuiStartupInput): AppState {
  return {
    model: input.startup.model,
    workDir: input.workDir,
    additionalDirs: [],
    sessionId: '',
    permissionMode: input.startup.permission ?? 'manual',
    planMode: input.startup.plan,
    inputMode: 'prompt',
    thinkingLevel: input.startup.thinking ?? 'medium',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    cumulativeTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: input.tuiConfig.theme,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    renderLatex: input.tuiConfig.renderLatex,
    notifications: input.tuiConfig.notifications,
    statusLine: input.tuiConfig.statusLine,
    // Seeded with just the startup model; `refreshModelCatalog` fills it in once the UI is up.
    availableModels: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
  };
}

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

/** Terminal tab titles are truncated to this many characters. */
const MAX_TERMINAL_TITLE_LENGTH = 60;

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

export class OperonTui {
  readonly harness: Harness;
  readonly options: OperonTuiOptions;
  readonly version: string;
  private readonly modelRuntime: ModelRuntime;
  session: HarnessSession | undefined;
  state: TUIState;
  /** In-flight lazy session creation, shared by concurrent first-use triggers. */
  private ensureSessionPromise: Promise<HarnessSession | undefined> | null = null;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly TuiSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private extensionCommands: readonly TuiSlashCommand[] = [];
  readonly sessionCommandNames = new Set<string>();
  private readonly imageStore = new ImageAttachmentStore();
  /** Detected lazily: detection spawns `fd --version`, which must not delay the first frame. */
  private fdPath: string | null = null;
  private fdDetectionStarted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private clipboardImageHintController: ClipboardImageHintController | undefined;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private startupNotice: string | undefined;
  private lastActivityMode: string | undefined;
  private currentLoadingTip: { kind: LoadingTipKind; tip: string | undefined } | undefined = undefined;
  private lastHistoryContent: string | undefined;
  /**
   * Live `!` shell output, keyed by a local command id so concurrent commands each update their
   * own card. Mutated in place as output arrives; removed when the command completes.
   */
  private readonly shellOutputStreams = new Map<string, { entry: TranscriptEntry; component: ShellRunComponent; abort: AbortController }>();
  readonly streamingUI: StreamingUIController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly editorKeyboard: EditorKeyboardController;

  /** Timer that auto-clears the one-shot "moved to background" footer hint. */
  private detachHintClearTimer: ReturnType<typeof setTimeout> | undefined;

  // The currently-mounted approval panel, kept so the full-screen preview can restore focus to
  // the same instance (and its selection / feedback state) when it closes.
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  private approvalPreview: { component: ApprovalPreviewViewer; takeover: ScreenTakeover; panel: ApprovalPanelComponent } | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  constructor(harness: Harness, startupInput: OperonTuiStartupInput) {
    this.harness = harness;
    this.version = startupInput.version;
    this.modelRuntime = startupInput.modelRuntime;
    this.options = { initialAppState: createInitialAppState(startupInput), startup: startupInput.startup };
    this.startupNotice = startupInput.startupNotice;
    this.state = createTUIState(this.options);
    this.state.footer.setExpandHintProvider(() => this.toolOutputExpandHint());

    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(this.approvalController, this.questionController, {
        showApprovalPanel: (payload) => {
          this.showApprovalPanel(payload);
        },
        hideApprovalPanel: () => {
          this.hideApprovalPanel();
        },
        showQuestionDialog: (payload) => {
          this.showQuestionDialog(payload);
        },
        hideQuestionDialog: () => {
          this.hideQuestionDialog();
        },
      }),
    );
    this.streamingUI = new StreamingUIController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.buildLayout();
  }

  // =========================================================================
  // Autocomplete & dynamic commands
  // =========================================================================

  private getSlashCommands(): readonly TuiSlashCommand[] {
    return [...sortSlashCommands(BUILTIN_SLASH_COMMANDS), ...this.skillCommands, ...this.extensionCommands];
  }

  private setupAutocomplete(): void {
    const slashCommandList: SlashAutocompleteCommand[] = this.getSlashCommands().map((command) => {
      const completer = command.completeArgs;
      return {
        name: command.name,
        aliases: command.aliases,
        description: command.description,
        ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
        ...(completer !== undefined ? { getArgumentCompletions: (prefix: string) => completer(prefix) } : {}),
      };
    });
    const skillCommandNames = new Set(this.skillCommandMap.keys());
    this.state.editor.setAutocompleteProvider(
      new FileMentionProvider(
        slashCommandList,
        this.state.appState.workDir,
        this.fdPath,
        this.state.appState.additionalDirs,
        () => this.state.appState.inputMode,
        skillCommandNames,
      ),
    );

    const argumentHints = new Map<string, string>();
    for (const command of slashCommandList) {
      if (command.argumentHint === undefined) continue;
      argumentHints.set(command.name, command.argumentHint);
      for (const alias of command.aliases ?? []) argumentHints.set(alias, command.argumentHint);
    }
    this.state.editor.setArgumentHints(argumentHints);
    this.state.editor.setSkillCommandNames(skillCommandNames);
  }

  refreshSlashCommandAutocomplete(): void {
    this.setupAutocomplete();
  }

  async refreshSkillCommands(session: SkillListSession | undefined = this.session): Promise<void> {
    if (session === undefined) return;
    let skills: readonly SkillSummary[];
    try {
      skills = await session.skills.listSkills();
    } catch {
      return;
    }
    const built = buildSkillSlashCommands(skills);
    this.skillCommands = built.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of built.commandMap) this.skillCommandMap.set(commandName, skillName);
    this.setupAutocomplete();
  }

  /** Pull the session's own command registry (engine + extension commands) into the palette. */
  async refreshSessionCommands(session: HarnessSession | undefined = this.session): Promise<void> {
    if (session === undefined) return;
    const reserved = new Set<string>();
    for (const command of BUILTIN_SLASH_COMMANDS) {
      reserved.add(command.name);
      for (const alias of command.aliases) reserved.add(alias);
    }
    const built = buildExtensionSlashCommands(session.listCommands(), reserved);
    this.extensionCommands = built.commands;
    this.sessionCommandNames.clear();
    for (const name of built.commandNames) this.sessionCommandNames.add(name);
    this.setupAutocomplete();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    this.registerSignalHandlers();
    try {
      const shouldReplayHistory = await this.init();
      this.mountFooter();
      this.renderWelcome();
      this.setupAutocomplete();
      void this.loadPersistedInputHistory();
      this.state.editorContainer.clear();
      this.state.editorContainer.addChild(this.state.editor);
      this.state.ui.setFocus(this.state.editor);
      if (process.env['OPERON_TUI_INPUT_LATENCY']) installInputLatencyProbe(this.state.ui);
      this.startEventLoop();
      try {
        this.startFdDetection();
        void this.refreshModelCatalog();
        await this.finishStartup(shouldReplayHistory);
      } catch (error) {
        this.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private startEventLoop(): void {
    // Dispose any previous tracking so re-entering the loop cannot stack duplicate listeners.
    this.disposeTerminalTracking();
    this.state.ui.start();
    this.startClipboardImageHintController();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.state);
    this.refreshTerminalThemeTracking();
  }

  private startClipboardImageHintController(): void {
    this.clipboardImageHintController = new ClipboardImageHintController({
      ui: this.state.ui,
      footer: this.state.footer,
      getModelSupportsImage: () => this.supportsImageInput(),
      requestRender: () => {
        this.state.ui.requestRender();
      },
    });
    this.clipboardImageHintController.start();
  }

  /**
   * Ask the engine which models this machine can actually reach — the providers whose credentials
   * are configured — and let the picker offer those. Resolving auth can touch a credential store,
   * so it happens off the startup path; until it lands the picker holds only the active model.
   * With nothing configured at all, the full registry is better than an empty list.
   */
  private async refreshModelCatalog(): Promise<void> {
    const startupModel = this.state.appState.model;
    const available = await buildModelCatalog([startupModel], this.modelRuntime);
    if (this.aborted) return;
    const configuredCount = Object.keys(available).length;
    const catalog = configuredCount > 1 ? available : buildFullModelCatalog([startupModel], this.modelRuntime);
    this.setAppState({ availableModels: catalog });
    const entry = catalog[startupModel];
    if (entry !== undefined && entry.contextWindow > 0) this.setAppState({ maxContextTokens: entry.contextWindow });
  }

  private startFdDetection(): void {
    if (this.fdDetectionStarted) return;
    this.fdDetectionStarted = true;
    this.fdPath = detectFdPath();
    if (this.fdPath !== null) this.setupAutocomplete();
  }

  /** Open or create the startup session. Returns whether its history has to be replayed. */
  private async init(): Promise<boolean> {
    const { startup } = this.options;
    const { workDir } = this.state.appState;

    if (startup.sessionFlag === '') {
      this.state.startupState = 'picker';
      return false;
    }

    let session: HarnessSession | undefined;
    let shouldReplayHistory = false;
    if (startup.sessionFlag !== undefined) {
      const summary = await this.harness.getSessionSummary(startup.sessionFlag);
      if (summary === undefined) throw new Error(`Session "${startup.sessionFlag}" not found.`);
      if (resolve(summary.workDir) !== resolve(workDir)) {
        throw new Error(
          `Session "${startup.sessionFlag}" belongs to ${summary.workDir}. Run: cd ${quoteShellArg(summary.workDir)} && operon-tui --session ${quoteShellArg(startup.sessionFlag)}`,
        );
      }
      session = await this.harness.resumeSession(startup.sessionFlag);
      shouldReplayHistory = true;
    } else if (startup.continueLast) {
      const sessions = await this.harness.listSessions({ workDir });
      const target = sessions[0];
      if (target === undefined) {
        this.appendStartupNotice(`No sessions to continue under "${workDir}"; starting a fresh one.`);
        session = await this.createSessionFromCurrentState();
      } else {
        session = await this.harness.resumeSession(target.id);
        shouldReplayHistory = true;
      }
    } else {
      session = await this.createSessionFromCurrentState();
    }

    await this.setSession(session);
    await this.applyStartupModesToSession(session);
    this.syncRuntimeState(session);
    this.state.startupState = 'ready';
    return shouldReplayHistory;
  }

  private async finishStartup(shouldReplayHistory: boolean): Promise<void> {
    if (this.startupNotice !== undefined) {
      this.showStatus(this.startupNotice);
      this.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    if (this.state.startupState === 'picker') {
      void this.bootstrapFromPicker();
      return;
    }
    if (shouldReplayHistory) await this.sessionReplay.hydrateFromReplay(this.requireSession());
    if (this.session !== undefined) {
      this.sessionEventHandler.startSubscription();
      this.updateTerminalTitle();
      await this.refreshSkillCommands(this.session);
      await this.refreshSessionCommands(this.session);
      if (this.session.status.state === 'interrupted') {
        this.showNotice(
          'This session is interrupted.',
          'A run paused for an answer nobody was there to give. Use /continue to answer it and resume.',
        );
      }
    }
    void this.fetchSessions();
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, 'warning');
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    this.streamingUI.discardPending();
    // Stop polling, streaming intervals and per-component timers before tearing the UI down, so
    // none of them can keep firing requestRender after stop() returns.
    this.tasksBrowserController.close();
    this.stopActivitySpinner();
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetToolUi();
    this.disposeTranscriptChildren();
    this.editorKeyboard.dispose();
    this.state.footer.dispose();
    for (const dispose of this.reverseRpcDisposers) dispose();
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    // Restore the terminal even if closing the session or the harness throws: a SIGTERM during an
    // MCP shutdown must not leave the user in raw mode with a hidden cursor.
    try {
      await this.closeSession('shutting down');
      this.clearQueuedMessages();
      this.imageStore.clear();
      await this.harness.close();
    } finally {
      this.sessionEventHandler.stopAllMcpServerStatusSpinners();
      this.sessionEventHandler.clearStepRetryAttemptTimer();
      try {
        await this.state.terminal.drainInput();
      } catch {
        // best effort — the terminal may already be dead (SIGHUP / EIO).
      }
      try {
        this.stopUiForExit();
      } catch {
        // best effort terminal restore.
      }
    }
    if (this.onExit) await this.onExit(exitCode);
  }

  // SIGHUP / dead-terminal EIO → emergencyTerminalExit (no cleanup, avoids an EIO write loop that
  // can pin a core). SIGTERM → normal stop().
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();
    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') signals.push('SIGHUP');

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          this.emergencyTerminalExit();
          return;
        }
        // Registering a SIGTERM listener disables Node's default exit(143), so reinstate it.
        this.stop(143).then(
          () => {
            process.exit(143);
          },
          () => {
            this.emergencyTerminalExit(143);
          },
        );
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => {
        process.off(signal, handler);
      });
    }

    const terminalErrorHandler = (error: Error): void => {
      if (isDeadTerminalError(error)) this.emergencyTerminalExit();
    };
    process.stdout.on('error', terminalErrorHandler);
    process.stderr.on('error', terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off('error', terminalErrorHandler);
    });
  }

  private unregisterSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  // Exit codes follow POSIX 128+signum: 129 = SIGHUP, 143 = SIGTERM.
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    restoreTerminalModes();
    process.exit(exitCode);
  }

  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.clipboardImageHintController?.stop();
    this.clipboardImageHintController = undefined;
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  private buildLayout(): void {
    const { ui } = this.state;
    // Fullscreen mounts its own layout root in createTUIState; its root children stay empty.
    if (ui instanceof TuiAltScreen) return;
    ui.clear();
    ui.addChild(this.state.transcriptContainer);
    ui.addChild(this.state.activityContainer);
    ui.addChild(this.state.todoPanelContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.editorContainer);
    // The footer is mounted later (mountFooter), not here.
  }

  /**
   * The footer is the only chrome with content before a session is ready, so mounting it at
   * construction lets a stray pre-start render leak it to the terminal. Mount it once init()
   * succeeds. FooterComponent is not a Container, so wrap it for the same outer gutter.
   */
  private mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    const dock = this.state.dockContainer;
    if (dock !== undefined) {
      dock.addChild(footerWrap, { shrink: 1, minSize: 1 });
      return;
    }
    this.state.ui.addChild(footerWrap);
  }

  /**
   * Fullscreen exit: leave the alternate screen with the frame preserved, then replay the
   * transcript through a main-screen renderer so native scrollback ends up with the inline layout
   * a regular session would have produced.
   */
  private stopUiForExit(): void {
    const ui = this.state.ui;
    if (!(ui instanceof TuiAltScreen)) {
      ui.stop();
      return;
    }
    ui.stop({ preserveScreen: true });
    const main = new TuiMainScreen(ui.terminal);
    main.addChild(this.state.transcriptContainer);
    main.addChild(this.state.activityContainer);
    main.addChild(this.state.todoPanelContainer);
    main.addChild(this.state.queueContainer);
    main.addChild(this.state.editorContainer);
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    main.addChild(footerWrap);
    // A main-screen renderer's first paint writes every line sequentially, landing the whole
    // transcript in native scrollback.
    main.renderNow();
    main.stop();
  }

  // =========================================================================
  // Input dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void handlePlanCommand(this, next ? 'on' : 'off');
  }

  handleInputModeChange(mode: 'prompt' | 'bash'): void {
    this.setAppState({ inputMode: mode });
    this.updateEditorBorderHighlight();
  }

  handleUserInput(text: string): void {
    const wasBashMode = this.state.appState.inputMode === 'bash';
    if (wasBashMode) {
      // A submit always exits bash mode (the `!` is consumed by this command).
      this.state.editor.inputMode = 'prompt';
      this.handleInputModeChange('prompt');
    }
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError('Cannot send input while session history is replaying.');
      return;
    }
    // Shell commands are stored with a leading `!` so ↑ recall can tell them apart from prompts
    // and restore bash mode; the `!` is stripped again when the entry is recalled.
    void this.persistInputHistory(wasBashMode ? `!${text}` : text);
    if (wasBashMode) {
      // Only one foreground action at a time: queue while another command or a turn is running.
      if (this.state.appState.streamingPhase !== 'idle') {
        this.enqueueMessage(text, undefined, 'bash');
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
      void this.runShellCommandFromInput(text);
      return;
    }
    dispatchInput(this, text);
  }

  /**
   * A `!` command runs on the session's environment — the same place the agent's Bash tool runs, so
   * `!` and the agent see one filesystem and one shell. It is echoed locally and not journaled:
   * the user ran it, not the model.
   */
  private async runShellCommandFromInput(command: string): Promise<void> {
    const session = this.session ?? (await this.ensureSession());
    if (session === undefined) return;
    if (this.state.appState.streamingPhase !== 'idle') {
      this.enqueueMessage(command, undefined, 'bash');
      this.updateQueueDisplay();
      this.state.ui.requestRender();
      return;
    }

    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: currentTheme.fg('shellMode', `$ ${command}`),
      bullet: '',
    });

    const commandId = nextTranscriptId();
    const outputEntry: TranscriptEntry = { id: commandId, kind: 'status', turnId: undefined, renderMode: 'plain', content: '' };
    const outputComponent = new ShellRunComponent(() => this.state.ui.requestRender());
    // Inherit the current ctrl+o state, same as a freshly mounted tool call.
    if (this.state.toolOutputExpanded) outputComponent.setExpanded(true);
    const abort = new AbortController();
    this.shellOutputStreams.set(commandId, { entry: outputEntry, component: outputComponent, abort });
    this.state.transcriptEntries.push(outputEntry);
    markTranscriptComponent(outputComponent, outputEntry);
    this.state.transcriptContainer.addChild(outputComponent);
    // Treat the command as a streaming phase so input queues and the activity spinner shows.
    this.setAppState({ streamingPhase: 'shell' });
    this.state.ui.requestRender();

    try {
      // Same invocation shape the Bash tool uses: the environment's own shell, the session's cwd.
      const environment = session.environment;
      const result = await environment.run([environment.osInfo.shellPath, '-c', command], {
        cwd: this.state.appState.workDir,
        signal: abort.signal,
        onOutput: (chunk) => {
          outputComponent.append(chunk.data);
        },
      });
      this.finishShellOutput(commandId, result.stdout, result.stderr, result.exitCode !== 0);
    } catch (error) {
      const message = formatErrorMessage(error);
      this.finishShellOutput(commandId, '', message, true);
    }
  }

  cancelRunningShellCommand(): void {
    for (const stream of this.shellOutputStreams.values()) stream.abort.abort();
  }

  private finishShellOutput(commandId: string, stdout: string, stderr: string, isError: boolean): void {
    const stream = this.shellOutputStreams.get(commandId);
    if (stream === undefined) return;
    stream.component.finish(stdout, stderr, isError);
    // Keep the entry's text in sync for whatever reads it (export, copy); the component renders.
    stream.entry.content = formatBashOutputForDisplay(stdout, stderr, isError);
    this.shellOutputStreams.delete(commandId);
    if (this.shellOutputStreams.size === 0) {
      this.setAppState({ streamingPhase: 'idle' });
      this.drainOneQueuedMessage();
    }
  }

  private drainOneQueuedMessage(): void {
    const session = this.session;
    if (session === undefined) return;
    const item = this.shiftQueuedMessage();
    if (item === undefined) return;
    if (item.mode === 'bash') void this.runShellCommandFromInput(item.text);
    else this.sendQueuedMessage(session, item);
    this.updateQueueDisplay();
  }

  async sendNormalUserInput(text: string, preExtracted?: ExtractionResult): Promise<void> {
    if (this.state.appState.model.trim().length === 0) {
      this.showError(NO_MODEL_MESSAGE);
      return;
    }
    const extraction = preExtracted ?? extractMediaAttachments(text, this.imageStore);
    if (!this.validateMediaCapabilities(extraction)) return;
    const session = this.session ?? (await this.ensureSession());
    if (session === undefined) return;
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  async sendInlineSkillUserInput(text: string, activations: readonly InlineSkillActivation[]): Promise<void> {
    if (this.state.appState.model.trim().length === 0) {
      this.showError(NO_MODEL_MESSAGE);
      return;
    }
    const extraction = extractMediaAttachments(text, this.imageStore);
    if (!this.validateMediaCapabilities(extraction)) return;
    const session = this.session ?? (await this.ensureSession());
    if (session === undefined) return;
    if (this.deferUserMessages || this.state.appState.streamingPhase !== 'idle' || this.state.appState.isCompacting) {
      this.enqueueMessage(text, {
        ...(extraction.hasMedia ? { parts: extraction.parts, imageAttachmentIds: extraction.imageAttachmentIds } : {}),
        inlineSkillActivations: activations,
      });
      this.updateQueueDisplay();
      this.state.ui.requestRender();
      return;
    }
    this.beginSessionRequest();
    void this.runInlineSkillActivations(session, text, activations, extraction).catch((error: unknown) => {
      this.failSessionRequest(`Skill activation failed: ${formatErrorMessage(error)}`);
    });
  }

  /**
   * Activate every named skill, then send the prompt. Each activation steers a skill block into
   * the session; the prompt that follows runs the turn that sees them all.
   */
  private async runInlineSkillActivations(
    session: HarnessSession,
    text: string,
    activations: readonly InlineSkillActivation[],
    extraction: ExtractionResult,
  ): Promise<void> {
    const knownEntryIds = new Set(this.state.transcriptEntries.map((entry) => entry.id));
    for (const activation of activations) {
      await session.skills.activateSkill({ name: activation.skillName, args: activation.args ?? '' });
    }
    // The cards appended during the activations belong to this submission.
    for (const entry of this.state.transcriptEntries) {
      if (entry.kind === 'skill_activation' && !knownEntryIds.has(entry.id)) entry.bundledWithPrompt = true;
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: text,
      ...(extraction.imageAttachmentIds.length > 0 ? { imageAttachmentIds: extraction.imageAttachmentIds } : {}),
    });
    await session.prompt(this.promptInput(text, extraction));
  }

  validateMediaCapabilities(extraction: { hasMedia: boolean; imageAttachmentIds: readonly number[] }): boolean {
    if (!extraction.hasMedia) return true;
    if (extraction.imageAttachmentIds.length > 0 && !this.supportsImageInput()) {
      this.showError('The active model does not accept image input.');
      return false;
    }
    return true;
  }

  private supportsImageInput(): boolean {
    return this.state.appState.availableModels[this.state.appState.model]?.imageInput ?? true;
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const entries = await loadInputHistory(getInputHistoryFile(this.state.appState.workDir));
      for (const entry of entries) this.state.editor.addToHistory(entry.content);
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed === this.lastHistoryContent) return;
    this.state.editor.addToHistory(trimmed);
    try {
      const written = await appendInputHistory(getInputHistoryFile(this.state.appState.workDir), trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  recallLastQueued(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const last = this.state.queuedMessages.at(-1)!;
    this.state.queuedMessages = this.state.queuedMessages.slice(0, -1);
    return last;
  }

  // =========================================================================
  // Session requests / queue
  // =========================================================================

  private enqueueMessage(
    text: string,
    options?: SendMessageOptions & { readonly inlineSkillActivations?: readonly InlineSkillActivation[] },
    mode?: 'prompt' | 'bash',
  ): void {
    this.state.queuedMessages.push({
      text,
      ...(options?.parts !== undefined ? { parts: options.parts } : {}),
      ...(options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? { imageAttachmentIds: options.imageAttachmentIds }
        : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(options?.inlineSkillActivations !== undefined ? { inlineSkillActivations: options.inlineSkillActivations } : {}),
    });
  }

  beginSessionRequest(): void {
    this.streamingUI.setTurnId(undefined);
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.streamingUI.resetToolCallState();
    this.patchLivePane({ mode: 'waiting', pendingApproval: null, pendingQuestion: null });
    this.setAppState({ streamingPhase: 'waiting', streamingStartTime: Date.now() });
  }

  failSessionRequest(message: string): void {
    this.setAppState({ streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  sendQueuedMessage(session: HarnessSession, item: QueuedMessage): void {
    if (item.mode === 'bash') {
      void this.runShellCommandFromInput(item.text);
      return;
    }
    if (item.mode === 'skill' && item.skillName !== undefined) {
      // sendSkillActivation re-checks the busy state, so a premature drain re-queues at the tail.
      this.sendSkillActivation(session, item.skillName, item.skillArgs ?? '');
      return;
    }
    if (item.inlineSkillActivations !== undefined && item.inlineSkillActivations.length > 0) {
      this.beginSessionRequest();
      void this.runInlineSkillActivations(session, item.text, item.inlineSkillActivations, {
        parts: item.parts ?? [{ type: 'text', text: item.text }],
        imageAttachmentIds: item.imageAttachmentIds ?? [],
        hasMedia: item.parts !== undefined && item.parts.length > 1,
      }).catch((error: unknown) => {
        this.failSessionRequest(`Skill activation failed: ${formatErrorMessage(error)}`);
      });
      return;
    }
    this.sendMessageInternal(session, item.text, {
      ...(item.parts !== undefined ? { parts: item.parts, hasMedia: true } : {}),
      ...(item.imageAttachmentIds !== undefined ? { imageAttachmentIds: item.imageAttachmentIds } : {}),
    });
  }

  /** What `session.prompt`/`steer` receives: plain text, or the parts a pasted image produced. */
  private promptInput(text: string, extraction: { hasMedia: boolean; parts: readonly PromptPart[] }): string | Message[] {
    if (!extraction.hasMedia) return text;
    return [
      {
        role: 'user',
        content: extraction.parts.map((part) =>
          part.type === 'text' ? { type: 'text' as const, text: part.text } : { type: 'image' as const, data: part.data, mimeType: part.mimeType },
        ),
        timestamp: Date.now(),
      },
    ];
  }

  private sendMessageInternal(session: HarnessSession, input: string, options?: SendMessageOptions): void {
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      ...(options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? { imageAttachmentIds: options.imageAttachmentIds }
        : {}),
    });
    this.beginSessionRequest();
    const payload = this.promptInput(input, {
      hasMedia: options?.hasMedia === true,
      parts: options?.parts ?? [{ type: 'text', text: input }],
    });
    // A goal-driven session holds its turn across the whole continuation loop, so a fresh prompt
    // would race the driver: steer instead, and the engine folds it into the running turn.
    if (this.state.appState.goal?.status === 'active') {
      session.steer(typeof payload === 'string' ? payload : input);
      return;
    }
    void session.prompt(payload).catch((error: unknown) => {
      this.failSessionRequest(`Failed to send: ${formatErrorMessage(error)}`);
    });
  }

  sendSkillActivation(session: HarnessSession, skillName: string, skillArgs: string): void {
    // Every skill behaves like plain input: queued by default, steered on demand. The engine
    // steers an activation into a running turn exactly like a steered user message.
    if (this.deferUserMessages || this.state.appState.isCompacting || this.state.appState.streamingPhase !== 'idle') {
      const args = skillArgs.trim();
      this.state.queuedMessages.push({
        text: `/${skillName}${args.length > 0 ? ` ${args}` : ''}`,
        mode: 'skill',
        skillName,
        skillArgs,
      });
      this.updateQueueDisplay();
      this.state.ui.requestRender();
      return;
    }
    this.beginSessionRequest();
    void session.skills.activateSkill({ name: skillName, args: skillArgs }).catch((error: unknown) => {
      this.failSessionRequest(`Skill "${skillName}" failed: ${formatErrorMessage(error)}`);
    });
  }

  /** Run one of the session's own slash commands and show what it reported. */
  /** The registry a model switch resolves against: built-ins plus every configured endpoint. */
  get models(): ModelRuntime {
    return this.modelRuntime;
  }

  runSessionCommand(session: HarnessSession, commandName: string, args: string): void {
    void session
      .runCommand(`/${commandName}${args.length > 0 ? ` ${args}` : ''}`)
      .then((result) => {
        if (result.message.length > 0) this.showStatus(result.message, result.ok ? 'success' : 'error');
      })
      .catch((error: unknown) => {
        this.showError(`/${commandName} failed: ${formatErrorMessage(error)}`);
      });
  }

  private sendMessage(session: HarnessSession, input: string, options?: SendMessageOptions): void {
    if (this.deferUserMessages || this.state.appState.streamingPhase !== 'idle' || this.state.appState.isCompacting) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  steerMessage(session: HarnessSession, input: readonly SteerInputItem[]): void {
    if (this.deferUserMessages || this.state.appState.isCompacting) {
      for (const item of input) this.enqueueMessage(item.text, item);
      return;
    }
    if (this.state.appState.streamingPhase === 'idle') {
      for (const item of input) this.sendMessageInternal(session, item.text, item);
      return;
    }
    for (const item of input) {
      this.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: item.text,
        ...(item.imageAttachmentIds !== undefined && item.imageAttachmentIds.length > 0
          ? { imageAttachmentIds: item.imageAttachmentIds }
          : {}),
      });
    }
    session.steer(combineSteerInput(input));
  }

  steerSkillActivation(session: HarnessSession, skillName: string, skillArgs: string): void {
    // Ctrl-S on a queued slash-skill item: the activation fires into the running turn. No
    // beginSessionRequest — the live pane belongs to that turn.
    void session.skills.activateSkill({ name: skillName, args: skillArgs }).catch((error: unknown) => {
      this.showError(`Skill "${skillName}" failed: ${formatErrorMessage(error)}`);
    });
  }

  // =========================================================================
  // State & accessors
  // =========================================================================

  setStartupReady(): void {
    this.state.startupState = 'ready';
  }

  clearQueuedMessages(): void {
    this.state.queuedMessages = [];
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const [first, ...rest] = this.state.queuedMessages;
    this.state.queuedMessages = rest;
    return first;
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  setExternalEditorRunning(running: boolean): void {
    this.state.externalEditorRunning = running;
  }

  setTasksBrowser(value: TUIState['tasksBrowser']): void {
    this.state.tasksBrowser = value;
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice = combineStartupNotice(this.startupNotice, extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.sessionEventHandler.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
  }

  /** `/goal cancel` is about to fire: read the next cleared snapshot as a cancel. */
  noteGoalCancelled(): void {
    this.sessionEventHandler.goalCancelPending = true;
  }

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.state.appState, patch)) return;
    const additionalDirsChanged =
      'additionalDirs' in patch && !sameStringArrays(this.state.appState.additionalDirs, patch.additionalDirs ?? []);
    const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
    Object.assign(this.state.appState, patch);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    if (busyChanged) this.updateQueueDisplay();
    if (additionalDirsChanged) this.setupAutocomplete();
    this.state.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  /** Persist a model pick so the next launch starts on it, unless `--model` overrides it. */
  async saveDefaultModel(id: string): Promise<void> {
    const onDisk = await loadTuiConfig().catch(() => this.currentTuiConfigSnapshot());
    await saveTuiConfig({ ...onDisk, defaultModel: id });
  }

  private currentTuiConfigSnapshot(): TuiConfig {
    const { appState } = this.state;
    return {
      theme: appState.theme,
      renderLatex: appState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex,
      disablePasteBurst: appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
      editorCommand: appState.editorCommand,
      notifications: appState.notifications,
      statusLine: appState.statusLine ?? DEFAULT_TUI_CONFIG.statusLine,
      defaultModel: appState.model,
    };
  }

  // =========================================================================
  // Session runtime
  // =========================================================================

  requireSession(): HarnessSession {
    if (this.session === undefined) throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    return this.session;
  }

  /**
   * Create the session on first use. Concurrent first-use triggers (a double Enter, or a slash
   * command right after a prompt) share the in-flight promise — otherwise two sessions would be
   * created and the later `setSession` would close the first one mid-dispatch.
   */
  async ensureSession(): Promise<HarnessSession | undefined> {
    if (this.ensureSessionPromise !== null) return this.ensureSessionPromise;
    if (this.session !== undefined) return this.session;
    this.ensureSessionPromise = this.lazyCreateSession().finally(() => {
      this.ensureSessionPromise = null;
    });
    return this.ensureSessionPromise;
  }

  async waitForLazyCreation(): Promise<void> {
    await this.ensureSessionPromise;
  }

  private async lazyCreateSession(): Promise<HarnessSession | undefined> {
    let session: HarnessSession;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      this.showError(`Failed to start a session: ${formatErrorMessage(error)}`);
      return undefined;
    }
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.applyStartupModesToSession(session);
    this.syncRuntimeState(session);
    this.sessionEventHandler.startSubscription();
    await this.refreshSkillCommands(session);
    await this.refreshSessionCommands(session);
    return session;
  }

  private async createSessionFromCurrentState(): Promise<HarnessSession> {
    const model = this.state.appState.model.trim();
    if (model.length === 0) throw new Error(NO_MODEL_MESSAGE);
    return this.harness.createSession({ workDir: this.state.appState.workDir });
  }

  /** Apply the startup model, thinking level and permission mode to a freshly opened session. */
  private async applyStartupModesToSession(session: HarnessSession): Promise<void> {
    const { appState } = this.state;
    const split = splitModelId(appState.model);
    if (split !== undefined) session.setModel(defineModel({ provider: split.provider, model: split.model }));
    session.setThinking(appState.thinkingLevel);
    await session.setPermissionMode(appState.permissionMode);
    if (appState.planMode) await session.plan.setEnabled(true);
  }

  async setSession(session: HarnessSession): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    this.session = session;
    this.registerSessionHandlers(session);
    this.setAppState({ sessionId: session.id });
  }

  /** Read back what the session actually holds, so the footer reflects the engine, not our guess. */
  syncRuntimeState(session: HarnessSession = this.requireSession()): void {
    const entry = this.state.appState.availableModels[this.state.appState.model];
    this.setAppState({
      sessionId: session.id,
      ...(entry !== undefined && entry.contextWindow > 0 ? { maxContextTokens: entry.contextWindow } : {}),
    });
    void this.refreshSessionTitle(session);
  }

  private async refreshSessionTitle(session: HarnessSession): Promise<void> {
    try {
      const summary = await this.harness.getSessionSummary(session.id);
      if (this.session !== session) return;
      this.setAppState({ sessionTitle: summary?.title ?? null });
      this.updateTerminalTitle();
    } catch {
      // Best-effort: the title is cosmetic.
    }
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
  }

  private unloadCurrentSession(reason: string): HarnessSession | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.setAppState({ goal: null });
    return previous;
  }

  private registerSessionHandlers(session: HarnessSession): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(this.approvalController, (request, response) => {
        this.appendApprovalTranscriptEntry(request, response);
      }),
    );
    session.setQuestionHandler(createQuestionAskHandler(this.questionController));
  }

  async fetchSessions(scope: 'cwd' | 'all' = this.state.sessionsScope): Promise<void> {
    this.state.loadingSessions = true;
    this.state.sessionsScope = scope;
    try {
      const sessions = await this.harness.listSessions(scope === 'all' ? {} : { workDir: this.state.appState.workDir });
      this.state.sessions = sessionRowsForPicker(sessions, this.state.appState.sessionId, this.hasSessionContent());
    } catch (error) {
      this.showError(`Failed to list sessions: ${formatErrorMessage(error)}`);
    } finally {
      this.state.loadingSessions = false;
    }
  }

  updateTerminalTitle(): void {
    const trimmed = this.state.appState.sessionTitle?.trim() ?? '';
    const label = trimmed.length > 0 ? trimmed.slice(0, MAX_TERMINAL_TITLE_LENGTH) : PRODUCT_NAME;
    this.state.terminal.setTitle(label);
  }

  resetSessionRuntime(): void {
    this.aborted = false;
    this.streamingUI.discardPending();
    this.clearQueuedMessages();
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.resetRuntimeState();
    this.tasksBrowserController.close();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  private async resumeSession(targetSessionId: string): Promise<boolean> {
    // A first-use lazy creation may still be in flight: wait it out so the checks below see
    // settled state — the pending prompt would otherwise replace the resumed session.
    await this.waitForLazyCreation();
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus('Already on this session.');
      return true;
    }
    if (this.state.appState.streamingPhase !== 'idle') {
      this.showError('Cannot switch sessions while streaming — press Esc or Ctrl-C first.');
      return false;
    }
    if (this.state.appState.isReplaying) {
      this.showError('Cannot switch sessions while history is replaying.');
      return false;
    }

    let session: HarnessSession;
    try {
      session = await this.harness.resumeSession(targetSessionId);
    } catch (error) {
      this.showError(`Failed to resume session ${targetSessionId}: ${formatErrorMessage(error)}`);
      return false;
    }
    await this.switchToSession(session, `Resumed session (${session.id}).`);
    return true;
  }

  async switchToSession(session: HarnessSession, statusMessage: string): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    this.syncRuntimeState(session);
    this.updateTerminalTitle();
    await this.refreshSkillCommands(session);
    await this.refreshSessionCommands(session);
    this.clearTranscriptAndRedraw();
    try {
      await this.sessionReplay.hydrateFromReplay(session);
    } finally {
      this.sessionEventHandler.startSubscription();
    }
    this.showStatus(statusMessage);
    if (session.status.state === 'interrupted') {
      this.showNotice('This session is interrupted.', 'Use /continue to answer the pending request and resume.');
    }
  }

  async createNewSession(): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError('Cannot start a new session while history is replaying.');
      return;
    }
    let session: HarnessSession;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      this.showError(`Failed to start a new session: ${formatErrorMessage(error)}`);
      return;
    }
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.applyStartupModesToSession(session);
    this.syncRuntimeState(session);
    this.sessionEventHandler.startSubscription();
    await this.refreshSkillCommands(session);
    await this.refreshSessionCommands(session);
    this.clearTranscriptAndRedraw();
    this.showStatus(`Started a new session (${session.id}).`);
  }
  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(this.state.ui, data.instruction);
      if (data.result === 'cancelled') {
        block.markCanceled();
      } else {
        block.markDone(data.tokensBefore, data.tokensAfter, data.summary);
        if (this.state.toolOutputExpanded) {
          block.setExpanded(true);
        }
      }
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((attachment): attachment is ImageAttachment => attachment !== undefined);
        return new UserMessageComponent(entry.content, images, entry.bullet);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          entry.skillTrigger,
        );
      case 'cron':
        return new CronMessageComponent(entry.content, entry.cronData ?? {});
      case 'goal':
        if (entry.goalData?.kind === 'created') {
          return new GoalSetMessageComponent();
        }
        if (entry.goalData?.kind === 'lifecycle') {
          return buildGoalMarker(entry.goalData.change, this.state.toolOutputExpanded);
        }
        return null;
      case 'assistant': {
        if (entry.content.trimStart().startsWith('✓ Goal complete')) {
          return new GoalCompletionMessageComponent(entry.content);
        }
        const component = new AssistantMessageComponent();
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, true);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.ui,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      markTranscriptComponent(component, entry);
      this.state.transcriptContainer.addChild(component);
    }
    const trimmed = this.trimTranscriptWindow();
    const merged = this.mergeCurrentTurnSteps();
    if (component || trimmed || merged) {
      this.state.ui.requestRender();
    }
  }

  private renderWelcome(): void {
    if (
      this.state.transcriptContainer.children.some((child) => child instanceof WelcomeComponent)
    ) {
      return;
    }
    const welcome = new WelcomeComponent(this.state.appState);
    this.state.transcriptContainer.addChild(welcome);
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.state.terminal.write(deleteAllKittyImages());
  }

  private disposeTranscriptChildren(): void {
    // Dispose disposable children (e.g. ShellRunComponent's 1s timer,
    // ThinkingComponent's spinner) before dropping them, so a /clear, session
    // switch, or shutdown can't leak intervals that keep firing requestRender
    // on a removed component.
    for (const child of this.state.transcriptContainer.children) {
      if (hasDispose(child)) child.dispose();
    }
  }

  private clearTranscriptAndRedraw(): void {
    this.streamingUI.discardPending();
    this.state.transcriptEntries = [];
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.disposeTranscriptChildren();
    this.state.transcriptContainer.clear();
    this.clearTerminalInlineImages();
    this.state.todoPanel.clear();
    this.state.todoPanelContainer.clear();
    this.imageStore.clear();
    this.renderWelcome();
    // No forced full render on session reset: let the differential renderer
    // converge on its own (a mass change above the viewport still makes the
    // engine repaint everything, but nothing is forced destructively here).
    this.state.ui.requestRender();
  }

  private isTurnBoundaryComponent(child: Component): boolean {
    if (
      !(child instanceof UserMessageComponent) &&
      !(child instanceof SkillActivationComponent) &&
      !(child instanceof ReplayTurnBoundaryComponent)
    ) {
      return false;
    }
    const entry = getTranscriptComponentEntry(child);
    if (entry === undefined) return false;
    // Live user messages / slash activations have an undefined turnId; replayed
    // ones get a `replay:N` turnId. Both start a new turn. Steer messages carry
    // a defined non-replay turnId and are not boundaries.
    return entry.turnId === undefined || entry.turnId.startsWith('replay:');
  }

  /**
   * Fold-segment boundary: everything {@link isTurnBoundaryComponent} counts,
   * plus the cron card. A cron-fired turn mounts no user message, so without
   * the card as a boundary its output would share the previous user turn's
   * fold segment — and the completed-turn assistant cap would fold that turn's
   * final answer into the step summary.
   */
  private isFoldSegmentBoundaryComponent(child: Component): boolean {
    return this.isTurnBoundaryComponent(child) || child instanceof CronMessageComponent;
  }

  private trimTranscriptWindow(): boolean {
    if (!TRANSCRIPT_WINDOW_ENABLED || TRANSCRIPT_MAX_TURNS <= 0) return false;
    // HarnessSession replay already caps history to its own turn limit; trimming during
    // replay would shrink it further and fight that limit.
    if (this.state.appState.isReplaying) return false;

    const children = this.state.transcriptContainer.children;

    // Trim whole turns by *position* in the child list rather than by entry
    // lookup — otherwise only the (registered) user message would be removed and
    // the rest of the turn would be left behind.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }

    const turns = groupTurns(this.state.transcriptEntries);

    const toRemove = turnsToTrim(turns, TRANSCRIPT_MAX_TURNS, TRANSCRIPT_HYSTERESIS);
    if (toRemove.size === 0) return false;

    // Reclaim image bytes referenced by trimmed user messages. The transcript
    // renders historical thumbnails via imageStore.get(id), so an attachment can
    // only be dropped once its owning user message leaves the transcript.
    for (const entry of toRemove) {
      if (entry.kind === 'user' && entry.imageAttachmentIds !== undefined) {
        this.imageStore.removeMany(entry.imageAttachmentIds);
      }
    }

    let boundariesToRemove = 0;
    for (const entry of toRemove) {
      if (
        (entry.kind === 'user' || entry.kind === 'skill_activation') &&
        entry.turnId === undefined
      ) {
        boundariesToRemove++;
      }
    }
    if (boundariesToRemove === 0) {
      this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !toRemove.has(e));
      return true;
    }

    let boundariesSeen = 0;
    let cutoff = 0;
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) {
        if (boundariesSeen === boundariesToRemove) {
          cutoff = i;
          break;
        }
        boundariesSeen++;
      }
    }

    const componentsToRemove: Component[] = [];
    for (let i = 0; i < cutoff; i++) {
      const child = children[i]!;
      if (child instanceof WelcomeComponent) continue;
      componentsToRemove.push(child);
    }
    for (const child of componentsToRemove) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }

    this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !toRemove.has(e));
    return true;
  }

  mergeCurrentTurnSteps(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT,
    );
  }

  /**
   * Fold the just-finished turn's assistant messages down to the completed-turn
   * cap: while a turn is live it may keep TRANSCRIPT_KEEP_RECENT_ASSISTANT
   * messages mounted, but once it ends only the conclusion-bearing tail stays.
   * Called when a turn finishes; the finished turn is still the current one at
   * that point (no newer boundary exists yet).
   */
  mergeCompletedTurnAssistants(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
    );
  }

  private foldCurrentTurnContent(keepSteps: number, keepAssistants: number): boolean {
    if (keepSteps <= 0 && keepAssistants <= 0) return false;
    const children = this.state.transcriptContainer.children;

    // Find the start of the current fold segment.
    let turnStart = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      if (this.isFoldSegmentBoundaryComponent(children[i]!)) {
        turnStart = i;
        break;
      }
    }
    if (turnStart < 0) return false;

    // Locate an existing summary, the assistant messages, and the mergeable steps.
    let summaryIndex = -1;
    const stepIndices: number[] = [];
    const assistantIndices: number[] = [];
    for (let i = turnStart + 1; i < children.length; i++) {
      const child = children[i]!;
      if (child instanceof StepSummaryComponent) {
        summaryIndex = i;
        continue;
      }
      if (child instanceof AssistantMessageComponent) {
        assistantIndices.push(i);
        continue;
      }
      stepIndices.push(i);
    }

    // Fold the oldest steps / assistant messages beyond their respective caps;
    // the most recent ones stay mounted. Children are chronological, so the
    // oldest of each kind sit at the front of their index lists.
    const stepMergeCount = keepSteps > 0 ? Math.max(0, stepIndices.length - keepSteps) : 0;
    const assistantMergeCount =
      keepAssistants > 0 ? Math.max(0, assistantIndices.length - keepAssistants) : 0;
    if (stepMergeCount === 0 && assistantMergeCount === 0) return false;
    const toMergeIndices = [
      ...stepIndices.slice(0, stepMergeCount),
      ...assistantIndices.slice(0, assistantMergeCount),
    ];

    let thinkingCount = 0;
    let toolCount = 0;
    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (child instanceof ThinkingComponent) thinkingCount++;
      else if (child instanceof ToolCallComponent) toolCount++;
    }
    if (thinkingCount === 0 && toolCount === 0 && assistantMergeCount === 0) return false;

    let summary: StepSummaryComponent;
    if (summaryIndex >= 0) {
      summary = children[summaryIndex] as StepSummaryComponent;
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    } else {
      summary = new StepSummaryComponent();
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    }

    // Rebuild children: keep everything except the merged steps, with the summary
    // sitting right after the user message.
    const toMergeSet = new Set(toMergeIndices);
    const newChildren: Component[] = [];
    for (let i = 0; i <= turnStart; i++) newChildren.push(children[i]!);
    newChildren.push(summary);
    for (let i = turnStart + 1; i < children.length; i++) {
      if (i === summaryIndex) continue;
      if (toMergeSet.has(i)) continue;
      newChildren.push(children[i]!);
    }

    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (hasDispose(child)) child.dispose();
    }

    children.splice(0, children.length, ...newChildren);
    return true;
  }

  mergeAllTurnSteps(): void {
    if (TRANSCRIPT_KEEP_RECENT_STEPS <= 0 && TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED <= 0)
      return;
    const children = this.state.transcriptContainer.children;

    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isFoldSegmentBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    if (boundaries.length === 0) return;

    const newChildren: Component[] = [];
    const toDispose: Component[] = [];
    for (let i = 0; i < boundaries[0]!; i++) newChildren.push(children[i]!);

    for (let t = 0; t < boundaries.length; t++) {
      const turnStart = boundaries[t]!;
      const turnEnd = t + 1 < boundaries.length ? boundaries[t + 1]! : children.length;
      newChildren.push(children[turnStart]!);

      let summaryIndex = -1;
      const stepIndices: number[] = [];
      const assistantIndices: number[] = [];
      for (let i = turnStart + 1; i < turnEnd; i++) {
        const child = children[i]!;
        if (child instanceof StepSummaryComponent) summaryIndex = i;
        else if (child instanceof AssistantMessageComponent) assistantIndices.push(i);
        else stepIndices.push(i);
      }

      const stepMergeCount =
        TRANSCRIPT_KEEP_RECENT_STEPS > 0
          ? Math.max(0, stepIndices.length - TRANSCRIPT_KEEP_RECENT_STEPS)
          : 0;
      // Replayed turns are all completed turns, so the stricter completed-turn
      // assistant cap applies (matching what live turns fold to on turn end).
      const assistantMergeCount =
        TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED > 0
          ? Math.max(0, assistantIndices.length - TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED)
          : 0;
      if (stepMergeCount > 0 || assistantMergeCount > 0) {
        const toMergeIndices = [
          ...stepIndices.slice(0, stepMergeCount),
          ...assistantIndices.slice(0, assistantMergeCount),
        ];
        let thinkingCount = 0;
        let toolCount = 0;
        for (const idx of toMergeIndices) {
          const child = children[idx]!;
          if (child instanceof ThinkingComponent) thinkingCount++;
          else if (child instanceof ToolCallComponent) toolCount++;
        }
        let summary: StepSummaryComponent;
        if (summaryIndex >= 0) {
          summary = children[summaryIndex] as StepSummaryComponent;
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        } else {
          summary = new StepSummaryComponent();
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        }
        newChildren.push(summary);
        for (const idx of toMergeIndices) toDispose.push(children[idx]!);
        const toMergeSet = new Set(toMergeIndices);
        for (let i = turnStart + 1; i < turnEnd; i++) {
          if (i === summaryIndex) continue;
          if (toMergeSet.has(i)) continue;
          newChildren.push(children[i]!);
        }
      } else {
        for (let i = turnStart + 1; i < turnEnd; i++) newChildren.push(children[i]!);
      }
    }

    for (const child of toDispose) {
      if (hasDispose(child)) child.dispose();
    }
    children.splice(0, children.length, ...newChildren);
  }
  showStatus(message: string, color?: ColorToken): void {
    this.state.transcriptContainer.addChild(new StatusMessageComponent(message, color));
    this.state.ui.requestRender();
  }

  showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(new NoticeMessageComponent(title, detail));
    this.state.ui.requestRender();
  }

  showError(message: string): void {
    this.showStatus(`Error: ${message}`, 'error');
  }

  showProgressSpinner(label: string): ProgressSpinnerHandle {
    const tint = (s: string): string => currentTheme.fg('primary', s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }: { ok: boolean; label: string }) => {
        spinner.stop();
        const tone = ok ? 'success' : 'error';
        const symbol = ok ? '✓' : '✗';
        spinner.setText(currentTheme.fg(tone, `${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
      setLabel: (nextLabel: string) => {
        spinner.setLabel(nextLabel);
      },
    };
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    const tipKind = loadingTipKind(effectiveMode);
    // Pick a fresh loading tip when the loading kind changes. The same kind
    // covers waiting/tool (both moon spinners) and any intermediate thinking
    // phase, so a continuous burst of tool calls does not flip tips. Clear the
    // cache only when there is no loading UI at all.
    if (effectiveMode === 'idle' || effectiveMode === 'session' || effectiveMode === 'hidden') {
      this.currentLoadingTip = undefined;
    } else if (
      tipKind !== undefined &&
      (this.currentLoadingTip === undefined || this.currentLoadingTip.kind !== tipKind)
    ) {
      const previousTip = this.currentLoadingTip?.tip;
      this.currentLoadingTip = {
        kind: tipKind,
        tip: pickRandomWorkingTip(previousTip)?.text,
      };
    }
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    // Carry the retry state in the mode key so an incoming/cleared
    // `turn.step.retrying` rebuilds the waiting pane with fresh label and
    // detail instead of hitting the cached-pane early return below.
    const retry = effectiveMode === 'waiting' ? this.state.appState.stepRetry : null;
    const retryKey =
      retry === null ? '' : `${formatStepRetryLabel(retry)}|${formatStepRetryDetail(retry)}`;
    const activityModeKey = `${effectiveMode}:${retryKey}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === 'waiting' || effectiveMode === 'thinking' || effectiveMode === 'tool')
    ) {
      return;
    }

    this.lastActivityMode = activityModeKey;
    this.state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.state.ui.requestRender();
        return;
      case 'waiting': {
        const stepRetry = this.state.appState.stepRetry;
        const spinner = this.ensureActivitySpinner('moon', waitingSpinnerLabel(stepRetry));
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            spinner,
            tip: stepRetry === null ? this.currentLoadingTip?.tip : undefined,
            detail: stepRetry === null ? undefined : formatStepRetryDetail(stepRetry),
          }),
        );
        break;
      }
      case 'thinking': {
        this.stopActivitySpinner();
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', 'working…', (s) =>
          currentTheme.fg('primary', s),
        );
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'tool': {
        const spinner = this.ensureActivitySpinner('moon');
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        // Keep a placeholder row so the activity area does not fully shrink
        // when the spinner is removed at the end of streaming; combined with
        // pi-tui's clamp, this avoids a destructive full redraw (viewport jump).
        this.state.activityContainer.addChild(new Spacer(1));
        break;
      }
    }
    this.state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (this.state.activeDialog === 'session-picker') return 'hidden';
    if (this.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.state.appState.isCompacting) return 'hidden';
    if (this.state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = this.state.appState.streamingPhase;

    // A running `!` shell command shows the moon spinner (same as `waiting`)
    // until it finishes, signalling that input is busy / queued.
    if (streamingPhase === 'shell') return 'waiting';

    if (this.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.state.livePane.mode;
  }

  updateQueueDisplay(): void {
    this.state.queueContainer.clear();
    const queued = this.state.queuedMessages;
    if (queued.length === 0) return;

    this.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        isCompacting: this.state.appState.isCompacting,
        isStreaming: this.state.appState.streamingPhase !== 'idle',
        canSteerImmediately: !this.deferUserMessages,
      }),
    );
  }

  /**
   * Index of the first transcript child ctrl+o may expand: a component is
   * expandable only if it sits at or after the start of the
   * (totalTurns - expandTurns)-th turn, i.e. it belongs to one of the most
   * recent `expandTurns` turns. Position-based so it also covers streaming
   * components that have no entry in the metadata map.
   */
  private expandCutoff(children: readonly Component[]): number {
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    return expandCutoffIndex(children.length, boundaries, TRANSCRIPT_EXPAND_TURNS);
  }

  /**
   * What the footer's ctrl+o hint should offer: `expand` while a card in the
   * expandable window keeps content out of its collapsed form, `collapse`
   * once the toggle shows it, `null` when ctrl+o would change nothing.
   */
  private toolOutputExpandHint(): 'expand' | 'collapse' | null {
    const children = this.state.transcriptContainer.children;
    if (this.state.toolOutputExpanded) {
      // Toggling off collapses every expanded card, including one that slid
      // out of the expansion window since it was expanded, so any expanded
      // card with hidden content keeps the collapse hint on.
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (isExpandedComponent(child) && hasHiddenContent(child)) return 'collapse';
      }
      return null;
    }
    const cutoff = this.expandCutoff(children);
    for (let i = children.length - 1; i >= cutoff; i--) {
      if (hasHiddenContent(children[i])) return 'expand';
    }
    return null;
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    const children = this.state.transcriptContainer.children;
    const expandCutoff = this.expandCutoff(children);

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!isExpandable(child)) continue;
      child.setExpanded(this.state.toolOutputExpanded && i >= expandCutoff);
    }
    // Differential render only — no destructive full redraw on expand/collapse.
    // (When the expanded region reaches above the viewport, the engine's own
    // fallback may still do a full render; that path is not forced from here.)
    this.state.ui.requestRender();
  }

  toggleTodoPanelExpansion(): void {
    this.state.todoPanel.toggleExpanded();
    this.state.ui.requestRender();
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const isBash = this.state.appState.inputMode === 'bash';
    const highlighted = this.state.appState.planMode || isBash || trimmed.startsWith('/');
    this.state.editor.borderHighlighted = highlighted;
    // Shell mode gets its own hue; plan-mode and slash context stay primary.
    const borderToken = isBash ? 'shellMode' : highlighted ? 'primary' : 'border';
    this.state.editor.borderColor = (s: string) => currentTheme.fg(borderToken, s);
    this.state.ui.requestRender();
  }

  async applyTheme(themeName: ThemeName, resolved?: ResolvedTheme): Promise<void> {
    const palette = await getColorPalette(themeName === 'auto' ? (resolved ?? 'dark') : themeName);
    currentTheme.setPalette(palette);
    this.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
    // Force every historical message to re-render so Markdown/Text caches
    // (which hold old ANSI colour codes) are cleared.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (!isBuiltInTheme(this.state.appState.theme) || this.state.appState.theme !== 'auto') return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(this.state, (resolved) => {
      void this.applyResolvedAutoTheme(resolved);
    });
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.state.appState.theme !== 'auto') return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette);
    this.updateEditorBorderHighlight();
    // Repaint already-rendered transcript entries (status/markdown caches hold
    // old ANSI codes), matching applyTheme()'s behaviour.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private syncTerminalProgress(active: boolean): void {
    if (!this.state.terminalState.supportsProgress) return;
    if (this.state.terminalState.progressActive === active) return;
    this.state.terminal.setProgress(active);
    this.state.terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.state.activitySpinner === null) {
      const instance = new MoonLoader(this.state.ui, style, colorFn, label);
      this.state.activitySpinner = { instance, style };
      return instance;
    }

    this.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.state.activitySpinner !== null) {
      this.state.activitySpinner.instance.stop();
      this.state.activitySpinner = null;
    }
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  mountEditorReplacement(panel: Component & Focusable): void {
    this.state.editorReplacementMounted = true;
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(panel);
    this.state.ui.setFocus(panel);
    this.state.ui.requestRender();
  }

  restoreEditor(): void {
    this.state.editorReplacementMounted = false;
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    // Differential render only: closing a tall panel leaves the editor a few
    // rows above the bottom (blank tail) until the next append, but avoids a
    // destructive full redraw on every dialog close.
    this.state.ui.requestRender();
  }

  /** Hand a rejected or un-runnable submission back to the editor instead of losing it. */
  restoreInputText(text: string): void {
    this.restoreEditor();
    this.state.editor.setText(text);
    this.updateEditorBorderHighlight(text);
    this.state.ui.requestRender();
  }

  // =========================================================================
  // Background-task detaching
  // =========================================================================

  /**
   * Ctrl-B: move the running foreground work to the background. A `!` shell command is cancelled
   * outright (it is ours, not the engine's); a detachable tool call goes through
   * `session.detachTool`, which is what the engine's detachable window is for.
   */
  async detachCurrentForegroundTask(): Promise<void> {
    if (this.shellOutputStreams.size > 0) {
      this.cancelRunningShellCommand();
      this.showDetachHint('Shell command cancelled.');
      return;
    }
    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }
    const targets = pickDetachableToolCalls(this.streamingUI.activeToolCalls());
    if (targets.length === 0) {
      this.showDetachHint('Nothing running can be moved to the background yet.');
      return;
    }
    let detached = 0;
    for (const target of targets) {
      if (session.background?.detach(target.id) === true) detached += 1;
    }
    this.showDetachHint(
      detached === 0
        ? 'That call is no longer detachable.'
        : `Moved ${detached === 1 ? '1 call' : `${String(detached)} calls`} to the background. /tasks to view.`,
    );
  }

  /** Show a one-shot footer hint that auto-clears after DETACH_HINT_DISPLAY_MS. */
  private showDetachHint(hint: string): void {
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
    this.state.footer.setTransientHint(hint);
    this.detachHintClearTimer = setTimeout(() => {
      this.detachHintClearTimer = undefined;
      // Do not clobber a newer transient hint that took over while this timer was pending.
      if (this.state.footer.getTransientHint() !== hint) return;
      this.state.footer.setTransientHint(null);
      this.state.ui.requestRender();
    }, DETACH_HINT_DISPLAY_MS);
    this.state.ui.requestRender();
  }

  /**
   * Live pre-send warning while a typed `/goal` objective exceeds the length limit, so the user
   * can trim it before submitting instead of losing the input to a rejection.
   */
  updateGoalLengthWarning(text: string | undefined): void {
    const warning = text === undefined ? undefined : goalObjectiveLengthWarning(text);
    this.state.footer.setWarningHint(warning ?? null);
    this.state.ui.requestRender();
  }

  // =========================================================================
  // Dialogs
  // =========================================================================

  showHelpPanel(): void {
    this.state.activeDialog = 'help';
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: this.getSlashCommands(),
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  private hideHelpPanel(): void {
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private sessionPickerOptions: { readonly closeOnCancel: boolean; readonly forwardEditorExit: boolean } = {
    closeOnCancel: false,
    forwardEditorExit: false,
  };
  private sessionPickerScopeRequestToken = 0;
  private sessionPickerComponent: SessionPickerComponent | undefined;

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({ closeOnCancel: false, forwardEditorExit: false });
  }

  /** `--session` with no id: the picker IS the startup screen, so cancelling it exits. */
  private async bootstrapFromPicker(): Promise<void> {
    await this.openSessionPicker({ closeOnCancel: true, forwardEditorExit: true });
  }

  private async openSessionPicker(options: { readonly closeOnCancel: boolean; readonly forwardEditorExit: boolean }): Promise<void> {
    this.sessionPickerOptions = options;
    await this.fetchSessions('cwd');
    this.remountSessionPicker();
  }

  private async toggleSessionPickerScope(selectedSessionId: string): Promise<void> {
    const requestToken = ++this.sessionPickerScopeRequestToken;
    await this.fetchSessions(this.state.sessionsScope === 'cwd' ? 'all' : 'cwd');
    if (requestToken !== this.sessionPickerScopeRequestToken) return;
    if (this.state.activeDialog !== 'session-picker') return;
    this.remountSessionPicker(selectedSessionId);
  }

  private remountSessionPicker(initialSelectedSessionId?: string): void {
    this.mountSessionPicker({
      ...(initialSelectedSessionId !== undefined ? { initialSelectedSessionId } : {}),
      onCancel: () => {
        this.hideSessionPicker();
        if (this.sessionPickerOptions.closeOnCancel) void this.stop();
      },
      ...(this.sessionPickerOptions.forwardEditorExit
        ? {
            onCtrlC: () => {
              this.state.editor.onCtrlC?.();
            },
            onCtrlD: () => {
              this.state.editor.onCtrlD?.();
            },
          }
        : {}),
    });
  }

  hideSessionPicker(): void {
    this.sessionPickerScopeRequestToken += 1;
    this.sessionPickerComponent = undefined;
    this.editorKeyboard.clearPendingExit();
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private async deleteSessionFromPicker(session: SessionRow): Promise<void> {
    // Invalidate any pending scope-toggle remount: it would replace the picker mid-delete.
    this.sessionPickerScopeRequestToken += 1;
    try {
      await this.waitForLazyCreation();
      const isCurrent = session.id === this.state.appState.sessionId && this.session !== undefined;
      if (isCurrent) {
        // Tear down before deleting so no events from the dying session reach the UI.
        await this.closeSession('deleting session');
      }
      await this.harness.deleteSession(session.id);
      this.state.sessions = this.state.sessions.filter((row) => row.id !== session.id);
      if (isCurrent) {
        this.setAppState({ sessionId: '' });
        this.clearTranscriptAndRedraw();
        await this.createNewSession();
        this.hideSessionPicker();
        return;
      }
      const requestToken = ++this.sessionPickerScopeRequestToken;
      await this.fetchSessions(this.state.sessionsScope);
      if (requestToken !== this.sessionPickerScopeRequestToken) return;
      if (this.state.activeDialog !== 'session-picker') return;
      this.remountSessionPicker();
      this.showStatus('Session deleted.');
    } catch (error) {
      this.showError(`Failed to delete session ${session.id}: ${formatErrorMessage(error)}`);
      this.hideSessionPicker();
    }
  }

  private mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
  }): void {
    this.state.activeDialog = 'session-picker';
    const picker = new SessionPickerComponent({
      sessions: this.state.sessions,
      loading: this.state.loadingSessions,
      currentSessionId: this.state.appState.sessionId,
      scope: this.state.sessionsScope,
      ...(options.initialSelectedSessionId !== undefined ? { initialSelectedSessionId: options.initialSelectedSessionId } : {}),
      pageSize: SESSION_LIST_PAGE_SIZE,
      onSelect: (session: SessionRow) => this.handleSessionPickerSelect(session),
      onCancel: options.onCancel,
      ...(options.onCtrlC !== undefined ? { onCtrlC: options.onCtrlC } : {}),
      ...(options.onCtrlD !== undefined ? { onCtrlD: options.onCtrlD } : {}),
      onToggleScope: (selectedSessionId: string) => {
        void this.toggleSessionPickerScope(selectedSessionId);
      },
      onDeleteRequest: (session: SessionRow) => this.deleteSessionFromPicker(session),
    });
    this.sessionPickerComponent = picker;
    this.mountEditorReplacement(picker);
  }

  private async handleSessionPickerSelect(session: SessionRow): Promise<void> {
    // Invalidate any pending scope-toggle remount: it would drop the selection lock.
    this.sessionPickerScopeRequestToken += 1;
    if (resolve(session.work_dir) !== resolve(this.state.appState.workDir)) {
      this.hideSessionPicker();
      const command = `cd ${quoteShellArg(session.work_dir)} && operon-tui --session ${quoteShellArg(session.id)}`;
      try {
        await copyTextToClipboard(command);
        this.showStatus(`That session lives in another directory.\n  To resume it: ${command}\n  (copied to the clipboard)`, 'warning');
      } catch {
        this.showStatus(`That session lives in another directory.\n  To resume it: ${command}`, 'warning');
      }
      if (this.sessionPickerOptions.closeOnCancel) await this.stop(0);
      return;
    }
    const switched = await this.resumeSession(session.id);
    if (!switched) return;
    this.hideSessionPicker();
    if (this.state.startupState !== 'ready') this.setStartupReady();
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: `${PRODUCT_NAME}: approval required`,
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.approvalController.respond(adaptPanelResponse(response));
      },
      () => {
        this.toggleToolOutputExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  private hideApprovalPanel(): void {
    // Fold the full-screen preview back first so the saved-children stack stays consistent.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    this.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  /**
   * Mount the full-screen approval preview on top of the panel. `beginScreenTakeover` swaps the
   * viewer in and closing restores what was there; the panel instance is kept so its selection
   * and feedback state survive.
   */
  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    const takeover = beginScreenTakeover(this.state.ui, viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, takeover, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    endScreenTakeover(this.state.ui, preview.takeover);
    this.state.ui.setFocus(preview.panel);
    this.state.ui.requestRender(true);
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: `${PRODUCT_NAME} needs your answer`,
      ...(payload.questions[0]?.question !== undefined ? { body: payload.questions[0].question } : {}),
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      6,
      () => {
        this.toggleToolOutputExpansion();
      },
    );
    this.mountEditorReplacement(dialog);
  }

  private hideQuestionDialog(): void {
    this.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }

  /** What the transcript records about an answered approval, so a resume shows the same line. */
  private appendApprovalTranscriptEntry(request: ApprovalRequest, response: ApprovalResponse): void {
    const display = request.display as { kind?: string } | undefined;
    if (request.toolName === 'ExitPlanMode' || display?.kind === 'plan_review' || display?.kind === 'goal_start') return;
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(response.scope === 'session' ? 'Approved for session' : 'Approved');
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
    }
    parts.push(`: ${request.approvalRule}`);
    if (response.feedback !== undefined && response.feedback.length > 0) parts.push(` — "${response.feedback}"`);
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: undefined,
      renderMode: 'notice',
      content: parts.join(''),
    });
  }
}
