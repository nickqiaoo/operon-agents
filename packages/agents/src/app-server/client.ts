/**
 * Reference TypeScript client for the app-server protocol.
 *
 * It is both (1) a drop-in-ish, Harness-shaped wrapper around a spawned
 * `operon-app-server` process and (2) the executable spec other-language clients
 * mirror. The transport is injectable, so it also runs over `pairedTransports`
 * in-process for tests.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { AgentEvent, ApprovalRequest, ApprovalResponse, QuestionRequest, QuestionResult, RunResult, SessionSummary } from "operon-agents-core";
import {
  classify,
  isFailure,
  type JsonRpcTransport,
  nodeStreamTransport,
  request as makeRequest,
  RpcError,
  success,
} from "./codec.ts";
import {
  type ClientCancelRequestParams,
  type ClientRequestApprovalParams,
  type ClientRequestQuestionParams,
  type ClientCapabilities,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcResponse,
  Method,
  PROTOCOL_VERSION,
  type SessionFollowUpResult,
  type SessionInfo,
  type SessionSnapshotResult,
  type SessionSteerResult,
} from "./protocol.ts";

export type ApprovalHandler = (request: ApprovalRequest, sessionId: string) => Promise<ApprovalResponse> | ApprovalResponse;
export type QuestionHandler = (
  request: QuestionRequest,
  sessionId: string,
  options: { readonly signal: AbortSignal },
) => Promise<QuestionResult> | QuestionResult;
export type EventListener = (event: AgentEvent) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface SpawnOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export class AppServerClient {
  private readonly transport: JsonRpcTransport;
  private readonly child?: ChildProcess;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly inboundAbort = new Map<JsonRpcId, AbortController>();
  private seq = 0;
  private approvalHandler: ApprovalHandler | undefined;
  private questionHandler: QuestionHandler | undefined;
  private closed = false;

  constructor(transport: JsonRpcTransport, child?: ChildProcess) {
    this.transport = transport;
    this.child = child;
    void this.readLoop();
  }

  /** Spawn the app-server binary and connect over its stdio. */
  static spawn(opts: SpawnOptions = {}): AppServerClient {
    const command = opts.command ?? process.execPath;
    const args = [...(opts.args ?? [])];
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...opts.env },
    });
    const transport = nodeStreamTransport(child.stdout!, child.stdin!);
    return new AppServerClient(transport, child);
  }

  private async readLoop(): Promise<void> {
    for await (const message of this.transport.incoming()) {
      const c = classify(message);
      if (c.kind === "response") this.onResponse(c.message);
      else if (c.kind === "request") void this.onReverseRequest(c.message.id, c.message.method, c.message.params);
      else if (c.kind === "notification") this.onNotification(c.message.method, c.message.params);
    }
    this.failAllPending(new RpcError(-32011, "transport closed"));
  }

  private onResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (isFailure(response)) pending.reject(new RpcError(response.error.code, response.error.message, response.error.data));
    else pending.resolve(response.result);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === Method.SessionEvent) {
      const event = params as AgentEvent;
      for (const listener of this.eventListeners) listener(event);
      return;
    }
    if (method === Method.ClientCancelRequest) {
      const { id } = (params ?? {}) as ClientCancelRequestParams;
      this.inboundAbort.get(id)?.abort();
      this.inboundAbort.delete(id);
    }
  }

  private async onReverseRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const controller = new AbortController();
    this.inboundAbort.set(id, controller);
    try {
      const result = await this.dispatchReverse(method, params, controller.signal);
      this.transport.send(success(id, result));
    } catch (error) {
      const body = error instanceof RpcError ? error.toBody() : { code: -32603, message: error instanceof Error ? error.message : String(error) };
      this.transport.send({ jsonrpc: "2.0", id, error: body });
    } finally {
      this.inboundAbort.delete(id);
    }
  }

  private async dispatchReverse(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (method === Method.ClientRequestApproval) {
      const p = params as ClientRequestApprovalParams;
      if (!this.approvalHandler) return { decision: "rejected", feedback: "no approval handler" } satisfies ApprovalResponse;
      return this.approvalHandler(p.request, p.sessionId);
    }
    if (method === Method.ClientRequestQuestion) {
      const p = params as ClientRequestQuestionParams;
      if (!this.questionHandler) return null;
      return this.questionHandler(p.request, p.sessionId, { signal });
    }
    throw new RpcError(-32601, `unknown reverse method: ${method}`);
  }

  private request<R>(method: string, params?: unknown): Promise<R> {
    if (this.closed) return Promise.reject(new RpcError(-32011, "client closed"));
    const id = `c-${++this.seq}`;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send(makeRequest(id, method, params));
    });
  }

  private failAllPending(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  // ── Public API (mirrors the in-process Harness) ──────────────────────────────

  initialize(capabilities: ClientCapabilities = { approval: true, question: true }, info?: { name: string; version?: string }): Promise<InitializeResult> {
    return this.request<InitializeResult>(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: info ?? { name: "app-server-client", version: "0.0.0" },
      clientCapabilities: capabilities,
    });
  }

  newSession(opts: { workDir?: string; title?: string; model?: string } = {}): Promise<SessionInfo> {
    return this.request<SessionInfo>(Method.SessionNew, opts);
  }
  resumeSession(sessionId: string): Promise<SessionInfo> {
    return this.request<SessionInfo>(Method.SessionResume, { sessionId });
  }
  forkSession(sessionId: string, opts: { title?: string } = {}): Promise<SessionInfo> {
    return this.request<SessionInfo>(Method.SessionFork, { sessionId, ...opts });
  }
  listSessions(): Promise<readonly SessionSummary[]> {
    return this.request<readonly SessionSummary[]>(Method.SessionList, {});
  }
  closeSession(sessionId: string): Promise<unknown> {
    return this.request(Method.SessionClose, { sessionId });
  }

  prompt(sessionId: string, input: string): Promise<RunResult> {
    return this.request<RunResult>(Method.SessionPrompt, { sessionId, input });
  }

  /** The session's folded state. Exact late-join seam: events received before this
   *  resolves are already in the snapshot; events after it are not (see protocol doc). */
  snapshot(sessionId: string, opts: { addresses?: readonly string[]; maxMessages?: number } = {}): Promise<SessionSnapshotResult> {
    return this.request<SessionSnapshotResult>(Method.SessionSnapshot, { sessionId, ...opts });
  }

  /** Continue a durably-interrupted run: `answers` maps each pending `toolCallId` (from the
   *  prior result's `interruptions`) to an approval decision. The session must be open. */
  respond(sessionId: string, answers: Record<string, ApprovalResponse>): Promise<RunResult> {
    return this.request<RunResult>(Method.SessionRespond, { sessionId, answers });
  }
  steer(sessionId: string, text: string): Promise<SessionSteerResult> {
    return this.request<SessionSteerResult>(Method.SessionSteer, { sessionId, text });
  }
  followUp(sessionId: string, text: string): Promise<SessionFollowUpResult> {
    return this.request<SessionFollowUpResult>(Method.SessionFollowUp, { sessionId, text });
  }
  cancel(sessionId: string): Promise<unknown> {
    return this.request(Method.SessionCancel, { sessionId });
  }

  /** Call a whitelisted control-plane method (see `INVOKABLE_METHODS`). */
  invoke<R = unknown>(sessionId: string, method: string, ...args: unknown[]): Promise<R> {
    return this.request<{ value: R }>(Method.SessionInvoke, { sessionId, method, args }).then((r) => r.value);
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }
  setQuestionHandler(handler: QuestionHandler | undefined): void {
    this.questionHandler = handler;
  }

  /** Close the transport and (if spawned) the child process. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new RpcError(-32011, "client closed"));
    this.transport.close();
    this.child?.kill();
  }
}
