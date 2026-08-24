import {
  CURSOR_MARKER,
  Input,
  Key,
  SelectList,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type QuestionItem,
  type QuestionResult,
  type SelectItem,
} from "./pi-types.ts";
import type { ApprovalRequest, ApprovalResponse } from "operon-agents";
import { jsonPreview } from "./format.ts";
import { selectListTheme, style } from "./theme.ts";

export interface DialogController<T> {
  readonly component: Component;
  readonly result: Promise<T>;
  cancel(): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createApprovalDialog(
  request: ApprovalRequest,
  requestRender: () => void,
): DialogController<ApprovalResponse> {
  const choices: SelectItem[] = [
    { value: "once", label: "Allow once", description: "Approve only this tool call" },
    { value: "session", label: "Allow for session", description: "Approve this rule for the current session" },
    { value: "reject", label: "Reject", description: "Return a rejection to the agent" },
    { value: "cancel", label: "Cancel run", description: "Reject and ask the host to stop" },
  ];
  return createChoiceDialog<ApprovalResponse>({
    title: `Approve ${request.toolName}?`,
    detail: [request.approvalRule, request.display === undefined ? "" : jsonPreview(request.display, 320)]
      .filter(Boolean)
      .join("\n"),
    choices,
    requestRender,
    map: (choice) => {
      if (choice.value === "once") return { decision: "approved" };
      if (choice.value === "session") return { decision: "approved", scope: "session" };
      if (choice.value === "cancel") return { decision: "cancelled" };
      return { decision: "rejected", feedback: "Rejected in the terminal UI." };
    },
    cancelValue: { decision: "cancelled" },
  });
}

export function createChoiceDialog<T>(options: {
  readonly title: string;
  readonly detail?: string;
  readonly choices: SelectItem[];
  readonly requestRender: () => void;
  readonly map: (choice: SelectItem) => T;
  readonly cancelValue: T;
}): DialogController<T> {
  const wait = deferred<T>();
  let settled = false;
  const settle = (value: T): void => {
    if (settled) return;
    settled = true;
    wait.resolve(value);
  };
  const list = new SelectList(options.choices, Math.min(12, Math.max(4, options.choices.length)), selectListTheme);
  list.onSelect = (choice) => settle(options.map(choice));
  list.onCancel = () => settle(options.cancelValue);
  const component: Component = {
    invalidate: () => list.invalidate(),
    handleInput: (data) => {
      list.handleInput(data);
      options.requestRender();
    },
    render: (width) => {
      const inner = Math.max(1, width - 4);
      const lines = [style.bold(options.title)];
      if (options.detail) {
        for (const line of options.detail.split("\n")) lines.push(style.muted(truncateToWidth(line, inner)));
      }
      lines.push("", ...list.render(inner), "", style.muted("↑↓ move · enter select · esc cancel"));
      return panel(lines, width);
    },
  };
  return { component, result: wait.promise, cancel: () => settle(options.cancelValue) };
}

export function createTextInputDialog(options: {
  readonly title: string;
  readonly detail?: string;
  readonly placeholder?: string;
  readonly requestRender: () => void;
}): DialogController<string | null> {
  const wait = deferred<string | null>();
  const input = new Input();
  let settled = false;
  const settle = (value: string | null): void => {
    if (settled) return;
    settled = true;
    wait.resolve(value);
  };
  input.onSubmit = (value) => settle(value.trim().length > 0 ? value.trim() : null);
  input.onEscape = () => settle(null);
  const component: Component & Focusable = {
    focused: true,
    invalidate: () => input.invalidate(),
    handleInput: (data) => {
      input.handleInput(data);
      options.requestRender();
    },
    render: (width) => {
      input.focused = component.focused;
      const inner = Math.max(1, width - 4);
      const lines = [style.bold(options.title)];
      if (options.detail) lines.push(style.muted(truncateToWidth(options.detail, inner)));
      if (input.getValue().length === 0 && options.placeholder) {
        lines.push(style.muted(options.placeholder));
      }
      lines.push(...input.render(inner), "", style.muted("enter submit · esc cancel"));
      return panel(lines, width);
    },
  };
  return { component, result: wait.promise, cancel: () => settle(null) };
}

export function createQuestionDialog(
  questions: readonly QuestionItem[],
  requestRender: () => void,
): DialogController<QuestionResult> {
  const wait = deferred<QuestionResult>();
  const component = new QuestionDialogComponent(questions, requestRender, (result) => wait.resolve(result));
  return { component, result: wait.promise, cancel: () => component.cancel() };
}

class QuestionDialogComponent implements Component, Focusable {
  private index = 0;
  private cursor = 0;
  private readonly selected = new Set<number>();
  private readonly answers: Record<string, string | readonly string[]> = {};
  private readonly customInput = new Input();
  private customMode = false;
  private settled = false;
  private usedOptions = false;
  private usedFreeform = false;
  private _focused = true;

