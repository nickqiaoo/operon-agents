import { retryProviderRequest } from "@earendil-works/pi-ai/utils/provider-retry";

export interface RetryingFetchOptions {
  readonly maxRetries: number;
  readonly maxRetryDelayMs?: number;
}

/** The shape `retryProviderRequest` retries on. An undefined status is a connection failure. */
class AttemptFailure extends Error {
  readonly status: number | undefined;
  readonly headers: Headers | undefined;
  readonly response: Response | undefined;

  constructor(message: string, response: Response | undefined, cause?: unknown) {
    super(message, { cause });
    this.status = response?.status;
    this.headers = response?.headers;
    this.response = response;
  }
}

/**
 * A `fetch` with pi's provider retry policy, for adapters that call `fetch` directly and so never
 * reach `retryProviderRequest` themselves (`mistral-conversations`, as of pi-ai 1.5.0). Remove it
 * when the adapter retries on its own.
 *
 * pi decides what is retryable and how long to wait. A response it gives up on is returned
 * unread, so the adapter reports the failure exactly as it would have without retries.
 *
 * `init.signal` bounds the whole sequence, backoff included, and the options are fixed when the
 * wrapper is built. The request body must be replayable, which a string is.
 */
export function createRetryingFetch(options: RetryingFetchOptions): typeof globalThis.fetch {
  return async (input, init) => {
    let unread: Response | undefined;
    const release = async (): Promise<void> => {
      const response = unread;
      unread = undefined;
      await response?.body?.cancel().catch(() => undefined);
    };

    try {
      return await retryProviderRequest(
        async () => {
          await release();
          const response = await send(input, init);
          if (response.ok) return response;
          unread = response;
          throw new AttemptFailure(`HTTP ${response.status}`, response);
        },
        {
          maxRetries: options.maxRetries,
          ...(options.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof AttemptFailure) {
        if (error.response !== undefined) return error.response;
        throw error.cause;
      }
      await release();
      throw error;
    }
  };
}

async function send(input: Parameters<typeof globalThis.fetch>[0], init: RequestInit | undefined): Promise<Response> {
  try {
    return await globalThis.fetch(input, init);
  } catch (cause) {
    throw new AttemptFailure("connection failed", undefined, cause);
  }
}
