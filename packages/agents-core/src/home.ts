import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The directory name the framework keeps host-level state under.
 *
 * One constant because it is written from two unrelated layers — MCP OAuth
 * credentials (`mcp/oauth/store.ts`) and background bash logs
 * (`tool/builtin/bash.ts`) — and each used to spell it out inline. It was
 * `.agent-framework`, a name this project has not gone by for some time.
 *
 * There is no fallback to the old directory: anything under it is either
 * disposable (task logs) or re-obtainable (an OAuth token is re-granted by
 * authenticating again).
 */
export const OPERON_HOME_DIRNAME = ".operon";

/** `~/.operon` on the machine this process runs on. */
export function operonHomeDir(): string {
  return join(homedir(), OPERON_HOME_DIRNAME);
}
