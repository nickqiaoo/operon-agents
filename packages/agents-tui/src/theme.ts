import chalk from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const color = {
  accent: "#7AA2F7",
  accentStrong: "#BB9AF7",
  success: "#9ECE6A",
  warning: "#E0AF68",
  error: "#F7768E",
  muted: "#737DA0",
  border: "#565F89",
  text: "#C0CAF5",
  code: "#7DCFFF",
} as const;

export const style = {
  accent: (text: string): string => chalk.hex(color.accent)(text),
  accentStrong: (text: string): string => chalk.hex(color.accentStrong)(text),
  success: (text: string): string => chalk.hex(color.success)(text),
  warning: (text: string): string => chalk.hex(color.warning)(text),
  error: (text: string): string => chalk.hex(color.error)(text),
  muted: (text: string): string => chalk.hex(color.muted)(text),
  border: (text: string): string => chalk.hex(color.border)(text),
  text: (text: string): string => chalk.hex(color.text)(text),
  bold: (text: string): string => chalk.bold(text),
  inverse: (text: string): string => chalk.inverse(text),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: style.accent,
  selectedText: (text) => chalk.bold(chalk.hex(color.text)(text)),
  description: style.muted,
  scrollInfo: style.muted,
  noMatch: style.warning,
};

export const editorTheme: EditorTheme = {
  borderColor: style.border,
  selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(chalk.hex(color.accentStrong)(text)),
  link: (text) => chalk.underline(chalk.hex(color.accent)(text)),
  linkUrl: style.muted,
  code: (text) => chalk.hex(color.code)(text),
  codeBlock: (text) => chalk.hex(color.text)(text),
  codeBlockBorder: style.border,
  quote: style.muted,
  quoteBorder: style.border,
  hr: style.border,
  listBullet: style.accent,
  bold: chalk.bold,
  italic: chalk.italic,
  strikethrough: chalk.strikethrough,
  underline: chalk.underline,
};
