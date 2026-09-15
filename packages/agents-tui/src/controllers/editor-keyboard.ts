import type { Harness, HarnessSession } from 'operon-agents';

import { ClipboardMediaError, readClipboardMedia } from '../app/utils/clipboard/clipboard-image.ts';
import { parseImageMeta } from '../app/utils/image/image-mime.ts';
import { editInExternalEditor, resolveEditorCommand } from '../app/utils/process/external-editor.ts';

import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  DOUBLE_ESC_WINDOW_MS,
  EXIT_CONFIRM_WINDOW_MS,
  NO_MODEL_MESSAGE,
} from '../constant/tui.ts';
import { Key, matchesKey } from 'operon-pi-tui';
import { formatErrorMessage } from '../utils/event-payload.ts';
import type { ImageAttachmentStore } from '../utils/image-attachment-store.ts';
import { extractMediaAttachments, imagePlaceholder } from '../utils/image-placeholder.ts';
import { extractInlineSkillActivations } from '../utils/inline-skill-tokens.ts';
import type { PendingExit, QueuedMessage, SteerInputItem } from '../types.ts';
import type { TUIState } from '../tui-state.ts';

/** An inline paste travels in the prompt itself, so one image and the pending set are both capped. */
const MAX_PASTED_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PASTED_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface EditorKeyboardHost {
  state: TUIState;
  session: HarnessSession | undefined;
  cancelInFlight: (() => void) | undefined;
  harness?: Harness | undefined;

  handleUserInput(text: string): void;
  readonly skillCommandMap: Map<string, string>;
  steerMessage(session: HarnessSession, input: readonly SteerInputItem[]): void;
  steerSkillActivation(session: HarnessSession, skillName: string, skillArgs: string): void;
  validateMediaCapabilities(extraction: { hasMedia: boolean; imageAttachmentIds: readonly number[] }): boolean;
  recallLastQueued(): QueuedMessage | undefined;
  showError(msg: string): void;
  updateEditorBorderHighlight(text?: string): void;
  /** `undefined` means the input cannot be a `/goal` command (clear without measuring). */
  updateGoalLengthWarning(text: string | undefined): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  toggleTodoPanelExpansion(): void;
  detachCurrentForegroundTask(): void;
  cancelRunningShellCommand(): void;
  hideSessionPicker(): void;
  stop(exitCode?: number): Promise<void>;
  ensureSession(): Promise<HarnessSession | undefined>;
  handlePlanToggle(next: boolean): void;
  handleInputModeChange(mode: 'prompt' | 'bash'): void;
  clearQueuedMessages(): void;
  setExternalEditorRunning(running: boolean): void;
  updateActivityPane(): void;
}

