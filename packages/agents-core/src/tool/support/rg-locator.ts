import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Environment } from "../environment.ts";

export interface RgResolution {
  readonly path: string;
}

function findOnPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function ensureRgPath(_options: { signal?: AbortSignal } = {}): Promise<RgResolution> {
  const found = findOnPath("rg");
  if (found === undefined) {
    return Promise.reject(new Error("ripgrep (rg) not found on PATH"));
  }
  return Promise.resolve({ path: found });
}

/**
 * Decide how to invoke ripgrep on a given environment.
 * - Local environment → the absolute path found on the orchestrator's PATH (the
 *   process runs here, so the resolved path is correct and avoids PATH ambiguity).
 * - Remote environments (ssh, sandbox) → the bare command name `rg`, resolved against
 *   the REMOTE host's PATH when exec'd. The local absolute path would be meaningless
 *   there, so we never probe it for non-local environments.
 */
export async function resolveRgCommand(
  environment: Pick<Environment, "name">,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (environment.name === "local") return (await ensureRgPath(options)).path;
  return "rg";
}

export function rgUnavailableMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    "Grep requires ripgrep (rg), which could not be located. Install it " +
    "(e.g. `brew install ripgrep`, `apt install ripgrep`, `choco install ripgrep`) and ensure " +
    `it is on PATH. (${detail})`
  );
}
