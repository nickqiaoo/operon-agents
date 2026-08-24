import type {
  Agent,
  CreateSessionOptions,
  Harness,
  Machine,
  MachineFactory,
  ResumeSessionOptions,
} from "operon-agents";
import type { AgentRef, EnvironmentRef } from "../protocol/types.ts";
import { ManagedInvalidRequestError } from "./errors.ts";

export interface AgentResolution<TContext = unknown> {
  readonly agent?: Agent<TContext>;
  readonly createOptions?: Omit<CreateSessionOptions<TContext>, "id" | "title" | "workDir" | "agent">;
  readonly resumeOptions?: Omit<ResumeSessionOptions<TContext>, "agent">;
}

export interface ManagedAgentRegistry<TContext = unknown> {
  resolve(ref: AgentRef): AgentResolution<TContext> | Promise<AgentResolution<TContext>>;
}

/** Let managed sessions use the Harness's configured default Agent. */
export class DefaultAgentRegistry<TContext = unknown> implements ManagedAgentRegistry<TContext> {
  private readonly id: string;

  constructor(id = "default") {
    this.id = id;
  }

  resolve(ref: AgentRef): AgentResolution<TContext> {
    if (ref.id !== this.id) throw new ManagedInvalidRequestError(`unknown agent "${ref.id}"`);
    return {};
  }
}

export interface EnvironmentResolution {
  /** Durable working directory recorded by the SessionRepository. */
  readonly workDir: string;
  /** Optional per-session execution backend. Lifecycle remains provider-owned. */
  readonly machine?: Machine | MachineFactory;
}

export interface ManagedEnvironmentRegistry {
  resolve(ref: EnvironmentRef): EnvironmentResolution | Promise<EnvironmentResolution>;
}

export class StaticEnvironmentRegistry implements ManagedEnvironmentRegistry {
  private readonly environments: Readonly<Record<string, EnvironmentResolution>>;

  constructor(environments: Readonly<Record<string, EnvironmentResolution>>) {
    this.environments = environments;
  }

  resolve(ref: EnvironmentRef): EnvironmentResolution {
    const resolution = this.environments[ref.id];
    if (resolution === undefined) throw new ManagedInvalidRequestError(`unknown environment "${ref.id}"`);
    return resolution;
  }
}

/** Convenience composition for a server that owns the Harness. Machine/sandbox lifecycle
 *  remains with the host; this merely makes that explicit at the managed-server boundary. */
export interface ManagedHarnessOptions<TContext = unknown> {
  readonly harness: Harness<TContext>;
  readonly agents?: ManagedAgentRegistry<TContext>;
  readonly environments: ManagedEnvironmentRegistry;
  readonly defaultAgentId?: string;
  readonly machine?: Machine | MachineFactory;
}
