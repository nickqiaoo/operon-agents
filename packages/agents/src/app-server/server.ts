/**
 * AppServer — exposes a `Harness` over a `JsonRpcTransport` so an external
 * process (any language) can drive it. This is the fifth topology from the design
 * doc: LocalMachine + disk store + a stdout EventSink + a stdin reverse-RPC
 * Responder, with the controlling process living outside.
 *
 * The engine is untouched: the server only (1) forwards each session's events as
 * `session/event` notifications and (2) wires `setApprovalHandler` /
 * `setQuestionHandler` to reverse-RPC requests — the cross-process form of the
 * in-process `approvalHandlers` map.
 */
import type { AgentEvent, ApprovalResponse, QuestionResult } from "operon-agents-core";
import type { Harness, HarnessSession } from "../harness.ts";
import {
  errorToBody,
  failure,
  type JsonRpcTransport,
  notification,
  request as makeRequest,
  RpcError,
  success,
  toWireSafe,
} from "./codec.ts";
import {
  type ClientCancelRequestParams,
  type ClientRequestApprovalParams,
  type ClientRequestQuestionParams,
  ErrorCode,
  type InitializeParams,
  type InitializeResult,
  INVOKABLE_METHODS,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  Method,
  PROTOCOL_VERSION,
  type SessionForkParams,
  type SessionFollowUpParams,
  type SessionFollowUpResult,
  type SessionInfo,
  type SessionInvokeParams,
  type SessionNewParams,
  type SessionPromptParams,
  type SessionRespondParams,
  type SessionRef,
  type SessionResumeParams,
  type SessionSnapshotParams,
  type SessionSnapshotResult,
  type SessionSteerParams,
  type SessionSteerResult,
} from "./protocol.ts";

const INVOKABLE = new Set<string>(INVOKABLE_METHODS);

export interface AppServerOptions {
  readonly harness: Harness;
  readonly transport: JsonRpcTransport;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** Diagnostics sink. Never write protocol to this — it is for human logs. */
  readonly log?: (message: string) => void;
}

interface PendingReverse {
  readonly sessionId: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface WiredSession {
  readonly session: HarnessSession;
  readonly unsubscribe: () => void;
}

export class AppServer {
  private readonly harness: Harness;
  private readonly transport: JsonRpcTransport;
  private readonly serverInfo: { readonly name: string; readonly version: string };
  private readonly log: (message: string) => void;

  private initialized = false;
  private clientApproval = false;
  private clientQuestion = false;

  private readonly wired = new Map<string, WiredSession>();
  private readonly reversePending = new Map<JsonRpcId, PendingReverse>();
  private reverseSeq = 0;

  constructor(opts: AppServerOptions) {
    this.harness = opts.harness;
    this.transport = opts.transport;
    this.serverInfo = opts.serverInfo ?? { name: "operon-app-server", version: "0.0.0" };
    this.log = opts.log ?? (() => undefined);
  }

  /** Run the dispatch loop until the transport closes. */
  async serve(): Promise<void> {
    for await (const message of this.transport.incoming()) {
      // Fire-and-forget: a long-running `session/prompt` must not block reading the
      // next message (cancel / steer / reverse-RPC answers arrive concurrently).
      void this.handleMessage(message);
    }
    await this.shutdown();
  }

  private async shutdown(): Promise<void> {
    for (const pending of this.reversePending.values()) {
      pending.reject(new RpcError(ErrorCode.RequestCancelled, "transport closed"));
    }
    this.reversePending.clear();
    for (const { unsubscribe } of this.wired.values()) unsubscribe();
    this.wired.clear();
    await this.harness.close();
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const m = message as Record<string, unknown>;
    const hasMethod = typeof m.method === "string";
    const hasId = typeof m.id === "string" || typeof m.id === "number";

    // A response (no method, has id) is the host answering one of our reverse requests.
    if (!hasMethod && hasId) {
      this.resolveReverse(message as JsonRpcResponse);
      return;
    }
    if (hasMethod && hasId) {
      await this.handleRequest(message as JsonRpcRequest);
      return;
    }
    if (hasMethod) {
      this.handleNotification(m.method as string, m.params);
      return;
    }
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.route(req.method, req.params);
      this.transport.send(success(req.id, toWireSafe(result)));
    } catch (error) {
      this.transport.send(failure(req.id, errorToBody(error)));
    }
  }

