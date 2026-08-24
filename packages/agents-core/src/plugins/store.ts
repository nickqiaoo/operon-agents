import path from "node:path";
import type { Machine } from "../index.ts";
import type { PluginCapabilityState, PluginGithubMetadata, PluginSource } from "./types.ts";
import { readTextFile, writeTextFile } from "../tool/support/machine-ops.ts";

export interface InstalledRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly originalSource?: string;
  readonly capabilities?: PluginCapabilityState;
  readonly github?: PluginGithubMetadata;
}

export interface InstalledFile {
  readonly version: 1;
  readonly plugins: readonly InstalledRecord[];
}

const EMPTY: InstalledFile = { version: 1, plugins: [] };

function installedPath(homeDir: string): string {
  return path.join(homeDir, "plugins", "installed.json");
}

export async function readInstalled(machine: Machine, homeDir: string): Promise<InstalledFile> {
  let text: string;
  try {
    text = await readTextFile(machine, installedPath(homeDir));
  } catch {
    return EMPTY; // missing file → empty registry
  }
  try {
    const parsed = JSON.parse(text) as InstalledFile;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.plugins)) {
      throw new Error("installed.json is not a valid InstalledFile object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${installedPath(homeDir)}: ${(error as Error).message}`, { cause: error });
  }
}

export async function writeInstalled(machine: Machine, homeDir: string, data: InstalledFile): Promise<void> {
  await machine.mkdir(path.join(homeDir, "plugins"), { parents: true, existOk: true });
  await writeTextFile(machine, installedPath(homeDir), JSON.stringify(data, null, 2));
}
