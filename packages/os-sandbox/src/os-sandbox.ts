import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { LocalEnvironment, type Environment } from "operon-agents-core";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SandboxedLocalEnvironment, type SandboxPolicyContext } from "./environment.ts";
import type { OsSandboxOptions, OsSandboxStatus } from "./types.ts";

/**
 * Write roots every sandboxed environment needs regardless of its cwd:
 * the temp trees (both the symlink and its real path — srt matches paths
 * literally), and the framework's background-task log directory — the bash
 * tool redirects background/attached command output to
 * `<home>/.operon/tasks/…` (or `/tmp/.operon/tasks` when home contains the
 * workspace), and that redirect happens INSIDE the sandboxed command.
 */
function sharedWriteRoots(): string[] {
  const roots = new Set<string>();
  for (const dir of [tmpdir(), "/tmp"]) {
    roots.add(dir);
    try {
      roots.add(realpathSync(dir));
    } catch {
      /* missing on this platform — nothing to grant */
    }
  }
  const home = homedir().replace(/\/+$/, "");
  if (home.length > 0) roots.add(`${home}/.operon/tasks`);
  return [...roots];
}

/**
 * Denials every process trips on shell startup — pure noise that would stamp
 * `<sandbox_violations>` onto EVERY successful command's stderr. Observed on
 * macOS 15/26: sh/bash/zsh probe this sysctl and carry on.
 */
const BENIGN_VIOLATIONS: Readonly<Record<string, readonly string[]>> = {
  "*": ["sysctl-read kern.iossupportversion"],
};

function mergeIgnoreViolations(user: Readonly<Record<string, readonly string[]>> | undefined): Record<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const source of [BENIGN_VIOLATIONS, user ?? {}]) {
    for (const [pattern, lines] of Object.entries(source)) {
      merged.set(pattern, [...(merged.get(pattern) ?? []), ...lines]);
    }
  }
  return Object.fromEntries(merged);
}

function buildRuntimeConfig(options: OsSandboxOptions): SandboxRuntimeConfig {
  const network = options.network;
  return {
    ignoreViolations: mergeIgnoreViolations(options.ignoreViolations),
    network: {
      // Required by srt; [] means "deny all", which is the safe default.
      allowedDomains: [...(network?.allowedDomains ?? [])],
      deniedDomains: [...(network?.deniedDomains ?? [])],
      ...(network?.allowUnixSockets !== undefined ? { allowUnixSockets: [...network.allowUnixSockets] } : {}),
      ...(network?.allowLocalBinding !== undefined ? { allowLocalBinding: network.allowLocalBinding } : {}),
    },
    filesystem: {
      denyRead: [...(options.filesystem?.denyRead ?? [])],
      // Session-level extras only; each environment adds its own cwd tree per call.
      allowWrite: [...(options.filesystem?.allowWrite ?? [])],
      denyWrite: [...(options.filesystem?.denyWrite ?? [])],
    },
  };
}

/**
 * Process-wide OS sandbox session for LOCAL environments.
 *
 * `start()` never throws: on macOS/Linux with dependencies present it
 * initializes @anthropic-ai/sandbox-runtime (which starts the network filter
 * proxy) and `environment()` mints {@link SandboxedLocalEnvironment}s; anywhere else
 * `status.enabled` is false and `environment()` mints plain {@link LocalEnvironment}s
 * — same API, today's behavior, and `status.reason` says why.
 *
 * One OsSandbox per process: the underlying SandboxManager is a module-level
 * singleton, so a second concurrent `start()` with a different config would
 * silently share the first one's session. Remote environments (SSH, vendor
 * sandboxes) are out of scope by design — their commands do not run on this
 * host.
 */
export class OsSandbox {
  readonly status: OsSandboxStatus;
  private readonly policy: SandboxPolicyContext | undefined;

  private constructor(status: OsSandboxStatus, policy?: SandboxPolicyContext) {
    this.status = status;
    this.policy = policy;
  }

  static async start(options: OsSandboxOptions = {}): Promise<OsSandbox> {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      return OsSandbox.disabled(`unsupported platform: ${platform} (macOS/Linux only)`);
    }

    const deps = await SandboxManager.checkDependenciesAsync();
    if (deps.errors.length > 0) {
      return OsSandbox.disabled(`missing sandbox dependencies: ${deps.errors.join(", ")}`);
    }

    const ask = options.network?.onAskHost;
    try {
      await SandboxManager.initialize(
        buildRuntimeConfig(options),
        ask === undefined
          ? undefined
          : (pattern) => ask({ host: pattern.host, ...(pattern.port !== undefined ? { port: pattern.port } : {}) }),
        options.monitorViolations ?? true,
      );
    } catch (error) {
      return OsSandbox.disabled(`sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const policy: SandboxPolicyContext = {
      denyRead: [...(options.filesystem?.denyRead ?? [])],
      denyWrite: [...(options.filesystem?.denyWrite ?? [])],
      allowWrite: [...(options.filesystem?.allowWrite ?? []), ...sharedWriteRoots()],
    };
    return new OsSandbox({ enabled: true, platform, warnings: deps.warnings }, policy);
  }

  /** An explicitly-off OsSandbox: same `environment()` API, plain LocalEnvironments. */
  static disabled(reason = "disabled by host"): OsSandbox {
    return new OsSandbox({ enabled: false, reason });
  }

  /**
   * Build the environment a session should get — sandboxed when this OsSandbox is
   * enabled, a plain LocalEnvironment otherwise. Accepts exactly what LocalEnvironment's
   * constructor does.
   */
  environment(cwdOrOptions: string | { cwd?: string; additionalDirs?: readonly string[] } = process.cwd()): Environment {
    return this.policy === undefined
      ? new LocalEnvironment(cwdOrOptions)
      : new SandboxedLocalEnvironment(this.policy, cwdOrOptions);
  }

  /** Tear down the srt session (filter proxies, monitors). Idempotent. */
  async dispose(): Promise<void> {
    if (this.status.enabled) await SandboxManager.reset();
  }
}
