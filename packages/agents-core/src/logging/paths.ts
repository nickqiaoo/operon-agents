import { homedir } from "node:os";
import { join } from "node:path";

export interface LogPathOptions {
  readonly appName?: string;
  readonly homeDir?: string;
}

function logsDir(options: LogPathOptions): string {
  const appName = options.appName ?? "agents";
  const homeDir = options.homeDir ?? join(homedir(), `.${appName}`);
  return join(homeDir, "logs");
}

/** The shared, rolling application log: `<home>/logs/<app>.log`. */
export function resolveGlobalLogPath(options: LogPathOptions = {}): string {
  return join(logsDir(options), `${options.appName ?? "agents"}.log`);
}

/** The troubleshooting log, kept apart from the app log: `<home>/logs/diagnostics.log`. */
export function resolveDiagnosticLogPath(options: LogPathOptions = {}): string {
  return join(logsDir(options), "diagnostics.log");
}

/** Per-session log living next to the session's data. */
export function resolveSessionLogPath(sessionDir: string): string {
  return join(sessionDir, "session.log");
}
