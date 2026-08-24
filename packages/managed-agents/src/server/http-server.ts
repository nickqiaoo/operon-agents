import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isDurableAgentEvent, type InterruptAnswer } from "operon-agents";
import type {
  CreateManagedMessageRequest,
  CreateManagedSessionRequest,
  InterruptionsResponse,
  ListSessionEventsResponse,
  ListManagedSessionsResponse,
  ManagedApiError,
  ResumeManagedSessionRequest,
} from "../protocol/types.ts";
import {
  ManagedForbiddenError,
  ManagedInvalidRequestError,
  ManagedServerError,
} from "./errors.ts";
import type { SessionService } from "./session-service.ts";
import type { SessionWorker } from "./session-worker.ts";

export type ManagedAuthorizationAction =
  | "sessions.create"
  | "sessions.list"
  | "sessions.read"
  | "sessions.delete"
  | "messages.create"
  | "events.list"
  | "events.stream"
  | "sessions.cancel"
  | "interruptions.list"
  | "sessions.resume";

export interface ManagedAuthorizationContext {
  readonly action: ManagedAuthorizationAction;
  readonly sessionId?: string;
}

export type ManagedAuthorize = (
  request: IncomingMessage,
  context: ManagedAuthorizationContext,
) => boolean | void | Promise<boolean | void>;

/**
 * Authorize every request. For local demos and tests only.
 *
 * It exists so that running without authorization is something you write down, rather than
 * something you get by forgetting to pass an option — grep for this name to find every
 * deployment that has no access control.
 */
export const allowAllRequests: ManagedAuthorize = () => true;

export interface ManagedHttpServerOptions<TContext = unknown> {
  /** Reads and writes of session state. Every route that is not execution goes here. */
  readonly service: SessionService;
  /**
   * Execution. Optional: a deployment can run the API surface with no worker in this process at
   * all — accepted inputs and commands wait for a worker elsewhere to claim them, because the
   * work table is what connects the two. With one, it is nudged after every write so the common
   * single-process case needs no claim latency. Nothing here is answered BY the worker: every
   * route is a store operation, so any node can serve any session.
   */
  readonly worker?: SessionWorker<TContext>;
  readonly basePath?: string;
  readonly heartbeatMs?: number;
  readonly maxBodyBytes?: number;
  /**
   * Authentication and ownership. REQUIRED — a managed server has no safe default here.
   *
   * It used to be optional and absent meant "allow everything", so a deployment that forgot to
   * wire it was open to anyone who could reach the port, with no symptom to notice. Making it
   * mandatory turns that from a deployment checklist item into something the type system will
   * not let you skip. To deliberately run without checks (a local demo, a test), pass
   * `allowAllRequests` and let the name say so at the call site.
   *
   * Returning false denies the request; throwing ManagedUnauthorizedError or
   * ManagedForbiddenError preserves the distinction between "who are you" and "not yours".
   * Throwing ManagedSessionNotFoundError instead is how a multi-tenant deployment avoids
   * turning 403-vs-404 into an existence oracle for other tenants' session ids.
   */
  readonly authorize: ManagedAuthorize;
}

export interface ManagedHttpServer {
  readonly server: Server;
  listen(port: number, hostname?: string): Promise<void>;
  close(): Promise<void>;
}

