/**
 * Who retries what, against a local HTTP server speaking the real wire formats.
 *
 * pi's retries are off, so `streamWithRetry` owns both kinds: a request that never got a response,
 * on its own budget and reporting each wait, and a response that failed after it started.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { completeWithRetry, createModelManager, streamWithRetry, type ChatModel, type ModelSpec } from "../llm/index.ts";
import type { StepRetryingEvent } from "../llm/index.ts";
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

function modelAt(id: string, baseUrl: string, connection?: ModelSpec["connection"]): ChatModel {
  const manager = createModelManager();
  manager.register({ id: id.slice(0, id.indexOf("/")), baseUrl, apiKey: "k" });
  return manager.resolve(id, connection ? { connection } : {});
}

function mistralModel(baseUrl: string, connection?: ModelSpec["connection"]): ChatModel {
  return modelAt("mistral/codestral-latest", baseUrl, connection);
}

function textOf(message: AssistantMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Backoff capped at 20ms, so the retries a test needs do not cost it seconds. */
const FAST: NonNullable<ModelSpec["connection"]> = { maxRetryDelayMs: 20 };

interface Retried {
  readonly message: AssistantMessage;
  readonly waits: readonly StepRetryingEvent[];
}

async function run(model: ChatModel, signal?: AbortSignal): Promise<Retried> {
  const waits: StepRetryingEvent[] = [];
  const { message } = await streamWithRetry({
    model,
    request: REQUEST,
    ...(signal ? { call: { signal } } : {}),
    onRetrying: (event) => waits.push(event),
  });
  return { message, waits };
}

