/**
 * Who retries what, against a local HTTP server speaking the real wire formats.
 *
 * A request that never got a response is retried inside the provider call, for Mistral through
 * `createRetryingFetch`. `streamWithRetry` only recovers a response that failed after it started.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { defineModel, streamResult, streamWithRetry, type ChatModel, type ModelSpec } from "../llm/index.ts";
import type { AssistantMessage, Message } from "../protocol/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

type Step = (res: ServerResponse) => void;

const RATE_LIMIT_BODY = '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300","raw_status_code":429}';
const REQUEST: { readonly messages: readonly Message[] } = {
  messages: [{ role: "user", content: "hi", timestamp: 0 } as Message],
};

function chunk(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finishReason }],
  })}\n\n`;
}

const ok = (text: string): Step => (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`${chunk(text)}${chunk("", "stop")}data: [DONE]\n\n`);
};

const status = (code: number, headers: Record<string, string> = {}, body = RATE_LIMIT_BODY): Step => (res) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(body);
};

const rateLimited = (retryAfter = "0"): Step => status(429, { "retry-after": retryAfter });

const dropConnection: Step = (res) => {
  res.socket?.destroy();
};

/** A successful response whose connection dies, after `text` if there is any. */
const dropAfter = (text: string): Step => (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(text.length > 0 ? chunk(text) : ": ping\n\n", () => {
    setTimeout(() => res.socket?.destroy(), 20);
  });
};

