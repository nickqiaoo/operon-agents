import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  Loader,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
  matchesKey,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  defineModel,
  type AgentEvent,
  type ApprovalRequest,
  type ApprovalResponse,
  type Harness,
  type HarnessSession,
  type InterruptAnswer,
  type Message,
  type PendingRunInterrupt,
  type PermissionMode,
  type PromptOrigin,
  type QuestionRequest,
  type QuestionResult,
  type RunResult,
  type ThinkingLevel,
} from "operon-agents";
import {
  AssistantMessageComponent,
  Gutter,
  StatusLineComponent,
  ToolCallComponent,
  UserMessageComponent,
} from "./components.ts";
import {
  createApprovalDialog,
  createChoiceDialog,
  createQuestionDialog,
  createTextInputDialog,
  type DialogController,
} from "./dialogs.ts";
import { contentText, isQuestionDisplay, parseSlashCommand } from "./format.ts";
import { editorTheme, style } from "./theme.ts";

const SLASH_COMMANDS = [
  { name: "help", description: "Show commands and keyboard shortcuts" },
  { name: "new", description: "Create a new session" },
  { name: "sessions", description: "Open a persisted session" },
  { name: "resume", description: "Open a session by id", argumentHint: "<session-id>" },
  { name: "continue", description: "Answer and resume a durable interruption" },
  { name: "model", description: "Switch model", argumentHint: "<provider/model>" },
  { name: "thinking", description: "Set thinking level", argumentHint: "<minimal|low|medium|high|xhigh|max>" },
  { name: "permission", description: "Set permission mode", argumentHint: "<manual|workspace|auto|yolo>" },
  { name: "compact", description: "Request compaction", argumentHint: "[instruction]" },
  { name: "steer", description: "Steer the running turn", argumentHint: "<message>" },
  { name: "follow-up", description: "Queue a message for the next turn", argumentHint: "<message>" },
  { name: "background", description: "Move a detachable tool to background", argumentHint: "<tool-call-id>" },
  { name: "cancel", description: "Cancel the active run" },
  { name: "clear", description: "Clear the visible transcript" },
  { name: "status", description: "Show session status" },
  { name: "quit", description: "Exit the TUI" },
] as const;

const THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODES = new Set<PermissionMode>(["manual", "workspace", "auto", "yolo"]);

export interface OperonTuiOptions {
  readonly model: string;
  readonly permission: PermissionMode;
  readonly thinking?: ThinkingLevel;
}

