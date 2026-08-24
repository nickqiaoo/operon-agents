/**
 * Transport + framing for the app-server protocol.
 *
 * - `JsonRpcTransport` is the seam the server and client both sit on, so neither
 *   hardcodes stdio: real processes use `nodeStreamTransport`, tests use
 *   `pairedTransports`.
 * - NDJSON framing: one JSON value per line. `JSON.stringify` never emits a bare
 *   newline, so a line is always one whole message.
 * - `toWireSafe` sanitizes values before they cross the wire (Error → plain
 *   object, circular refs / functions / undefined dropped) so a stray `error.cause`
 *   or a tool display can't crash serialization.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isGuardrailTripwireError } from "operon-agents-core";
import {
  ErrorCode,
  type JsonRpcErrorBody,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
} from "./protocol.ts";

export interface JsonRpcTransport {
  /** Queue a message for delivery (respects backpressure internally). */
  send(message: JsonRpcMessage): void;
  /** Inbound messages, in order, until the peer closes. Consume once. */
  incoming(): AsyncIterable<JsonRpcMessage>;
  /** Stop reading/writing and release resources. */
  close(): void;
}

// ── Message classification (shared by both ends) ─────────────────────────────

export type ClassifiedMessage =
  | { readonly kind: "request"; readonly message: JsonRpcRequest }
  | { readonly kind: "response"; readonly message: JsonRpcResponse }
  | { readonly kind: "notification"; readonly message: JsonRpcNotification }
  | { readonly kind: "invalid"; readonly raw: unknown };

export function classify(raw: unknown): ClassifiedMessage {
  if (typeof raw !== "object" || raw === null) return { kind: "invalid", raw };
  const m = raw as Record<string, unknown>;
  const hasId = "id" in m && (typeof m.id === "string" || typeof m.id === "number");
  const hasMethod = typeof m.method === "string";
  const hasResult = "result" in m;
  const hasError = "error" in m;
  if (hasMethod && hasId) return { kind: "request", message: raw as JsonRpcRequest };
  if (hasMethod) return { kind: "notification", message: raw as JsonRpcNotification };
  if (hasId && (hasResult || hasError)) return { kind: "response", message: raw as JsonRpcResponse };
  return { kind: "invalid", raw };
}

export function isFailure(response: JsonRpcResponse): response is JsonRpcFailure {
  return "error" in response;
}

// ── Envelope builders ────────────────────────────────────────────────────────

export function request(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
}
export function notification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}
export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result: result === undefined ? null : result };
}
export function failure(id: JsonRpcId, error: JsonRpcErrorBody): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error };
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
  toBody(): JsonRpcErrorBody {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: toWireSafe(this.data) };
  }
}

/** Map any thrown value to a JSON-RPC error body. */
export function errorToBody(error: unknown): JsonRpcErrorBody {
  if (error instanceof RpcError) return error.toBody();
  // A guardrail tripwire is a policy block, not an internal failure — give it a distinct code
  // and structured data so the host can distinguish it (and locate the run) from a crash.
  if (isGuardrailTripwireError(error)) {
    return {
      code: ErrorCode.GuardrailBlocked,
      message: error.message,
      data: toWireSafe({
        stage: error.stage,
        guardrail: error.guardrailName,
        agent: error.agentName,
        sessionId: error.sessionId,
        address: error.address,
      }),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: ErrorCode.InternalError, message };
}

// ── Wire-safe serialization ──────────────────────────────────────────────────

const MAX_DEPTH = 64;

/** Recursively coerce a value into something `JSON.stringify` can handle without
 *  throwing or leaking host objects: Error → plain object, circular refs and
 *  functions/symbols/undefined dropped, depth bounded. */
export function toWireSafe(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") return Number.isFinite(value as number) ? value : null;
  if (t === "bigint") return (value as bigint).toString();
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const out = value.map((v) => {
      const safe = toWireSafe(v, seen, depth + 1);
      return safe === undefined ? null : safe;
    });
    seen.delete(value);
    return out;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return undefined;
    // Honor toJSON (Date, etc.) before generic object walking.
    const maybe = obj as { toJSON?: () => unknown };
    if (typeof maybe.toJSON === "function") return toWireSafe(maybe.toJSON(), seen, depth + 1);
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const safe = toWireSafe(obj[key], seen, depth + 1);
      if (safe !== undefined) out[key] = safe;
    }
    seen.delete(obj);
    return out;
  }
  return undefined;
}

export function encode(message: JsonRpcMessage): string {
  return `${JSON.stringify(toWireSafe(message))}\n`;
}

// ── A minimal async queue (single producer / single consumer) ────────────────

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const next = this.buffer.shift();
        if (next !== undefined) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// ── Node stdio transport ─────────────────────────────────────────────────────

/** NDJSON JSON-RPC over a Readable/Writable pair (e.g. a child's stdout/stdin, or
 *  this process's stdin/stdout). Malformed lines are dropped with an onError hook. */
export function nodeStreamTransport(
  input: Readable,
  output: Writable,
  opts: { readonly onParseError?: (line: string, error: unknown) => void } = {},
): JsonRpcTransport {
  const queue = new AsyncQueue<JsonRpcMessage>();
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      opts.onParseError?.(trimmed, error);
      return;
    }
    queue.push(parsed as JsonRpcMessage);
  });
  rl.once("close", () => queue.close());
  input.once("error", () => queue.close());

  // Serialize writes; respect backpressure by chaining on `drain`.
  let writeChain: Promise<void> = Promise.resolve();
  let closed = false;
  const writeLine = (text: string): void => {
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          if (closed || output.writableEnded) return resolve();
          const ok = output.write(text);
          if (ok) resolve();
          else output.once("drain", () => resolve());
        }),
    );
  };

  return {
    send(message: JsonRpcMessage): void {
      writeLine(encode(message));
    },
    incoming(): AsyncIterable<JsonRpcMessage> {
      return queue;
    },
    close(): void {
      closed = true;
      rl.close();
      queue.close();
    },
  };
}

// ── Paired in-memory transports (for tests / embedding) ──────────────────────

/** Two transports wired back-to-back: what `a` sends, `b` receives, and vice
 *  versa. Messages still round-trip through `toWireSafe` so tests exercise the
 *  same serialization path as real stdio. */
export function pairedTransports(): readonly [JsonRpcTransport, JsonRpcTransport] {
  const aIn = new AsyncQueue<JsonRpcMessage>();
  const bIn = new AsyncQueue<JsonRpcMessage>();
  const hop = (message: JsonRpcMessage): JsonRpcMessage => JSON.parse(JSON.stringify(toWireSafe(message))) as JsonRpcMessage;

  const a: JsonRpcTransport = {
    send: (m) => bIn.push(hop(m)),
    incoming: () => aIn,
    close: () => {
      aIn.close();
      bIn.close();
    },
  };
  const b: JsonRpcTransport = {
    send: (m) => aIn.push(hop(m)),
    incoming: () => bIn,
    close: () => {
      aIn.close();
      bIn.close();
    },
  };
  return [a, b] as const;
}
