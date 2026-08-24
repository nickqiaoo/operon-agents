export const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "ftp_proxy",
] as const;

export interface NonInteractiveEnvOptions {
  readonly shellPath: string;
  readonly base?: NodeJS.ProcessEnv;
  readonly extra?: Record<string, string>;
}

export function nonInteractiveShellEnv(options: NonInteractiveEnvOptions): Record<string, string> {
  const base = options.base ?? process.env;
  const env: Record<string, string> = {
    NO_COLOR: "1",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: base["GIT_TERMINAL_PROMPT"] ?? "0",
    SHELL: options.shellPath,
  };
  if (options.extra) Object.assign(env, options.extra);
  return env;
}

export function proxyEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PROXY_ENV_VARS) {
    const value = base[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}
