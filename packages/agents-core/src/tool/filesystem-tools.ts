import type { Tool } from "./types.ts";
import { bashTool } from "./builtin/bash.ts";
import { editTool } from "./builtin/edit.ts";
import { globTool } from "./builtin/glob.ts";
import { grepTool } from "./builtin/grep.ts";
import { readTool } from "./builtin/read.ts";
import { writeTool } from "./builtin/write.ts";

export interface FilesystemToolsOptions {
  /**
   * `"all"` (default): read/write/edit/glob/grep/bash.
   * `"readonly"`: drops the mutating + shell tools, leaving read/glob/grep.
   */
  readonly mode?: "all" | "readonly";
}

/**
 * The standard machine-backed builtin tools as a single array — convenience
 * sugar for assembling an agent's toolset (`tools: filesystemTools()`). It is
 * NOT a capability or a new mechanism: these are the same tools exported
 * individually from this package. Omit it entirely for a no-filesystem agent.
 */
export function filesystemTools(options: FilesystemToolsOptions = {}): Tool[] {
  const readers: Tool[] = [readTool, globTool, grepTool];
  if (options.mode === "readonly") return readers;
  return [...readers, writeTool, editTool, bashTool];
}