export function createManagedHttpServer<TContext = unknown>(
  options: ManagedHttpServerOptions<TContext>,
): ManagedHttpServer {
  const basePath = normalizeBasePath(options.basePath ?? "/v1");
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const openStreams = new Map<ServerResponse, () => void>();
  const server = createServer((request, response) => {
    void route(request, response).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const managed = error instanceof ManagedServerError
        ? error
        : error instanceof SyntaxError
          ? new ManagedInvalidRequestError("request body must be valid JSON")
          : undefined;
      sendJson(
        response,
        managed?.status ?? 500,
        apiError(managed?.code ?? "internal_error", managed?.message ?? messageOf(error)),
      );
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://managed.local");
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      return sendJson(response, 404, apiError("not_found", "route not found"));
    }
    const relative = url.pathname.slice(basePath.length);
    const parts = relative.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method ?? "GET";

    if (method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      await authorize(request, "sessions.create");
      const body = await readJson<CreateManagedSessionRequest>(request, maxBodyBytes);
      return sendJson(response, 201, await options.service.create(body));
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "sessions") {
      await authorize(request, "sessions.list");
      const body: ListManagedSessionsResponse = { data: await options.service.list() };
      return sendJson(response, 200, body);
    }

    if (parts[0] !== "sessions" || parts[1] === undefined) {
      return sendJson(response, 404, apiError("not_found", "route not found"));
    }
    const sessionId = parts[1];

    if (method === "GET" && parts.length === 2) {
      await authorize(request, "sessions.read", sessionId);
      return sendJson(response, 200, await options.service.get(sessionId));
    }
    if (method === "DELETE" && parts.length === 2) {
      await authorize(request, "sessions.delete", sessionId);
      await options.service.delete(sessionId);
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === "POST" && parts[2] === "messages" && parts.length === 3) {
      await authorize(request, "messages.create", sessionId);
      const body = await readJson<CreateManagedMessageRequest>(request, maxBodyBytes);
      if (typeof body.input !== "string" || !body.input.trim()) {
        return sendJson(response, 400, apiError("invalid_request", "input must not be empty"));
      }
      const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
      const receipt = await options.service.appendEvent(sessionId, body, idempotencyKey);
      // Nudge the local worker, if this node has one. Fire-and-forget on purpose: the append
      // already woke the session in the work table, so a failed or skipped nudge costs latency
      // until a claim loop gets to it, never the message. Redundant nudges are free.
      void options.worker?.drain(sessionId).catch(() => undefined);
      return sendJson(response, 202, receipt);
    }
    if (method === "GET" && parts[2] === "events" && parts.length === 3) {
      await authorize(request, "events.list", sessionId);
      let limit: number;
      let requestedOrder: "asc" | "desc" | undefined;
      let cursor: EventPageCursor | undefined;
      try {
        limit = positiveInteger(url.searchParams.get("limit"), 100, 500);
        requestedOrder = eventOrder(url.searchParams.get("order"));
        cursor = decodePage(url.searchParams.get("page"));
      } catch (error) {
        return sendJson(response, 400, apiError("invalid_request", messageOf(error)));
      }
      const requestedAddress = url.searchParams.get("address") ?? undefined;
      if (cursor !== undefined) {
        if (requestedOrder !== undefined && requestedOrder !== cursor.order) {
          return sendJson(response, 400, apiError("invalid_request", "page cursor order does not match order"));
        }
        if (requestedAddress !== undefined && requestedAddress !== cursor.address) {
          return sendJson(response, 400, apiError("invalid_request", "page cursor address does not match address"));
        }
      }
      const order = requestedOrder ?? cursor?.order ?? "asc";
      const address = requestedAddress ?? cursor?.address;
      const page = await options.service.listEvents(sessionId, {
        limit,
        order,
        ...(address !== undefined ? { address } : {}),
        ...(cursor !== undefined ? { after: cursor.sequence } : {}),
      });
      const body: ListSessionEventsResponse = {
        data: page.data,
        nextPage: page.next === undefined ? null : encodePage({ sequence: page.next, order, ...(address !== undefined ? { address } : {}) }),
      };
      return sendJson(response, 200, body);
    }
    if (method === "GET" && parts[2] === "events" && parts[3] === "stream" && parts.length === 4) {
      await authorize(request, "events.stream", sessionId);
      // `Last-Event-ID` is what EventSource sends on its own reconnect; `after` is the same
      // cursor for clients that manage reconnection themselves. The header wins when both are
      // present, since it describes what this connection actually last received.
      const after = singleHeader(request.headers["last-event-id"]) ?? url.searchParams.get("after") ?? undefined;
      return streamEvents(sessionId, url.searchParams.get("address") ?? undefined, after, request, response);
    }
    // Control commands are writes, like messages: the command is journaled and the worker that
    // holds the session — wherever it is — acts on it. 202 here means "durable", not "done".
    if (method === "POST" && parts[2] === "cancel" && parts.length === 3) {
      await authorize(request, "sessions.cancel", sessionId);
      const receipt = await options.service.requestCancel(sessionId);
      void options.worker?.drain(sessionId).catch(() => undefined);
      return sendJson(response, 202, receipt);
    }
    if (method === "GET" && parts[2] === "interruptions" && parts.length === 3) {
      await authorize(request, "interruptions.list", sessionId);
      const body: InterruptionsResponse = { data: await options.service.interruptions(sessionId) };
      return sendJson(response, 200, body);
    }
    if (method === "POST" && parts[2] === "resume" && parts.length === 3) {
      await authorize(request, "sessions.resume", sessionId);
      const body = await readJson<ResumeManagedSessionRequest>(request, maxBodyBytes);
      if (!isRecord(body.answers)) return sendJson(response, 400, apiError("invalid_request", "answers must be an object"));
      const receipt = await options.service.answerInterruption(
        sessionId,
        body.answers as Readonly<Record<string, InterruptAnswer>>,
      );
      void options.worker?.drain(sessionId).catch(() => undefined);
      return sendJson(response, 202, receipt);
    }

    return sendJson(response, 404, apiError("not_found", "route not found"));
  }

  async function streamEvents(
    sessionId: string,
    address: string | undefined,
    after: string | undefined,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Never attaches to a running session: the service backfills from the log and then follows
    // the broadcast channel, so subscribing starts nothing and any replica can serve any
    // session. Whether live-only events (token deltas) appear depends on whether a broadcaster
    // was configured — without one this carries the persisted stream alone.
    const controller = new AbortController();
    const pump = (async () => {
      try {
        for await (const event of options.service.watchEvents(sessionId, {
          ...(address !== undefined ? { address } : {}),
          ...(after !== undefined ? { after } : {}),
          signal: controller.signal,
        })) {
          if (response.destroyed || response.writableEnded) break;
          // `id:` only on events a reconnect can resume from. Per the SSE spec a frame without
          // one leaves the client's last-event-id untouched, so a delta never becomes a cursor
          // that points at nothing in the log.
          const id = isDurableAgentEvent(event) ? event.eventId : undefined;
          // If the transport's own buffer fills, terminate this client rather than letting an
          // unbounded SSE queue turn into memory growth.
          if (!writeSse(response, "session.event", event, id)) {
            response.destroy();
            break;
          }
        }
      } catch {
        if (!response.destroyed) response.destroy();
      }
    })();
    pump.catch(() => undefined);
    response.flushHeaders();
    response.write(": connected\n\n");
    manageStream(request, response, () => controller.abort());
  }

  async function authorize(
    request: IncomingMessage,
    action: ManagedAuthorizationAction,
    sessionId?: string,
  ): Promise<void> {
    const allowed = await options.authorize(request, {
      action,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    if (allowed === false) throw new ManagedForbiddenError();
  }

  function manageStream(request: IncomingMessage, response: ServerResponse, unsubscribe: () => void): void {
    const heartbeat = setInterval(() => {
      if (!response.write(": heartbeat\n\n")) response.destroy();
    }, heartbeatMs);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      openStreams.delete(response);
      if (!response.writableEnded) response.end();
    };
    openStreams.set(response, close);
    request.once("close", close);
    response.once("close", close);
  }

  return {
    server,
    listen: (port, hostname) => new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, hostname, () => {
        server.off("error", onError);
        resolve();
      });
    }),
    close: async () => {
      // End long-lived SSE connections before waiting for Node's server to drain them.
      for (const close of [...openStreams.values()]) close();
      openStreams.clear();
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      await options.worker?.stop();
    },
  };
}