interface Harness {
  readonly baseUrl: string;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

/** Plays `steps` in order; the last one repeats for any further request. */
async function serve(steps: readonly Step[]): Promise<Harness> {
  let requests = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const step = steps[Math.min(requests, steps.length - 1)]!;
      requests++;
      step(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function mistralModel(baseUrl: string, connection?: ModelSpec["connection"]): ChatModel {
  return defineModel({ provider: "mistral", model: "codestral-latest", baseUrl, apiKey: "k", ...(connection ? { connection } : {}) });
}

function textOf(message: AssistantMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function streamOnce(model: ChatModel, signal?: AbortSignal): Promise<AssistantMessage> {
  return streamResult(model.stream(REQUEST, signal ? { signal } : undefined));
}

async function withServer(steps: readonly Step[], run: (server: Harness) => Promise<void>): Promise<void> {
  const server = await serve(steps);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

async function testMistralProviderRetry(): Promise<void> {
  await withServer([rateLimited(), rateLimited(), ok("after 429")], async (server) => {
    const message = await streamOnce(mistralModel(server.baseUrl));
    check("mistral: recovers from repeated 429s", message.stopReason === "stop" && textOf(message) === "after 429");
    check("mistral: sent once per attempt", server.requests() === 3);
  });

  await withServer([rateLimited("1"), ok("waited")], async (server) => {
    const started = Date.now();
    const message = await streamOnce(mistralModel(server.baseUrl));
    check("mistral: Retry-After is honored", message.stopReason === "stop" && Date.now() - started >= 950);
  });

  await withServer([rateLimited()], async (server) => {
    const message = await streamOnce(mistralModel(server.baseUrl, { maxRetries: 1 }));
    check("mistral: exhausted retries report the provider's error", message.errorMessage === `Mistral API error (429): ${RATE_LIMIT_BODY}`);
    check("mistral: maxRetries bounds the attempts", server.requests() === 2);
  });

  await withServer([rateLimited()], async (server) => {
    await streamOnce(mistralModel(server.baseUrl, { maxRetries: 0 }));
    check("mistral: maxRetries 0 turns retries off", server.requests() === 1);
  });

  await withServer([status(400, {}, '{"message":"bad request"}')], async (server) => {
    const message = await streamOnce(mistralModel(server.baseUrl));
    check("mistral: a 400 fails at once", server.requests() === 1 && message.errorMessage?.includes("(400)") === true);
  });

  await withServer([rateLimited("120")], async (server) => {
    const message = await streamOnce(mistralModel(server.baseUrl));
    check("mistral: an over-long Retry-After fails at once", server.requests() === 1 && message.errorMessage?.includes("Server requested 120s") === true);
  });

  await withServer([dropConnection, ok("reconnected")], async (server) => {
    const message = await streamOnce(mistralModel(server.baseUrl));
    check("mistral: a connection failure is retried", message.stopReason === "stop" && textOf(message) === "reconnected");
  });

  await withServer([rateLimited("30")], async (server) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const message = await streamOnce(mistralModel(server.baseUrl), controller.signal);
    check("mistral: abort interrupts the backoff", message.stopReason === "aborted" && Date.now() - started < 5_000);
  });
}

async function testSdkProviderRetry(): Promise<void> {
  await withServer([rateLimited(), ok("after sdk 429")], async (server) => {
    const model = defineModel({ provider: "deepseek", model: "deepseek-v4-pro", baseUrl: server.baseUrl, apiKey: "k" });
    const message = await streamOnce(model);
    check("openai-compatible: default retries recover from a 429", message.stopReason === "stop" && textOf(message) === "after sdk 429");
    check("openai-compatible: sent once per attempt", server.requests() === 2);
  });
}

async function testStreamWithRetryScope(): Promise<void> {
  await withServer([rateLimited()], async (server) => {
    const retries: number[] = [];
    const result = await streamWithRetry({
      model: mistralModel(server.baseUrl, { maxRetries: 0 }),
      request: REQUEST,
      onRetrying: (event) => retries.push(event.attempt),
    });
    check("loop: a request that got no response is not retried here", result.stopReason === "error" && retries.length === 0 && server.requests() === 1);
  });

  await withServer([dropAfter(""), ok("second try")], async (server) => {
    let resets = 0;
    const result = await streamWithRetry({
      model: mistralModel(server.baseUrl),
      request: REQUEST,
      onReset: () => resets++,
    });
    check("loop: failure after a 200 with no output is retried", result.stopReason === "stop" && textOf(result.message) === "second try");
    check("loop: nothing to reset when no output was shown", resets === 0);
  });

  await withServer([dropAfter("half an ans"), ok("whole answer")], async (server) => {
    let resets = 0;
    const seen: number[] = [];
    let priorStatus: number | undefined;
    const result = await streamWithRetry({
      model: mistralModel(server.baseUrl),
      request: { ...REQUEST, providerOptions: { onResponse: (response: { status: number }) => { priorStatus = response.status; } } },
      onReset: () => resets++,
      onRetrying: (event) => seen.push(event.attempt),
    });
    check("loop: failure after output recovers", result.stopReason === "stop" && textOf(result.message) === "whole answer");
    check("loop: shown output is reset once", resets === 1 && seen.length === 1);
    check("loop: an existing onResponse still runs", priorStatus === 200);
  });

  const overflow = "prompt is too long: 210012 tokens > 200000 maximum";
  let attempts = 0;
  const failed: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "mistral-conversations",
    provider: "mistral",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: overflow,
    timestamp: 0,
  };
  const model = {
    id: "m",
    stream: () => {
      attempts++;
      const out = createAssistantMessageEventStream();
      queueMicrotask(() => {
        out.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: failed });
        out.push({ type: "error", reason: "error", error: failed });
        out.end(failed);
      });
      return out;
    },
  } as unknown as ChatModel;
  const result = await streamWithRetry({ model, request: REQUEST });
  check("loop: context overflow goes to compaction, not a retry", result.stopReason === "error" && attempts === 1);
}

await testMistralProviderRetry();
await testSdkProviderRetry();
await testStreamWithRetryScope();

const failures = checks.filter(([, passed]) => !passed);
if (failures.length > 0) {
  console.log(`❌ LLM RETRY E2E FAIL — ${failures.length} of ${checks.length}`);
  process.exit(1);
}
console.log(`✅ LLM RETRY E2E PASS — ${checks.length} checks`);
