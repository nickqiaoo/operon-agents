export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly date?: string;
  readonly content?: string;
}

export interface WebSearchOptions {
  readonly limit?: number;
  readonly includeContent?: boolean;
  readonly signal?: AbortSignal;
}

export interface WebSearchProvider {
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