function normalizeBasePath(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  response.end(json);
}

function writeSse(response: ServerResponse, event: string, data: unknown, id?: string): boolean {
  const frame = `${id !== undefined ? `id: ${id.replace(/[\r\n]/g, "")}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return response.write(frame);
}

async function readJson<T>(request: IncomingMessage, maxBytes: number): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new ManagedInvalidRequestError(`request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const header = Array.isArray(value) ? value[0] : value;
  return header?.trim() || undefined;
}

function apiError(code: string, message: string): ManagedApiError {
  return { error: { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface EventPageCursor {
  readonly sequence: string;
  readonly order: "asc" | "desc";
  readonly address?: string;
}

function encodePage(cursor: EventPageCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

function decodePage(value: string | null): EventPageCursor | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed["v"] !== 1 || typeof parsed["sequence"] !== "string" || !/^[1-9]\d*$/.test(parsed["sequence"])) throw new Error();
    if (parsed["order"] !== "asc" && parsed["order"] !== "desc") throw new Error();
    if (parsed["address"] !== undefined && typeof parsed["address"] !== "string") throw new Error();
    return {
      sequence: parsed["sequence"],
      order: parsed["order"],
      ...(typeof parsed["address"] === "string" ? { address: parsed["address"] } : {}),
    };
  } catch {
    throw new Error("invalid event page cursor");
  }
}

function positiveInteger(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`limit must be an integer between 1 and ${String(max)}`);
  }
  return parsed;
}

function eventOrder(value: string | null): "asc" | "desc" | undefined {
  if (value === null) return undefined;
  if (value === "asc" || value === "desc") return value;
  throw new Error("order must be asc or desc");
}