export class EditorKeyboardController {
  private pendingExit: PendingExit | null = null;
  private pendingUndoEsc: { readonly timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  install(): void {
    const { host } = this;
    const editor = host.state.editor;

    editor.onSubmit = (text: string) => {
      host.handleUserInput(text);
    };

    editor.onPreInput = (data: string) => {
      if (matchesKey(data, Key.escape)) this.clearPendingExit();
      return false;
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      host.updateEditorBorderHighlight(text);
      // Expanding paste markers costs a full-text pass, and only `/goal`
      // input can trip the objective length limit — so skip the expansion
      // for ordinary prompts. Submitted text is trimmed before dispatch, so
      // gate on the trimmed text too. A paste marker may itself expand into
      // part of the command (`[paste #…]` → `/goal …`, or completing a
      // partial prefix like `/go[paste #1 …]` → `/goal …`), so any input
      // containing a marker that can still become a `/goal` command must
      // pass the gate as well.
      const trimmed = text.trimStart();
      const mightBeGoal =
        trimmed.startsWith('/goal') ||
        trimmed.startsWith('[paste #') ||
        (trimmed.startsWith('/') && trimmed.includes('[paste #'));
      if (editor.inputMode !== 'bash' && mightBeGoal) {
        host.updateGoalLengthWarning(editor.getExpandedText());
      } else {
        host.updateGoalLengthWarning(undefined);
      }
    };

    // bash mode recalls only shell (`!`-prefixed) history entries; prompt mode
    // recalls everything. The filter is locked to the mode captured when the
    // user first enters history browsing (see onHistoryDraftSave), so landing on
    // a shell entry mid-browse doesn't switch the filter to shell-only.
    let browseMode: 'prompt' | 'bash' | null = null;
    editor.setHistoryFilter((entry: string) => {
      const mode = browseMode ?? editor.inputMode;
      return mode === 'bash' ? entry.startsWith('!') : true;
    });

    // Recalling a `!`-prefixed entry strips the marker and returns to bash
    // mode; recalling a plain entry returns to prompt mode. The filter above
    // guarantees bash mode only ever lands on `!` entries, so this never
    // misfires on commands typed in bash mode.
    editor.onRecall = (entry: string) => {
      if (entry.startsWith('!')) {
        editor.setInputMode('bash');
        return entry.slice(1);
      }
      editor.setInputMode('prompt');
      return undefined;
    };

    // Save/restore the input mode alongside pi-tui's history draft. Without
    // this, recalling a shell entry and then pressing Down back to an empty
    // draft would leave the editor stuck in bash mode, so the next typed
    // message would be submitted as a shell command. Also locks the history
    // filter (browseMode) for the duration of the browse session.
    editor.onHistoryDraftSave = () => {
      browseMode = editor.inputMode;
      return editor.inputMode;
    };
    editor.onHistoryDraftRestore = (state: unknown) => {
      editor.setInputMode(state as 'prompt' | 'bash');
      browseMode = null;
    };

    editor.onNonEscapeInput = () => {
      this.clearPendingUndoEsc();
    };

    editor.onCtrlC = () => {
      if (host.cancelInFlight !== undefined) {
        const cancel = host.cancelInFlight;
        host.cancelInFlight = undefined;
        this.clearPendingExit();
        cancel();
        return;
      }

      if (host.state.appState.isCompacting) {
        this.clearPendingExit();

        if (this.clearEditorTextIfPresent()) return;

        this.cancelCurrentCompaction();
        return;
      }

      if (host.state.appState.streamingPhase !== 'idle') {
        this.clearPendingExit();

        if (this.clearEditorTextIfPresent()) return;

        this.cancelCurrentStream();
        return;
      }

      if (this.pendingExit?.kind === 'ctrl-c') {
        this.clearPendingExit();
        void host.stop();
        return;
      }

      if (editor.getText().length > 0) {
        editor.setText('');
      }
      this.armPendingExit('ctrl-c', CTRL_C_HINT);
    };

    editor.onCtrlD = () => {
      if (this.pendingExit?.kind === 'ctrl-d') {
        this.clearPendingExit();
        void host.stop();
        return;
      }
      this.armPendingExit('ctrl-d', CTRL_D_HINT);
    };

    editor.onEscape = () => {
      if (this.pendingExit) this.clearPendingExit();
      if (host.state.activeDialog === 'session-picker') {
        host.hideSessionPicker();
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.appState.isCompacting) {
        this.cancelCurrentCompaction();
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.appState.streamingPhase !== 'idle') {
        this.cancelCurrentStream();
        this.clearPendingUndoEsc();
        return;
      }
      this.clearPendingUndoEsc();
    };

    editor.onShiftTab = () => {
      const togglePlan = (): void => {
        const next = !host.state.appState.planMode;
        host.handlePlanToggle(next);
      };
      if (host.session === undefined) {
        // v2 session-less: lazy-create the session, then toggle — the same
        // path /plan takes.
        void host.ensureSession().then((session) => {
          if (session !== undefined) togglePlan();
        });
        return;
      }
      togglePlan();
    };

    editor.onInputModeChange = (mode) => {
      host.handleInputModeChange(mode);
    };

    editor.onOpenExternalEditor = () => {
      void this.openExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      host.toggleToolOutputExpansion();
    };

    editor.onToggleTodoExpand = (): boolean => {
      if (!host.state.todoPanel.hasOverflow()) return false;
      // Disarm a pending double-press exit confirmation so expanding the
      // todo list in between two Ctrl-C presses does not accidentally exit.
      this.clearPendingExit();
      host.toggleTodoPanelExpansion();
      return true;
    };

    editor.onCtrlS = () => {
      if (
        host.state.appState.streamingPhase === 'idle' ||
        host.state.appState.streamingPhase === 'shell' ||
        host.state.appState.isCompacting
      )
        return;
      const text = editor.getText().trim();
      const editorIsBash = editor.inputMode === 'bash';

      // Bash commands (`! …`) are not steerable: they stay queued so they run
      // after the current task. Grouped inline-skill submissions are not
      // steerable either — steer carries no skill activations, so they stay
      // queued and submit intact when the session drains; the same applies to
      // an editor draft carrying inline skill tokens. Steering stops at the
      // first such bundle: items behind it stay queued too, or a later
      // message would jump ahead of its bundle and reverse the conversational
      // order. Everything else steers in queue order — plain text as a
      // steered message, slash-skill items as activations fired into the
      // running turn (never as literal text).
      const queued = host.state.queuedMessages;
      const firstBundle = queued.findIndex((m) => m.inlineSkillActivations !== undefined);
      const windowBeforeFirstBundle = firstBundle === -1 ? queued : queued.slice(0, firstBundle);
      const steerable = windowBeforeFirstBundle.filter((m) => m.mode !== 'bash');
      const editorHasInlineSkills =
        !editorIsBash &&
        text.length > 0 &&
        extractInlineSkillActivations(text, host.skillCommandMap).length > 0;

      type SteerRun =
        | { readonly kind: 'text'; readonly items: SteerInputItem[] }
        | { readonly kind: 'skill'; readonly skillName: string; readonly skillArgs: string };
      const runs: SteerRun[] = [];
      let textRun: SteerInputItem[] = [];
      const flushTextRun = (): void => {
        if (textRun.length > 0) {
          runs.push({ kind: 'text', items: textRun });
          textRun = [];
        }
      };
      for (const m of steerable) {
        if (m.mode === 'skill' && m.skillName !== undefined) {
          flushTextRun();
          runs.push({ kind: 'skill', skillName: m.skillName, skillArgs: m.skillArgs ?? '' });
          continue;
        }
        const trimmed = m.text.trim();
        if (trimmed.length > 0) {
          // Queued items carry the parts extracted when they were submitted
          // (and were already capability-validated then).
          textRun.push({
            text: trimmed,
            parts: m.parts,
            imageAttachmentIds: m.imageAttachmentIds,
          });
        }
      }
      let editorExtraction: ReturnType<typeof extractMediaAttachments> | undefined;
      if (!editorIsBash && text.length > 0 && !editorHasInlineSkills && firstBundle === -1) {
        try {
          // Synchronous path: an image still ingesting in the background
          // extracts to its inline fallback here (no bounded wait like
          // `sendNormalUserInput` — this handler cannot await without
          // interleaving queue/draft edits); a video still uploading refuses
          // the submission instead (no inline form exists).
          editorExtraction = extractMediaAttachments(text, this.imageStore);
        } catch (error) {
          // Media expansion failed (e.g. the pasted video's upload is still
          // in flight) — leave the queue and the editor draft untouched.
          host.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
          return;
        }
        textRun.push({
          text,
          parts: editorExtraction.hasMedia ? editorExtraction.parts : undefined,
          imageAttachmentIds:
            editorExtraction.imageAttachmentIds.length > 0
              ? editorExtraction.imageAttachmentIds
              : undefined,
        });
      }
      flushTextRun();

      if (runs.length > 0) {
        // The editor draft is fresh input: gate it on the model's media
        // capabilities before splicing the queue, so a rejection leaves the
        // queue and the draft untouched.
        if (editorExtraction !== undefined && !host.validateMediaCapabilities(editorExtraction)) {
          return;
        }
        const session = host.session;
        if (host.state.appState.model.trim().length === 0 || session === undefined) {
          host.showError(NO_MODEL_MESSAGE);
          return;
        }
        host.state.queuedMessages = queued.filter(
          (m, index) => m.mode === 'bash' || (firstBundle !== -1 && index >= firstBundle),
        );
        if (!editorIsBash && !editorHasInlineSkills && firstBundle === -1) editor.setText('');
        for (const run of runs) {
          if (run.kind === 'text') {
            host.steerMessage(session, run.items);
          } else {
            host.steerSkillActivation(session, run.skillName, run.skillArgs);
          }
        }
      }
      host.updateQueueDisplay();
      host.state.ui.requestRender();
    };

    editor.onCtrlB = (): boolean => {
      // Shell command execution is treated as a streaming phase ('shell'), so
      // this gate already covers it; only idle + not-compacting falls through.
      if (host.state.appState.streamingPhase === 'idle' || host.state.appState.isCompacting) {
        return false;
      }
      host.detachCurrentForegroundTask();
      return true;
    };

    editor.onUpArrowEmpty = () => {
      if (host.state.appState.streamingPhase === 'idle' && !host.state.appState.isCompacting) return false;
      const recalled = host.recallLastQueued();
      if (recalled !== undefined) {
        editor.setText(recalled.text);
        // Restore the queued item's mode so a recalled `!` command runs as a
        // shell command again instead of being submitted as a normal prompt.
        // Skill activations recall as prompt mode: their text is the original
        // `/name args` slash command, which re-parses on submit.
        const mode = recalled.mode === 'bash' ? 'bash' : 'prompt';
        if (editor.inputMode !== mode) {
          editor.inputMode = mode;
          editor.onInputModeChange?.(mode);
        }
        host.updateQueueDisplay();
        host.state.ui.requestRender();
        return true;
      }
      return false;
    };


    editor.onPasteImage = async () => this.handleClipboardImagePaste();
  }

  clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.host.state.footer.setTransientHint(null);
    this.pendingExit = null;
  }