export class OperonTui<TContext = unknown> {
  private readonly terminal = new ProcessTerminal();
  private readonly ui: TUI = new TuiMainScreen(this.terminal);
  private readonly transcript = new Gutter(2, 2);
  private readonly activity = new Gutter(2, 2);
  private readonly editorWrap = new Gutter(2, 2);
  private readonly footerWrap = new Gutter(2, 2);
  private readonly editor = new Editor(this.ui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
  private readonly loader = new Loader(this.ui, style.accent, style.muted, "Working");
  private readonly footer: StatusLineComponent;
  private readonly activeAssistant = new Map<string, AssistantMessageComponent>();
  private readonly toolCalls = new Map<string, ToolCallComponent>();
  private unsubscribe: (() => void) | undefined;
  private session: HarnessSession<TContext>;
  private model: string;
  private permission: PermissionMode;
  private thinking: ThinkingLevel | undefined;
  private stopped = false;
  private running = false;
  private exitCode = 0;
  private resolveExit!: (code: number) => void;
  private readonly exited = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });
  private modalTail: Promise<void> = Promise.resolve();
  private activeModalCancel: (() => void) | undefined;

  constructor(
    private readonly harness: Harness<TContext>,
    session: HarnessSession<TContext>,
    options: OperonTuiOptions,
  ) {
    this.session = session;
    this.model = options.model;
    this.permission = options.permission;
    this.thinking = options.thinking;
    this.footer = new StatusLineComponent({
      model: this.model,
      sessionId: session.id,
      permission: this.permission,
      state: session.status.state,
      queued: session.status.hasQueuedMessages,
    });
    this.buildLayout();
    this.configureEditor();
    this.attachSession(session);
  }

  async start(): Promise<number> {
    this.renderHistory();
    this.ui.setFocus(this.editor);
    this.installGlobalKeys();
    this.terminal.setTitle(`Operon · ${this.session.id}`);
    this.ui.start();
    this.ui.requestRender(true);
    if (this.session.status.state === "interrupted") {
      queueMicrotask(() => void this.continueInterrupted());
    }
    return this.exited;
  }

  stop(exitCode = 0): void {
    if (this.stopped) return;
    this.stopped = true;
    this.exitCode = exitCode;
    this.activeModalCancel?.();
    this.loader.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session.setApprovalHandler(undefined);
    this.session.setQuestionHandler(undefined);
    this.ui.stop();
    this.resolveExit(this.exitCode);
  }

  private buildLayout(): void {
    this.ui.clear();
    this.ui.addChild(this.transcript);
    this.ui.addChild(this.activity);
    this.editorWrap.addChild(this.editor);
    this.ui.addChild(this.editorWrap);
    this.footerWrap.addChild(this.footer);
    this.ui.addChild(this.footerWrap);
  }

  private configureEditor(): void {
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider([...SLASH_COMMANDS], this.session.workDir),
    );
    this.editor.onSubmit = (input) => {
      const text = input.trim();
      if (text.length === 0) return;
      this.editor.addToHistory(text);
      this.editor.setText("");
      void this.dispatchInput(text);
    };
  }

  private installGlobalKeys(): void {
    this.ui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        if (this.activeModalCancel !== undefined) {
          this.activeModalCancel();
        } else if (this.session.status.state === "running" || this.running) {
          this.session.cancel();
          this.showStatus("Cancelling the active run…", "warning");
        } else if (this.editor.getText().length > 0) {
          this.editor.setText("");
        } else {
          this.stop(0);
        }
        this.ui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("d")) && this.editor.getText().length === 0 && !this.running) {
        this.stop(0);
        return { consume: true };
      }
      return undefined;
    });
  }

  private attachSession(session: HarnessSession<TContext>): void {
    this.unsubscribe?.();
    this.session.setApprovalHandler(undefined);
    this.session.setQuestionHandler(undefined);
    this.session = session;
    session.setApprovalHandler((request, options) => this.askApproval(request, options?.signal));
    session.setQuestionHandler((request, options) => this.askQuestions(request, options?.signal));
    this.unsubscribe = session.onEvent((event) => this.handleEvent(event));
    this.footer.patch({
      sessionId: session.id,
      state: session.status.state,
      queued: session.status.hasQueuedMessages,
    });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...SLASH_COMMANDS], session.workDir));
    this.terminal.setTitle(`Operon · ${session.id}`);
  }

  private renderHistory(): void {
    this.transcript.clear();
    this.activeAssistant.clear();
    this.toolCalls.clear();
    this.appendTranscript(new Text(style.bold("Operon Agents")));
    this.appendTranscript(new Text(style.muted(`${this.session.workDir}\nType /help for commands. Enter submits; Shift+Enter inserts a line.`)));
    const root = this.session.snapshot({ addresses: ["main"], maxMessages: 300 }).agents[0];
    if (root === undefined) return;
    root.messages.forEach((message, index) => this.replayMessage(message, root.origins[index]));
    if (root.turn !== undefined) {
      const assistant = this.assistantFor("main");
      for (const part of root.turn.parts) {
        if (part.type === "text") assistant.appendText(part.text);
        else assistant.appendThinking(part.thinking);
      }
      assistant.appendText(root.turn.textTail);
      assistant.appendThinking(root.turn.thinkingTail);
      for (const call of root.turn.toolCalls) {
        const component = new ToolCallComponent(call.toolCallId, call.toolName, call.args);
        if (call.progress?.text) component.setProgress(call.progress.text);
        if (call.detachable) component.setDetachable();
        if (call.suspended !== undefined) component.suspend();
        this.toolCalls.set(toolKey("main", call.toolCallId), component);
        this.appendTranscript(component);
      }
    }
  }

  private replayMessage(message: Message, origin?: PromptOrigin): void {
    if (message.role === "user") {
      this.appendTranscript(new UserMessageComponent(contentText(message.content), originLabel(origin)));
      return;
    }
    if (message.role === "assistant") {
      const assistant = new AssistantMessageComponent();
      for (const part of message.content) {
        if (part.type === "text") assistant.appendText(part.text);
        else if (part.type === "thinking") assistant.appendThinking(part.thinking);
      }
      if (!assistant.empty) this.appendTranscript(assistant);
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const component = new ToolCallComponent(part.id, part.name, part.arguments);
        this.toolCalls.set(toolKey("main", part.id), component);
        this.appendTranscript(component);
      }
      return;
    }
    let component = this.toolCalls.get(toolKey("main", message.toolCallId));
    if (component === undefined) {
      component = new ToolCallComponent(message.toolCallId, message.toolName, {});
      this.toolCalls.set(toolKey("main", message.toolCallId), component);
      this.appendTranscript(component);
    }
    component.complete({ content: message.content, details: message.details, isError: message.isError }, message.isError);
  }

  private appendTranscript(component: Component): void {
    if (this.transcript.children.length > 0) this.transcript.addChild(new Spacer(1));
    this.transcript.addChild(component);
  }

  private assistantFor(address: string): AssistantMessageComponent {
    let component = this.activeAssistant.get(address);
    if (component !== undefined) return component;
    component = new AssistantMessageComponent(address === "main" ? "Operon" : address);
    this.activeAssistant.set(address, component);
    this.appendTranscript(component);
    return component;
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent.started":
        if (event.address !== "main") this.appendTranscript(new Text(style.muted(`↳ ${event.agent} started · ${event.address}`)));
        break;
      case "turn.started":
        if (event.address === "main") this.setBusy(true, "Thinking");
        break;
      case "turn.step.started":
        this.activeAssistant.delete(event.address);
        break;
      case "assistant.delta":
        this.assistantFor(event.address).appendText(event.delta);
        break;
      case "thinking.delta":
        this.assistantFor(event.address).appendThinking(event.delta);
        break;
      case "tool.call.started": {
        const component = new ToolCallComponent(event.toolCallId, event.toolName, event.args, event.address);
        this.toolCalls.set(toolKey(event.address, event.toolCallId), component);
        this.appendTranscript(component);
        this.setBusy(true, `Running ${event.toolName}`);
        break;
      }
      case "tool.progress": {
        const text = event.update.text ?? (event.update.percent === undefined ? event.update.kind : `${String(event.update.percent)}%`);
        this.toolCalls.get(toolKey(event.address, event.toolCallId))?.setProgress(text);
        break;
      }
      case "tool.detachable":
        this.toolCalls.get(toolKey(event.address, event.toolCallId))?.setDetachable();
        break;
      case "tool.suspended":
        this.toolCalls.get(toolKey(event.address, event.toolCallId))?.suspend();
        break;
      case "tool.result":
        this.toolCalls.get(toolKey(event.address, event.toolCallId))?.complete(event.result, event.isError);
        this.setBusy(true, "Thinking");
        break;
      case "turn.step.retrying":
        this.showStatus(`Retry ${String(event.attempt)}/${String(event.maxAttempts)} in ${String(event.delayMs)}ms${event.reason ? ` · ${event.reason}` : ""}`, "warning");
        break;
      case "turn.step.reset":
        this.discardActiveAssistant(event.address);
        this.showStatus(`Retrying step after a discarded attempt${event.reason ? ` · ${event.reason}` : ""}`, "warning");
        break;
      case "turn.paused":
        this.showStatus(`Run paused for ${String(event.pending.length)} response(s). Use /continue if no dialog appears.`, "warning");
        break;
      case "turn.ended":
        this.activeAssistant.delete(event.address);
        if (event.address === "main") this.setBusy(false);
        break;
      case "message.appended":
        if (event.message.role === "user" && shouldRenderInjectedMessage(event.origin)) {
          this.appendTranscript(new UserMessageComponent(contentText(event.message.content), originLabel(event.origin)));
        }
        break;
      case "steer.queued":
        this.footer.patch({ queued: true });
        break;
      case "compaction.started":
        this.setBusy(true, "Compacting context");
        break;
      case "history.replaced":
      case "history.compacted":
        this.renderHistory();
        break;
      case "compaction.completed":
        this.showStatus(`Compacted ${String(event.compactedCount)} messages · ${String(event.tokensBefore)} → ${String(event.tokensAfter)} tokens`, "success");
        break;
      case "background.task.started":
        this.showStatus("Background task started.", "muted");
        break;
      case "background.task.terminated":
        this.showStatus("Background task finished.", "muted");
        break;
      case "guardrail.blocked":
        this.discardActiveAssistant(event.address);
        this.showStatus(`Blocked by ${event.guardrail}: ${event.message}`, "error");
        break;
      case "warning":
        this.showStatus(event.message, "warning");
        break;
      case "error":
        this.showStatus(event.message, "error");
        break;
    }
    this.footer.patch({
      state: this.session.status.state,
      queued: this.session.status.hasQueuedMessages,
    });
    this.ui.requestRender();
  }

  private async dispatchInput(input: string): Promise<void> {
    const command = parseSlashCommand(input);
    if (command !== null) {
      await this.runCommand(command.name, command.args);
      return;
    }
    if (this.session.status.state === "interrupted") {
      this.showStatus("This session is interrupted. Use /continue before sending new work.", "warning");
      return;
    }
    this.appendTranscript(new UserMessageComponent(input));
    if (this.session.status.state === "running" || this.running) {
      this.session.steer(input);
      this.showStatus("Steered into the active turn. Use /follow-up to queue the next turn.", "muted");
      this.ui.requestRender();
      return;
    }
    await this.runPrompt(input);
  }

  private async runPrompt(input: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setBusy(true, "Thinking");
    try {
      const result = await this.session.prompt(input);
      this.handleResult(result);
    } catch (error) {
      this.showStatus(errorMessage(error), "error");
    } finally {
      this.running = false;
      this.setBusy(false);
    }
  }

  private handleResult(result: RunResult): void {
    if (result.status === "completed" || result.status === "skipped") return;
    if (result.status === "interrupted") {
      this.showStatus("Run interrupted durably. Use /continue to answer it.", "warning");
      return;
    }
    const render = result.status === "aborted" ? "Run cancelled." : `Run ended: ${result.status}`;
    this.showStatus(render, result.status === "aborted" ? "warning" : "error");
  }

  private async runCommand(name: string, args: string): Promise<void> {
    try {
      switch (name) {
        case "help":
          this.showHelp();
          break;
        case "clear":
          this.transcript.clear();
          this.appendTranscript(new Text(style.muted("Transcript cleared. Session history is unchanged.")));
          break;
        case "quit":
        case "exit":
          this.stop(0);
          return;
        case "cancel":
          this.session.cancel();
          this.showStatus("Cancellation requested.", "warning");
          break;
        case "status":
          this.showStatus(
            `${this.session.id} · ${this.session.status.state} · ${this.session.workDir} · model ${this.model} · permission ${this.permission}`,
            "muted",
          );
          break;
        case "steer":
          if (!args) throw new Error("Usage: /steer <message>");
          this.session.steer(args);
          this.appendTranscript(new UserMessageComponent(args, "Steer"));
          break;
        case "follow-up":
        case "followup":
          if (!args) throw new Error("Usage: /follow-up <message>");
          this.appendTranscript(new UserMessageComponent(args, "Follow-up"));
          if (this.session.followUp(args) === null) {
            await this.runPrompt(args);
          } else {
            this.showStatus("Queued for the next turn.", "muted");
          }
          break;
        case "background":
          if (!args) throw new Error("Usage: /background <tool-call-id>");
          this.showStatus(this.session.detachTool(args) ? "Moved tool to background." : "Tool is not detachable.", "muted");
          break;
        case "model":
          if (!args.includes("/")) throw new Error("Usage: /model <provider/model>");
          this.session.setModel(resolveModel(args));
          this.model = args;
          this.footer.patch({ model: args });
          this.showStatus(`Model switched to ${args}.`, "success");
          break;
        case "thinking": {
          if (!THINKING_LEVELS.has(args as ThinkingLevel)) {
            throw new Error("Usage: /thinking <minimal|low|medium|high|xhigh|max>");
          }
          const level = args as ThinkingLevel;
          this.session.setThinking(level);
          this.thinking = level;
          this.showStatus(`Thinking level: ${level}.`, "success");
          break;
        }
        case "permission": {
          if (!PERMISSION_MODES.has(args as PermissionMode)) {
            throw new Error("Usage: /permission <manual|workspace|auto|yolo>");
          }
          const mode = args as PermissionMode;
          await this.session.setPermissionMode(mode);
          this.permission = mode;
          this.footer.patch({ permission: mode });
          this.showStatus(`Permission mode: ${mode}.`, "success");
          break;
        }
        case "compact": {
          const pending = await this.session.compact(args ? { instruction: args } : {});
          this.showStatus(`Compaction ${pending.id} will run at the next step boundary.`, "muted");
          break;
        }
        case "continue":
          await this.continueInterrupted();
          break;
        case "new":
          await this.createNewSession();
          break;
        case "resume":
          if (!args) throw new Error("Usage: /resume <session-id>");
          await this.openSession(args);
          break;
        case "sessions":
          await this.pickSession();
          break;
        default:
          throw new Error(`Unknown command /${name}. Type /help.`);
      }
    } catch (error) {
      this.showStatus(errorMessage(error), "error");
    }
    this.ui.requestRender();
  }

  private showHelp(): void {
    const lines = [
      style.bold("Commands"),
      ...SLASH_COMMANDS.map((command) => `/${command.name}${"argumentHint" in command ? ` ${command.argumentHint}` : ""}  ${style.muted(command.description)}`),
      "",
      style.bold("Keys"),
      `Ctrl+C  ${style.muted("cancel dialog/run, clear input, then exit")}`,
      `Ctrl+D  ${style.muted("exit when input is empty")}`,
      `Shift+Enter  ${style.muted("insert newline")}`,
      `Enter  ${style.muted("submit; while running, steer the active turn")}`,
    ];
    this.appendTranscript(new Text(lines.join("\n")));
  }

  private async createNewSession(): Promise<void> {
    this.assertSessionSwitchable();
    const oldId = this.session.id;
    await this.harness.closeSession(oldId);
    const next = await this.harness.createSession({ workDir: this.session.workDir });
    next.setModel(resolveModel(this.model));
    if (this.thinking !== undefined) next.setThinking(this.thinking);
    await next.setPermissionMode(this.permission);
    this.attachSession(next);
    this.renderHistory();
    this.showStatus(`Created session ${next.id}.`, "success");
  }

  private async openSession(id: string): Promise<void> {
    if (id === this.session.id) return;
    this.assertSessionSwitchable();
    const oldId = this.session.id;
    const oldWorkDir = this.session.workDir;
    await this.harness.closeSession(oldId);
    try {
      const next = await this.harness.resumeSession(id);
      next.setModel(resolveModel(this.model));
      this.attachSession(next);
      this.renderHistory();
      this.showStatus(`Resumed session ${id}.`, "success");
      if (next.status.state === "interrupted") queueMicrotask(() => void this.continueInterrupted());
    } catch (error) {
      const fallback = await this.harness.resumeSession(oldId).catch(() => this.harness.createSession({ workDir: oldWorkDir }));
      fallback.setModel(resolveModel(this.model));
      this.attachSession(fallback);
      throw error;
    }
  }

  private async pickSession(): Promise<void> {
    this.assertSessionSwitchable();
    const sessions = (await this.harness.listSessions()).filter((item) => item.workDir === this.session.workDir);
    if (sessions.length === 0) {
      this.showStatus("No persisted sessions in this workspace.", "muted");
      return;
    }
    const choices: SelectItem[] = sessions.map((item) => ({
      value: item.id,
      label: item.id === this.session.id ? `${item.id} (current)` : item.id,
      description: `${new Date(item.updatedAt).toLocaleString()}${item.title ? ` · ${item.title}` : ""}`,
    }));
    const id = await this.showDialog(
      () => createChoiceDialog({
        title: "Sessions",
        choices,
        requestRender: () => this.ui.requestRender(),
        map: (choice) => choice.value,
        cancelValue: "",
      }),
      "",
    );
    if (id && id !== this.session.id) await this.openSession(id);
  }

  private assertSessionSwitchable(): void {
    if (this.running || this.session.status.state === "running") {
      throw new Error("Cancel or wait for the active run before switching sessions.");
    }
  }

  private async continueInterrupted(): Promise<void> {
    if (this.running) return;
    const pending = await this.session.pendingInterruptions();
    if (pending.length === 0) {
      this.showStatus("There is no durable interruption to resume.", "muted");
      return;
    }
    const answers: Record<string, ApprovalResponse | InterruptAnswer> = {};
    for (const item of pending) {
      const answer = await this.answerPending(item);
      answers[item.approvalId] = answer;
    }
    this.running = true;
    this.setBusy(true, "Resuming");
    try {
      const result = await this.session.resume(answers);
      this.handleResult(result);
    } finally {
      this.running = false;
      this.setBusy(false);
    }
  }

  private async answerPending(item: PendingRunInterrupt): Promise<InterruptAnswer> {
    if (item.kind === "approval") {
      const response = await this.askApproval({
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        approvalRule: item.approvalRule,
        display: item.display,
      });
      return { kind: "approval", ...response };
    }
    if (item.request.kind === "question" && isQuestionDisplay(item.request.display)) {
      const questions = item.request.display.questions;
      const result = await this.showDialog(
        () => createQuestionDialog(questions, () => this.ui.requestRender()),
        null,
      );
      return { kind: "input", data: result };
    }
    const value = await this.showDialog(
      () => createTextInputDialog({
        title: `${item.toolName} needs input`,
        detail: item.request.display === undefined ? item.request.kind : JSON.stringify(item.request.display),
        placeholder: "Type a response",
        requestRender: () => this.ui.requestRender(),
      }),
      null,
    );
    return { kind: "input", data: value };
  }

  private askApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResponse> {
    return this.showDialog(
      () => createApprovalDialog(request, () => this.ui.requestRender()),
      { decision: "cancelled" },
      signal,
    );
  }

  private askQuestions(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionResult> {
    return this.showDialog(
      () => createQuestionDialog(request.questions, () => this.ui.requestRender()),
      null,
      signal,
    );
  }

  private showDialog<T>(
    create: () => DialogController<T>,
    cancelled: T,
    signal?: AbortSignal,
  ): Promise<T> {
    const run = this.modalTail.then(async () => {
      if (this.stopped || signal?.aborted) return cancelled;
      const dialog = create();
      let handle: OverlayHandle | undefined;
      const cancel = (): void => dialog.cancel();
      const onAbort = (): void => cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.activeModalCancel = cancel;
      try {
        handle = this.ui.showOverlay(dialog.component, {
          width: "80%",
          minWidth: 42,
          maxHeight: "90%",
          anchor: "center",
          margin: 1,
        });
        this.ui.requestRender(true);
        return await dialog.result;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        handle?.hide();
        if (this.activeModalCancel === cancel) this.activeModalCancel = undefined;
        this.ui.setFocus(this.editor);
        this.ui.requestRender(true);
      }
    });
    this.modalTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private setBusy(busy: boolean, message = "Working"): void {
    this.running = busy;
    this.activity.clear();
    if (busy) {
      this.loader.setMessage(message);
      this.activity.addChild(this.loader);
      this.loader.start();
    } else {
      this.loader.stop();
    }
    this.footer.patch({ state: busy ? "running" : this.session.status.state === "interrupted" ? "interrupted" : "idle" });
    this.ui.requestRender();
  }

  private showStatus(message: string, tone: "success" | "warning" | "error" | "muted"): void {
    const render = tone === "success" ? style.success : tone === "warning" ? style.warning : tone === "error" ? style.error : style.muted;
    this.appendTranscript(new Text(render(message)));
    this.ui.requestRender();
  }

  private discardActiveAssistant(address: string): void {
    const component = this.activeAssistant.get(address);
    if (component === undefined) return;
    this.activeAssistant.delete(address);
    const index = this.transcript.children.indexOf(component);
    if (index < 0) return;
    this.transcript.children.splice(index, 1);
    if (this.transcript.children[index - 1] instanceof Spacer) this.transcript.children.splice(index - 1, 1);
    else if (this.transcript.children[index] instanceof Spacer) this.transcript.children.splice(index, 1);
    this.transcript.invalidate();
  }
}

function resolveModel(id: string) {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) throw new Error(`Model must be provider/model, got ${JSON.stringify(id)}.`);
  return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldRenderInjectedMessage(origin: PromptOrigin | undefined): boolean {
  return origin !== undefined && !["user", "user_follow_up", "injection", "compaction_summary", "handoff_seed"].includes(origin.kind);
}

function originLabel(origin: PromptOrigin | undefined): string {
  if (origin === undefined || origin.kind === "user") return "You";
  if (origin.kind === "user_follow_up") return "Follow-up";
  if (origin.kind === "background_task") return `Background ${origin.taskId}`;
  if (origin.kind === "extension") {
    // cron (now an extension) puts its jobId in the metadata; other extensions may not.
    const jobId = origin.metadata?.["jobId"];
    return jobId === undefined ? origin.extensionId : `${origin.extensionId} ${String(jobId)}`;
  }
  if (origin.kind === "cron_job") return `Cron ${origin.jobId}`;
  if (origin.kind === "cron_missed") return "Cron";
  if (origin.kind === "external") return origin.actor ?? origin.source;
  if (origin.kind === "injection") return "System";
  if (origin.kind === "compaction_summary") return "Summary";
  return `Handoff ${origin.fromAddress}`;
}

function toolKey(address: string, toolCallId: string): string {
  return `${address}\u0000${toolCallId}`;
}
