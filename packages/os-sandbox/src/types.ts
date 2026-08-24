/** A host a sandboxed command tried to reach, handed to {@link OsSandboxNetworkOptions.onAskHost}. */
export interface NetworkAskRequest {
  readonly host: string;
  /** Destination port when the client stated one; undefined for portless matches. */
  readonly port?: number;
}

export interface OsSandboxNetworkOptions {
  /**
   * Domain patterns commands may reach: `"api.github.com"`, `"*.npmjs.org"`,
   * `"github.com:443"`, or `"*"` for everything. Default `[]` — all network
   * access is DENIED.
   *
   * All traffic is forced through a local filtering proxy, so even `["*"]`
   * only serves proxy-aware clients (HTTP/HTTPS via env vars, TCP via SOCKS).
   * A client that ignores proxies entirely — plain `ssh`, a raw DB socket —
   * stays blocked regardless of the allowlist; grant those a unix socket or
   * run them outside the sandbox.
   */
  readonly allowedDomains?: readonly string[];
  /** Deny these even when a broader allow pattern would match. */
  readonly deniedDomains?: readonly string[];
  /**
   * Consulted when a command contacts a host outside the allowlist; resolve
   * `true` to let that request through. Wire this to the host application's
   * approval UI (the framework's `Responder.requestApproval`, a dialog, …).
   * Absent — out-of-list hosts are denied outright.
   */
  readonly onAskHost?: (request: NetworkAskRequest) => Promise<boolean>;
  /** Unix socket paths commands may connect to (e.g. `/var/run/docker.sock`). */
  readonly allowUnixSockets?: readonly string[];
  /** Let commands bind/listen on localhost ports (dev servers). */
  readonly allowLocalBinding?: boolean;
}

export interface OsSandboxFilesystemOptions {
  /**
   * Paths commands must not read, on top of srt's built-in credential
   * protections (`~/.ssh` and friends are already covered).
   */
  readonly denyRead?: readonly string[];
  /**
   * Extra write roots granted to EVERY machine, on top of the per-machine
   * grant (its cwd + additionalDirs) and the shared system roots (tmp, the
   * framework's background-task log directory).
   */
  readonly allowWrite?: readonly string[];
  /** Read-only carve-outs inside allowed write roots (e.g. a `.env`, `.git`). */
  readonly denyWrite?: readonly string[];
}

export interface OsSandboxOptions {
  /** Omit for the default: all network access denied. */
  readonly network?: OsSandboxNetworkOptions;
  readonly filesystem?: OsSandboxFilesystemOptions;
  /**
   * Watch the OS for sandbox denials (macOS `log stream`, Linux seccomp
   * observer) and annotate them onto failing commands' stderr, so the model
   * sees "the sandbox blocked X" instead of a bare exit code. Default true.
   */
  readonly monitorViolations?: boolean;
  /**
   * Violations to suppress from monitoring, merged over the built-in
   * benign-noise list: key `"*"` applies to every command, any other key is a
   * substring match on the command; values are substring matches on the
   * violation line.
   */
  readonly ignoreViolations?: Readonly<Record<string, readonly string[]>>;
}

export type OsSandboxStatus =
  | {
      readonly enabled: true;
      readonly platform: "darwin" | "linux";
      /** Non-fatal findings from the dependency check (degraded functionality). */
      readonly warnings: readonly string[];
    }
  | {
      readonly enabled: false;
      /** Why sandboxing is off: unsupported platform, missing deps, init failure, or explicit. */
      readonly reason: string;
    };
