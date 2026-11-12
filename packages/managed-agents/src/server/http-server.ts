/**
 * The managed HTTP API, shaped after Claude Managed Agents:
 *
 *   POST   /sessions                      create (optionally with `initial_events`)
 *   GET    /sessions                      list
 *   GET    /sessions/{id}                 retrieve
 *   POST   /sessions/{id}                 update
 *   DELETE /sessions/{id}                 delete
 *   POST   /sessions/{id}/archive         archive
 *   POST   /sessions/{id}/events          send events
 *   GET    /sessions/{id}/events          list the event history
 *   GET    /sessions/{id}/events/stream   follow live events (SSE, live-only); repeat
 *                                         `event_deltas[]=agent.message` for live previews
 *
 * Every route is a call on `SessionService`. The server holds no worker and starts no work: an
 * accepted event is persisted, and a worker pulls it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  isManagedPreviewEvent,
  type CreateManagedSessionRequest,
  type ManagedApiError,
  type ManagedPreviewableEventType,
  type SendManagedEventsRequest,
  type UpdateManagedSessionRequest,
} from "../protocol/types.ts";
import {
  ManagedForbiddenError,
  ManagedInvalidRequestError,
  ManagedServerError,
} from "./errors.ts";
import type { SessionService } from "./session-service.ts";

export type ManagedAuthorizationAction =
  | "sessions.create"
  | "sessions.list"
  | "sessions.read"
  | "sessions.update"
  | "sessions.delete"
  | "sessions.archive"
  | "events.send"
  | "events.list"
  | "events.stream";

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

export interface ManagedHttpServerOptions {
  /** Reads and writes of session state. Every route that is not execution goes here. */
  readonly service: SessionService;
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

export function createManagedHttpServer(options: ManagedHttpServerOptions): ManagedHttpServer {
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
        apiError(managed?.code ?? "api_error", managed?.message ?? messageOf(error)),
      );
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://managed.local");
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      return sendJson(response, 404, apiError("not_found_error", "route not found"));
    }
    const relative = url.pathname.slice(basePath.length);
    const parts = relative.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method ?? "GET";
    const service = options.service;

    if (parts[0] !== "sessions") return sendJson(response, 404, apiError("not_found_error", "route not found"));

    if (parts.length === 1) {
      if (method === "POST") {
        await authorize(request, "sessions.create");
        return sendJson(response, 200, await service.create(await readJson<CreateManagedSessionRequest>(request, maxBodyBytes)));
      }
      if (method === "GET") {
        await authorize(request, "sessions.list");
        return sendJson(response, 200, await service.list({
          ...optionalInteger(url, "limit", 1, 1000),
          ...optionalString(url, "page"),
          ...optionalOrder(url),
        }));
      }
      return sendJson(response, 405, apiError("invalid_request_error", "method not allowed"));
    }

    const sessionId = parts[1]!;
    if (parts.length === 2) {
      if (method === "GET") {
        await authorize(request, "sessions.read", sessionId);
        return sendJson(response, 200, await service.retrieve(sessionId));
      }
      if (method === "POST") {
        await authorize(request, "sessions.update", sessionId);
        return sendJson(response, 200, await service.update(sessionId, await readJson<UpdateManagedSessionRequest>(request, maxBodyBytes)));
      }
      if (method === "DELETE") {
        await authorize(request, "sessions.delete", sessionId);
        await service.delete(sessionId);
        return sendJson(response, 200, { id: sessionId, type: "session_deleted" });
      }
    }
    if (parts.length === 3 && parts[2] === "archive" && method === "POST") {
      await authorize(request, "sessions.archive", sessionId);
      return sendJson(response, 200, await service.archive(sessionId));
    }
    if (parts.length === 3 && parts[2] === "events") {
      if (method === "POST") {
        await authorize(request, "events.send", sessionId);
        const body = await readJson<SendManagedEventsRequest>(request, maxBodyBytes);
        const key = singleHeader(request.headers["idempotency-key"]);
        return sendJson(response, 200, await service.sendEvents(sessionId, body, key));
      }
      if (method === "GET") {
        await authorize(request, "events.list", sessionId);
        return sendJson(response, 200, await service.listEvents(sessionId, {
          ...optionalInteger(url, "limit", 1, 1000),
          ...optionalString(url, "page"),
          ...optionalOrder(url),
        }));
      }
    }
    if (parts.length === 4 && parts[2] === "events" && parts[3] === "stream" && method === "GET") {
      await authorize(request, "events.stream", sessionId);
      return streamEvents(sessionId, request, response, eventDeltas(url));
    }
    return sendJson(response, 404, apiError("not_found_error", "route not found"));
  }

  async function streamEvents(
    sessionId: string,
    request: IncomingMessage,
    response: ServerResponse,
    deltas: readonly ManagedPreviewableEventType[],
  ): Promise<void> {
    const controller = new AbortController();
    // Subscribed before the headers go out: a client that sends right after the stream opens
    // cannot lose events to the gap.
    const events = await options.service.stream(sessionId, controller.signal, { eventDeltas: deltas });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    response.write(": connected\n\n");
    manageStream(request, response, () => controller.abort());
    try {
      for await (const event of events) {
        if (response.destroyed || response.writableEnded) break;
        if (!writeSse(response, event.type, event, isManagedPreviewEvent(event) ? undefined : event.id)) {
          response.destroy();
          break;
        }
      }
    } finally {
      controller.abort();
    }
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

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const header = Array.isArray(value) ? value[0] : value;
  return header?.trim() || undefined;
}

function apiError(type: string, message: string): ManagedApiError {
  return { type: "error", error: { type, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalInteger(url: URL, name: string, min: number, max: number): { readonly limit?: number } {
  const value = url.searchParams.get(name);
  if (value === null) return {};
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ManagedInvalidRequestError(`${name} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return { limit: parsed };
}

function optionalString(url: URL, name: "page"): { readonly page?: string } {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? {} : { page: value };
}

const PREVIEWABLE: ReadonlySet<string> = new Set<ManagedPreviewableEventType>(["agent.message", "agent.thinking"]);
const MAX_EVENT_DELTAS = 100;

/** `event_deltas[]`, repeated once per type to preview. Claude's rules: known types, at most 100. */
function eventDeltas(url: URL): ManagedPreviewableEventType[] {
  const values = [...url.searchParams.getAll("event_deltas[]"), ...url.searchParams.getAll("event_deltas")];
  if (values.length > MAX_EVENT_DELTAS) {
    throw new ManagedInvalidRequestError(`event_deltas accepts at most ${String(MAX_EVENT_DELTAS)} values`);
  }
  for (const value of values) {
    if (!PREVIEWABLE.has(value)) {
      throw new ManagedInvalidRequestError(`event_deltas: unsupported value ${JSON.stringify(value)}; expected agent.message or agent.thinking`);
    }
  }
  return [...new Set(values)] as ManagedPreviewableEventType[];
}

function optionalOrder(url: URL): { readonly order?: "asc" | "desc" } {
  const value = url.searchParams.get("order");
  if (value === null) return {};
  if (value === "asc" || value === "desc") return { order: value };
  throw new ManagedInvalidRequestError("order must be asc or desc");
}