async function withServer(steps: readonly Step[], run: (server: Harness) => Promise<void>): Promise<void> {
  const server = await serve(steps);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function deepseekModel(baseUrl: string, connection: ModelSpec["connection"] = FAST): ChatModel {
  return modelAt("deepseek/deepseek-v4-pro", baseUrl, connection);
}

const quotaExhausted: Step = status(429, {}, '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}');

async function testRequestRetries(): Promise<void> {
  await withServer([rateLimited(), rateLimited(), ok("after 429")], async (server) => {
    const { message, waits } = await run(mistralModel(server.baseUrl, FAST));
    check("mistral: recovers from repeated 429s", message.stopReason === "stop" && textOf(message) === "after 429");
    check("mistral: pi does not retry underneath", server.requests() === 3);
    check("each wait is reported", waits.length === 2 && waits[0]!.attempt === 1 && waits[1]!.attempt === 2 && waits[0]!.maxAttempts === 10);
  });

  await withServer([rateLimited(), ok("after sdk 429")], async (server) => {
    const { message, waits } = await run(deepseekModel(server.baseUrl));
    check("openai-compatible: recovers from a 429", message.stopReason === "stop" && textOf(message) === "after sdk 429");
    check("openai-compatible: pi does not retry underneath", server.requests() === 2 && waits.length === 1);
  });

  await withServer([rateLimited()], async (server) => {
    const { message, waits } = await run(mistralModel(server.baseUrl, { ...FAST, maxRetries: 1 }));
    check("exhausted retries report the provider's error", message.errorMessage === `Mistral API error (429): ${RATE_LIMIT_BODY}`);
    check("maxRetries bounds the attempts", server.requests() === 2 && waits.length === 1);
  });

  await withServer([rateLimited()], async (server) => {
    await run(mistralModel(server.baseUrl, { maxRetries: 0 }));
    check("maxRetries 0 turns retries off", server.requests() === 1);
  });

  await withServer([status(400, {}, '{"message":"bad request"}')], async (server) => {
    const { message, waits } = await run(mistralModel(server.baseUrl));
    check("a 400 fails at once", server.requests() === 1 && waits.length === 0 && message.errorMessage?.includes("(400)") === true);
  });

  await withServer([status(503, {}, '{"message":"no"}'), ok("after 503")], async (server) => {
    check("a 5xx is retried", textOf((await run(deepseekModel(server.baseUrl))).message) === "after 503");
  });

  await withServer([dropConnection, ok("reconnected")], async (server) => {
    check("a connection failure is retried", textOf((await run(mistralModel(server.baseUrl, FAST))).message) === "reconnected");
  });

  await withServer([quotaExhausted], async (server) => {
    const { waits } = await run(deepseekModel(server.baseUrl));
    check("exhausted quota is a 429 that is not waited on", server.requests() === 1 && waits.length === 0);
  });

  await withServer([status(500, { "x-should-retry": "false" }, "{}")], async (server) => {
    await run(deepseekModel(server.baseUrl));
    check("x-should-retry: false is obeyed", server.requests() === 1);
  });
}

async function testWaits(): Promise<void> {
  await withServer([rateLimited("1"), ok("waited")], async (server) => {
    const started = Date.now();
    const { message, waits } = await run(mistralModel(server.baseUrl));
    check("Retry-After sets the wait", message.stopReason === "stop" && Date.now() - started >= 950 && waits[0]!.delayMs >= 1_000 && waits[0]!.delayMs < 2_100);
  });

  await withServer([rateLimited("90"), ok("late")], async (server) => {
    const controller = new AbortController();
    const seen: number[] = [];
    const running = streamWithRetry({
      model: deepseekModel(server.baseUrl, {}),
      request: REQUEST,
      call: { signal: controller.signal },
      onRetrying: (event) => {
        seen.push(event.delayMs);
        controller.abort();
      },
    }).catch(() => undefined);
    await running;
    check("a Retry-After past pi's old 60s limit is waited for", seen.length === 1 && seen[0]! >= 90_000 && seen[0]! < 91_100);
  });

  await withServer([rateLimited("400")], async (server) => {
    const { message, waits } = await run(mistralModel(server.baseUrl));
    check("a Retry-After past the 5 minute cap fails at once", server.requests() === 1 && waits.length === 0 && message.stopReason === "error");
  });

  const firstDelay = async (headers: Record<string, string>): Promise<number | undefined> => {
    let delay: number | undefined;
    await withServer([status(429, headers), ok("x")], async (server) => {
      const controller = new AbortController();
      await streamWithRetry({
        model: deepseekModel(server.baseUrl, {}),
        request: REQUEST,
        call: { signal: controller.signal },
        onRetrying: (event) => {
          delay = event.delayMs;
          controller.abort();
        },
      }).catch(() => undefined);
    });
    return delay;
  };

  const openaiReset = await firstDelay({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "1m30s", "x-ratelimit-remaining-requests": "5", "x-ratelimit-reset-requests": "1h" });
  check("the exhausted OpenAI limit's reset sets the wait", openaiReset !== undefined && openaiReset >= 90_000 && openaiReset < 91_100);

  const anthropicReset = await firstDelay({ "anthropic-ratelimit-input-tokens-remaining": "0", "anthropic-ratelimit-input-tokens-reset": new Date(Date.now() + 40_000).toISOString() });
  check("the exhausted Anthropic limit's reset sets the wait", anthropicReset !== undefined && anthropicReset > 30_000 && anthropicReset < 41_100);

  const noHint = await firstDelay({});
  check("without a hint the first wait is about a second", noHint !== undefined && noHint >= 750 && noHint <= 1_000);

  const zeroHint = await firstDelay({ "retry-after": "0" });
  check("Retry-After: 0 falls back to backoff", zeroHint !== undefined && zeroHint >= 750 && zeroHint <= 1_000);

  await withServer([rateLimited("30")], async (server) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const failure = await run(mistralModel(server.baseUrl), controller.signal).catch((error: unknown) => error);
    check("abort interrupts the wait", failure instanceof Error && failure.name === "AbortError" && Date.now() - started < 5_000);
  });
}

async function testCompleteWithRetry(): Promise<void> {
  await withServer([rateLimited(), ok("completed")], async (server) => {
    const message = await completeWithRetry(deepseekModel(server.baseUrl), REQUEST);
    check("complete: recovers from a 429", textOf(message) === "completed" && server.requests() === 2);
  });

  await withServer([rateLimited()], async (server) => {
    await completeWithRetry(deepseekModel(server.baseUrl), REQUEST, undefined, { maxRetries: 2 });
    check("complete: a caller's policy overrides the model's", server.requests() === 3);
  });
}

async function testStreamWithRetryScope(): Promise<void> {
  await withServer([rateLimited()], async (server) => {
    const { waits } = await run(mistralModel(server.baseUrl, { ...FAST, maxRetries: 2 }));
    check("loop: maxRetries sets the request budget alone", waits.length === 2 && waits.at(-1)!.maxAttempts === 2);
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

await testRequestRetries();
await testWaits();
await testCompleteWithRetry();
await testStreamWithRetryScope();

const failures = checks.filter(([, passed]) => !passed);
if (failures.length > 0) {
  console.log(`❌ LLM RETRY E2E FAIL — ${failures.length} of ${checks.length}`);
  process.exit(1);
}
console.log(`✅ LLM RETRY E2E PASS — ${checks.length} checks`);