  dispose(): void {
    this.clearPendingExit();
    this.clearPendingUndoEsc();
  }

  private armPendingUndoEsc(): void {
    this.clearPendingUndoEsc();
    const timer = setTimeout(() => {
      if (this.pendingUndoEsc?.timer === timer) {
        this.pendingUndoEsc = null;
      }
    }, DOUBLE_ESC_WINDOW_MS);
    this.pendingUndoEsc = { timer };
  }

  private clearPendingUndoEsc(): void {
    if (!this.pendingUndoEsc) return;
    clearTimeout(this.pendingUndoEsc.timer);
    this.pendingUndoEsc = null;
  }

  private armPendingExit(kind: 'ctrl-c' | 'ctrl-d', hint: string): void {
    this.clearPendingExit();
    this.host.state.footer.setTransientHint(hint);

    const timer = setTimeout(() => {
      if (this.pendingExit?.timer === timer) {
        this.clearPendingExit();
        this.host.state.ui.requestRender();
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    this.pendingExit = { kind, timer };
    this.host.state.ui.requestRender();
  }

  private clearEditorTextIfPresent(): boolean {
    const editor = this.host.state.editor;
    if (editor.getText().length === 0) return false;
    editor.setText('');
    return true;
  }

  private cancelCurrentStream(): void {
    // Cancel any running `!` shell command (treated as a streaming phase) in
    // addition to the agent turn, so Esc / Ctrl+C interrupts it too.
    this.host.cancelRunningShellCommand();
    void this.host.session?.cancel();
  }

  private cancelCurrentCompaction(): void {
    const session = this.host.session;
    if (session === undefined) return;
    void session.cancelCompaction().catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.showError(`Failed to cancel compaction: ${message}`);
    });
  }

  /**
   * Ctrl+V (Alt+V on Windows): read an image off the system clipboard, register it, and drop its
   * placeholder at the cursor. The bytes are sent inline as an `image` content part on submit, so
   * there is nothing to upload and nothing to wait for — but also no server-side resizing, hence
   * the hard size cap below.
   */
  private async handleClipboardImagePaste(): Promise<boolean> {
    let media;
    try {
      media = await readClipboardMedia();
    } catch (error) {
      if (error instanceof ClipboardMediaError) {
        this.host.showError(error.message);
        return true;
      }
      return false;
    }
    if (media === null) return false;
    if (media.kind !== 'image') {
      this.host.showError('Only images can be pasted; this clipboard holds something else.');
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;
    if (media.bytes.length > MAX_PASTED_IMAGE_BYTES) {
      this.host.showError(
        `That image is ${formatBytes(media.bytes.length)}; the limit for an inline paste is ${formatBytes(MAX_PASTED_IMAGE_BYTES)}. Save it and point the agent at the file instead.`,
      );
      return true;
    }
    if (this.imageStore.totalBytes() + media.bytes.length > MAX_PASTED_IMAGE_TOTAL_BYTES) {
      this.host.showError(`Too many images pending (limit ${formatBytes(MAX_PASTED_IMAGE_TOTAL_BYTES)}). Send what you have first.`);
      return true;
    }

    const attachment = this.imageStore.add({
      data: Buffer.from(media.bytes).toString('base64'),
      mimeType: meta.mime,
      width: meta.width,
      height: meta.height,
      bytes: media.bytes.length,
    });
    this.host.state.editor.insertTextAtCursor?.(`${imagePlaceholder(attachment.id, attachment.width, attachment.height)} `);
    this.host.state.ui.requestRender();
    return true;
  }

  private async openExternalEditor(): Promise<void> {
    const { state } = this.host;
    if (state.externalEditorRunning) return;
    const cmd = resolveEditorCommand(state.appState.editorCommand);
    if (cmd === undefined) {
      this.host.showError('No editor configured. Set $VISUAL / $EDITOR, or run /editor <command>.');
      return;
    }
    this.host.setExternalEditorRunning(true);
    const seed = state.editor.getExpandedText?.() ?? state.editor.getText();
    // Fullscreen: a plain stop() would replay the whole transcript into the
    // main screen on exit; the external editor only needs the alternate
    // screen released, so preserve the screen instead.
    state.ui.stop({ preserveScreen: state.ui.mode === 'fullscreen' ? true : undefined });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        state.editor.setText(result.replaceAll('\r\n', '\n').replace(/\n$/, ''));
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`External editor failed: ${msg}`);
    } finally {
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      state.ui.start();
      state.ui.setFocus(state.editor);
      state.ui.requestRender(true);
      // terminal.stop() cleared the OSC 9;4 progress indicator while the
      // app-side progressActive flag still reads true; resync so a turn that
      // was streaming while the editor was open gets its progress back.
      state.terminalState.progressActive = false;
      this.host.updateActivityPane();
      this.host.setExternalEditorRunning(false);
    }
  }
}

