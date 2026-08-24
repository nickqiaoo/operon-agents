import {
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { ToolResult } from "operon-agents";
import { jsonPreview, toolResultText } from "./format.ts";
import { markdownTheme, style } from "./theme.ts";

export class Gutter implements Component {
  readonly children: Component[] = [];

  constructor(private readonly left = 2, private readonly right = 1) {}

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component);
    if (index >= 0) this.children.splice(index, 1);
  }

  clear(): void {
    this.children.length = 0;
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - this.left - this.right);
    const prefix = " ".repeat(this.left);
    return this.children.flatMap((child) => child.render(innerWidth).map((line) => `${prefix}${line}`));
  }
}

export class UserMessageComponent implements Component {
  private readonly text: Text;

  constructor(value: string, private readonly label = "You") {
    this.text = new Text(value, 2, 0, (line) => style.accentStrong(line));
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    return [style.accent(`❯ ${this.label}`), ...this.text.render(width)];
  }
}

export class AssistantMessageComponent implements Component {
  private text = "";
  private thinking = "";
  private readonly markdown = new Markdown("", 0, 0, markdownTheme);
  private readonly thinkingText = new Text("", 2, 0);

  constructor(private readonly label = "Operon") {}

  appendText(delta: string): void {
    this.text += delta;
    this.markdown.setText(this.text);
  }

  setText(text: string): void {
    this.text = text;
    this.markdown.setText(text);
  }

  appendThinking(delta: string): void {
    this.thinking += delta;
    this.thinkingText.setText(style.muted(this.thinking));
  }

  setThinking(thinking: string): void {
    this.thinking = thinking;
    this.thinkingText.setText(style.muted(thinking));
  }

  get empty(): boolean {
    return this.text.length === 0 && this.thinking.length === 0;
  }

  invalidate(): void {
    this.markdown.invalidate();
    this.thinkingText.invalidate();
  }

  render(width: number): string[] {
    const lines = [style.accentStrong(`✦ ${this.label}`)];
    if (this.thinking.length > 0) {
      lines.push(style.muted("  Thinking"), ...this.thinkingText.render(width));
    }
    if (this.text.length > 0) lines.push(...this.markdown.render(width));
    return lines;
  }
}

export type ToolCallStatus = "running" | "done" | "error" | "suspended";

export class ToolCallComponent implements Component {
  private status: ToolCallStatus = "running";
  private progress = "";
  private output = "";
  private detachable = false;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly args: unknown,
    private readonly address = "main",
  ) {}

  setProgress(text: string): void {
    this.progress = text;
  }

  setDetachable(): void {
    this.detachable = true;
  }

  suspend(): void {
    this.status = "suspended";
  }

  complete(result: ToolResult, isError: boolean): void {
    this.status = isError ? "error" : "done";
    this.output = toolResultText(result);
  }

  invalidate(): void {
    // No cached render state.
  }

  render(width: number): string[] {
    const icon =
      this.status === "running" ? style.warning("●") :
      this.status === "done" ? style.success("✓") :
      this.status === "suspended" ? style.warning("Ⅱ") :
      style.error("✗");
    const scope = this.address === "main" ? "" : style.muted(` @${this.address}`);
    const title = `${icon} ${style.bold(this.name)}${scope}`;
    const detail = jsonPreview(this.args);
    const lines = [truncateToWidth(title, width), truncateToWidth(`  ${style.muted(detail)}`, width)];
    const progress = this.progress.trim();
    if (progress.length > 0 && this.status === "running") {
      lines.push(truncateToWidth(`  ${style.muted(progress)}`, width));
    }
    if (this.detachable && this.status === "running") {
      lines.push(truncateToWidth(`  ${style.muted("detachable · /background " + this.id)}`, width));
    }
    if (this.output.length > 0 && (this.status === "error" || this.output.length <= 240)) {
      const output = this.output.split("\n").slice(0, 4);
      for (const line of output) lines.push(truncateToWidth(`  ${style.muted("↳")} ${line}`, width));
    }
    return lines;
  }
}

export interface StatusLineState {
  model: string;
  sessionId: string;
  permission: string;
  state: string;
  queued: boolean;
}

export class StatusLineComponent implements Component {
  constructor(private readonly state: StatusLineState) {}

  patch(next: Partial<StatusLineState>): void {
    Object.assign(this.state, next);
  }

  invalidate(): void {
    // No cached render state.
  }

  render(width: number): string[] {
    const state = this.state.state === "idle" ? style.success(this.state.state) : style.warning(this.state.state);
    const queue = this.state.queued ? style.warning(" · queued") : "";
    const left = `${style.accent("operon")}  ${this.state.model} · ${this.state.permission} · ${state}${queue}`;
    const right = style.muted(this.state.sessionId);
    if (visibleWidth(left) + visibleWidth(right) + 2 <= width) {
      return [`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`];
    }
    return [truncateToWidth(`${left} · ${right}`, width)];
  }
}