  constructor(
    private readonly questions: readonly QuestionItem[],
    private readonly requestRender: () => void,
    private readonly onDone: (result: QuestionResult) => void,
  ) {
    this.customInput.onSubmit = (value) => {
      const answer = value.trim();
      if (answer.length === 0) return;
      this.usedFreeform = true;
      this.record(answer);
    };
    this.customInput.onEscape = () => {
      this.customMode = false;
      this.customInput.setValue("");
      this.requestRender();
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.customInput.focused = value && this.customMode;
  }

  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.onDone(null);
  }

  invalidate(): void {
    this.customInput.invalidate();
  }

  handleInput(data: string): void {
    if (this.customMode) {
      this.customInput.handleInput(data);
      this.requestRender();
      return;
    }
    const question = this.questions[this.index];
    if (question === undefined) return;
    const optionCount = question.options.length + 1;
    if (matchesKey(data, Key.up)) this.cursor = (this.cursor - 1 + optionCount) % optionCount;
    else if (matchesKey(data, Key.down)) this.cursor = (this.cursor + 1) % optionCount;
    else if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    } else if (matchesKey(data, Key.space) && question.multiSelect && this.cursor < question.options.length) {
      if (this.selected.has(this.cursor)) this.selected.delete(this.cursor);
      else this.selected.add(this.cursor);
    } else if (matchesKey(data, Key.enter)) {
      if (this.cursor === question.options.length) {
        this.customMode = true;
        this.customInput.focused = this.focused;
      } else if (question.multiSelect) {
        this.selected.add(this.cursor);
        const labels = [...this.selected]
          .sort((a, b) => a - b)
          .map((index) => question.options[index]?.label)
          .filter((label): label is string => label !== undefined);
        if (labels.length > 0) {
          this.usedOptions = true;
          this.record(labels);
        }
      } else {
        const label = question.options[this.cursor]?.label;
        if (label !== undefined) {
          this.usedOptions = true;
          this.record(label);
        }
      }
    } else {
      const printable = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
      const number = printable === undefined ? Number.NaN : Number.parseInt(printable, 10);
      if (number >= 1 && number <= optionCount) this.cursor = number - 1;
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const question = this.questions[this.index];
    if (question === undefined) return panel([style.warning("No question to display.")], width);
    const inner = Math.max(1, width - 4);
    const lines = [
      style.bold(question.header || "Question"),
      style.muted(`${String(this.index + 1)} / ${String(this.questions.length)}`),
      "",
      truncateToWidth(question.question, inner),
      "",
    ];
    if (this.customMode) {
      this.customInput.focused = this.focused;
      lines.push(style.accent("Custom answer"), ...this.customInput.render(inner), "", style.muted("enter submit · esc back"));
      return panel(lines, width);
    }
    question.options.forEach((option, index) => {
      const active = index === this.cursor;
      const checked = question.multiSelect ? (this.selected.has(index) ? "[x]" : "[ ]") : `${String(index + 1)}.`;
      const prefix = active ? style.accent("›") : " ";
      const label = active ? style.bold(option.label) : option.label;
      lines.push(truncateToWidth(`${prefix} ${checked} ${label}`, inner));
      if (option.description) lines.push(truncateToWidth(`    ${style.muted(option.description)}`, inner));
    });
    const customIndex = question.options.length;
    lines.push(
      truncateToWidth(`${customIndex === this.cursor ? style.accent("›") : " "} ${String(customIndex + 1)}. Custom answer`, inner),
      "",
      style.muted(question.multiSelect ? "space toggle · enter confirm · esc dismiss" : "↑↓ move · enter select · esc dismiss"),
    );
    return panel(lines, width);
  }

  private record(value: string | readonly string[]): void {
    const question = this.questions[this.index];
    if (question === undefined) return;
    this.answers[question.question] = value;
    this.index += 1;
    this.cursor = 0;
    this.selected.clear();
    this.customMode = false;
    this.customInput.setValue("");
    if (this.index < this.questions.length) {
      this.requestRender();
      return;
    }
    this.settled = true;
    const method = this.usedOptions && this.usedFreeform ? "mixed" : this.usedFreeform ? "freeform" : "option";
    this.onDone({ answers: this.answers, method });
  }
}

function panel(lines: readonly string[], width: number): string[] {
  const inner = Math.max(1, width - 2);
  const top = style.border(`╭${"─".repeat(inner)}╮`);
  const bottom = style.border(`╰${"─".repeat(inner)}╯`);
  return [
    top,
    ...lines.map((line) => {
      const clipped = truncateToWidth(line, inner);
      const padding = Math.max(0, inner - visibleWidth(clipped.replaceAll(CURSOR_MARKER, "")));
      return `${style.border("│")}${clipped}${" ".repeat(padding)}${style.border("│")}`;
    }),
    bottom,
  ];
}
