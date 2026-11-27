export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly date?: string;
  readonly content?: string;
}

export type WebSearchRecency = "day" | "week" | "month" | "year";

export interface WebSearchOptions {
  readonly limit?: number;
  readonly includeContent?: boolean;
  /**
   * Only results from these hosts; a host also matches its subdomains. Passed only to a provider
   * whose `supports.domains` is true — for any other, WebSearch filters the results itself.
   */
  readonly domains?: readonly string[];
  /**
   * Only results published within this window. Passed only to a provider whose `supports.recency`
   * is true — for any other, WebSearch filters the results by their `date` itself.
   */
  readonly recency?: WebSearchRecency;
  readonly signal?: AbortSignal;
}

/** Filters a search provider applies on its own side, so WebSearch need not emulate them. */
export interface WebSearchSupports {
  readonly domains?: boolean;
  readonly recency?: boolean;
}

/**
 * A search backend. WebSearch's parameters are the same whichever provider runs it: a filter the
 * provider cannot apply is still honoured, by WebSearch filtering what comes back and telling the
 * model it did. Provider-specific knobs (depth, topic, region…) belong in the provider's own
 * constructor options — the host's choice, not the model's.
 */
export interface WebSearchProvider {
  readonly supports?: WebSearchSupports;
  search(query: string, options?: WebSearchOptions): Promise<readonly WebSearchResult[]>;
}

export interface UrlFetchResult {
  /**
   * The URL the content actually came from. Not necessarily the one that was requested — a
   * fetch may follow redirects, and reporting the original would hide where the bytes are
   * really from, which is exactly what makes an open redirect useful to an attacker.
   */
  readonly url: string;
  readonly content: string;
  readonly kind: "markdown" | "text" | "html";
  readonly title?: string;
}

export interface UrlFetchOptions {
  readonly maxBytes?: number;
  /** Deadline for the whole fetch, redirects included. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface UrlFetchProvider {
  fetch(url: string, options?: UrlFetchOptions): Promise<UrlFetchResult>;
}

export class WebToolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebToolError";
  }
}