  private handleNotification(method: string, params: unknown): void {
    // The host can tell us it dropped its end (rare); nothing else expected inbound.
    this.log(`ignoring notification: ${method}${params === undefined ? "" : ""}`);
  }

  private async route(method: string, params: unknown): Promise<unknown> {
    if (method === Method.Initialize) return this.onInitialize(params as InitializeParams);
    if (!this.initialized) throw new RpcError(ErrorCode.NotInitialized, "call initialize first");

    switch (method) {
      case Method.SessionNew:
        return this.onSessionNew((params ?? {}) as SessionNewParams);
      case Method.SessionResume:
        return this.onSessionResume(params as SessionResumeParams);
      case Method.SessionFork:
        return this.onSessionFork(params as SessionForkParams);
      case Method.SessionList:
        return this.harness.listSessions();
      case Method.SessionClose:
        return this.onSessionClose(params as SessionRef);
      case Method.SessionPrompt:
        return this.onSessionPrompt(params as SessionPromptParams);
      case Method.SessionSnapshot:
        return this.onSessionSnapshot(params as SessionSnapshotParams);
      case Method.SessionRespond:
        return this.onSessionRespond(params as SessionRespondParams);
      case Method.SessionSteer:
        return this.onSessionSteer(params as SessionSteerParams);
      case Method.SessionFollowUp:
        return this.onSessionFollowUp(params as SessionFollowUpParams);
      case Method.SessionCancel:
        return this.onSessionCancel(params as SessionRef);
      case Method.SessionInvoke:
        return this.onSessionInvoke(params as SessionInvokeParams);
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `unknown method: ${method}`);
    }
  }

  // ── Handshake ─────────────────────────────────────────────────────────────

  private onInitialize(params: InitializeParams): InitializeResult {
    if (typeof params?.protocolVersion !== "number") {
      throw new RpcError(ErrorCode.InvalidParams, "protocolVersion (number) required");
    }
    this.clientApproval = params.clientCapabilities?.approval ?? false;
    this.clientQuestion = params.clientCapabilities?.question ?? false;
    this.initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: this.serverInfo,
      permissionModes: ["manual", "workspace", "yolo"],
      invokableMethods: INVOKABLE_METHODS,
    };
  }

  // ── Fleet ───────────────────────────────────────────────────────────────────

  private async onSessionNew(params: SessionNewParams): Promise<SessionInfo> {
    const session = await this.harness.createSession({
      ...(params.workDir !== undefined ? { workDir: params.workDir } : {}),
      ...(params.title !== undefined ? { title: params.title } : {}),
    });
    if (params.model !== undefined) session.setModel(params.model);
    this.wireSession(session);
    return { sessionId: session.id, workDir: session.workDir };
  }

  private async onSessionResume(params: SessionResumeParams): Promise<SessionInfo> {
    const session = await this.harness.resumeSession(this.requireId(params));
    this.wireSession(session);
    return { sessionId: session.id, workDir: session.workDir };
  }

  private async onSessionFork(params: SessionForkParams): Promise<SessionInfo> {
    const session = await this.harness.forkSession(this.requireId(params), {
      ...(params.title !== undefined ? { title: params.title } : {}),
    });
    this.wireSession(session);
    return { sessionId: session.id, workDir: session.workDir };
  }

  private async onSessionClose(params: SessionRef): Promise<Record<string, never>> {
    const id = this.requireId(params);
    this.wired.get(id)?.unsubscribe();
    this.wired.delete(id);
    this.rejectReverseForSession(id, "session closed");
    await this.harness.closeSession(id);
    return {};
  }

  // ── Run driving ─────────────────────────────────────────────────────────────

  private async onSessionPrompt(params: SessionPromptParams): Promise<unknown> {
    const session = this.requireSession(params);
    // Returns when the run completes; events stream meanwhile. Concurrent prompts
    // queue on the session's run lock (one run at a time) and each gets its own reply.
    return session.prompt(params.input);
  }

  private onSessionSnapshot(params: SessionSnapshotParams): SessionSnapshotResult {
    const session = this.requireSession(params);
    // Synchronous on purpose: the response is written into the same ordered stdout stream
    // as `session/event` notifications, so events notified before it are in the snapshot
    // and events after it are not — the exact-seam contract documented on the protocol type.
    return session.snapshot({
      ...(params.addresses !== undefined ? { addresses: params.addresses } : {}),
      ...(params.maxMessages !== undefined ? { maxMessages: params.maxMessages } : {}),
    });
  }

  private async onSessionRespond(params: SessionRespondParams): Promise<unknown> {
    const session = this.requireSession(params);
    // Continue a run that durably interrupted for approval: apply the answers and resume.
    // Like prompt, resolves when the run reaches its next stop (which may interrupt again).
    return session.resume(params.answers);
  }

  private onSessionSteer(params: SessionSteerParams): SessionSteerResult {
    const session = this.requireSession(params);
    return { accepted: true, steerId: session.steer(params.text) };
  }

  private onSessionFollowUp(params: SessionFollowUpParams): SessionFollowUpResult {
    const session = this.requireSession(params);
    const steerId = session.followUp(params.text);
    return steerId === null ? { accepted: false } : { accepted: true, steerId };
  }

  private onSessionCancel(params: SessionRef): Record<string, never> {
    const session = this.requireSession(params);
    session.cancel();
    // Any in-flight approval/question for this session can never be answered now.
    this.rejectReverseForSession(session.id, "run cancelled");
    return {};
  }

  private async onSessionInvoke(params: SessionInvokeParams): Promise<{ value: unknown }> {
    const session = this.requireSession(params);
    if (typeof params.method !== "string" || !INVOKABLE.has(params.method)) {
      throw new RpcError(ErrorCode.MethodNotFound, `not invokable: ${String(params.method)}`);
    }
    const fn = (session as unknown as Record<string, unknown>)[params.method];
    if (typeof fn !== "function") {
      throw new RpcError(ErrorCode.MethodNotFound, `not a method: ${params.method}`);
    }
    const args = Array.isArray(params.args) ? params.args : [];
    const value = await (fn as (...a: unknown[]) => unknown).apply(session, args);
    return { value: toWireSafe(value) };
  }

  // ── Per-session wiring: events out, reverse-RPC for approvals/questions ──────

  private wireSession(session: HarnessSession): void {
    if (this.wired.has(session.id)) return;
    const unsubscribe = session.onEvent((event: AgentEvent) => {
      this.transport.send(notification(Method.SessionEvent, event));
    });
    if (this.clientApproval) {
      session.setApprovalHandler((req) => this.callClient(Method.ClientRequestApproval, session.id, { sessionId: session.id, request: req } satisfies ClientRequestApprovalParams) as Promise<ApprovalResponse>);
    }
    if (this.clientQuestion) {
      session.setQuestionHandler((req, options) =>
        this.callClient(
          Method.ClientRequestQuestion,
          session.id,
          { sessionId: session.id, request: req } satisfies ClientRequestQuestionParams,
          options?.signal,
        ) as Promise<QuestionResult>,
      );
    }
    this.wired.set(session.id, { session, unsubscribe });
  }

  // ── Reverse-RPC (server → host request) ─────────────────────────────────────

  private callClient(method: string, sessionId: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new RpcError(ErrorCode.RequestCancelled, "already aborted"));
    const id = `rev-${++this.reverseSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      this.reversePending.set(id, { sessionId, resolve, reject });
      if (signal) {
        const onAbort = (): void => {
          if (!this.reversePending.has(id)) return;
          this.reversePending.delete(id);
          this.transport.send(notification(Method.ClientCancelRequest, { id } satisfies ClientCancelRequestParams));
          reject(new RpcError(ErrorCode.RequestCancelled, "cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.transport.send(makeRequest(id, method, params));
    });
  }

  private resolveReverse(response: JsonRpcResponse): void {
    const pending = this.reversePending.get(response.id);
    if (!pending) return;
    this.reversePending.delete(response.id);
    if ("error" in response) pending.reject(new RpcError(response.error.code, response.error.message, response.error.data));
    else pending.resolve(response.result);
  }

  private rejectReverseForSession(sessionId: string, reason: string): void {
    for (const [id, pending] of this.reversePending) {
      if (pending.sessionId !== sessionId) continue;
      this.reversePending.delete(id);
      this.transport.send(notification(Method.ClientCancelRequest, { id } satisfies ClientCancelRequestParams));
      pending.reject(new RpcError(ErrorCode.RequestCancelled, reason));
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private requireId(ref: SessionRef): string {
    if (!ref || typeof ref.sessionId !== "string") throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
    return ref.sessionId;
  }

  private requireSession(ref: SessionRef): HarnessSession {
    const id = this.requireId(ref);
    const session = this.harness.getSession(id);
    if (!session) throw new RpcError(ErrorCode.SessionNotFound, `session not found: ${id}`);
    return session;
  }
}
