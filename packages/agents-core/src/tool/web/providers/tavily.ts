import {
  WebToolError,
  type UrlFetchOptions,
  type UrlFetchProvider,
  type UrlFetchResult,
  type WebSearchOptions,
  type WebSearchProvider,
  type WebSearchResult,
  type WebSearchSupports,
} from "../types.ts";

export interface TavilyProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Tavily's `search_depth`: `advanced` ranks better and costs more credits. Default: Tavily's. */
  readonly searchDepth?: "basic" | "advanced";
  /** Tavily's `topic`: `news` or `finance` tune the index for those queries. Default: `general`. */
  readonly topic?: "general" | "news" | "finance";
  /** Tavily's `country`: boost results from one country (full English name, e.g. "china"). */
  readonly country?: string;
  /** Tavily's `extract_depth` for WebFetch: `advanced` handles tables and embedded content. */
  readonly extractDepth?: "basic" | "advanced";
}

interface TavilyResultItem {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
  readonly raw_content?: string;
  readonly published_date?: string;
}

export class TavilyProvider implements WebSearchProvider, UrlFetchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly options: TavilyProviderOptions;
  readonly supports: WebSearchSupports = { domains: true, recency: true };

  constructor(options: TavilyProviderOptions) {
    if (!options.apiKey) throw new WebToolError("Tavily provider requires an apiKey.");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.options = options;
  }

  async search(query: string, options?: WebSearchOptions): Promise<readonly WebSearchResult[]> {
    const body: Record<string, unknown> = { query };
    if (options?.limit !== undefined) body.max_results = options.limit;
    if (options?.includeContent === true) body.include_raw_content = true;
    if (options?.domains !== undefined) body.include_domains = options.domains;
    if (options?.recency !== undefined) body.time_range = options.recency;
    if (this.options.searchDepth !== undefined) body.search_depth = this.options.searchDepth;
    if (this.options.topic !== undefined) body.topic = this.options.topic;
    if (this.options.country !== undefined) body.country = this.options.country;

    const json = await this.post<{ results?: TavilyResultItem[] }>("search", body, options?.signal);
    return (json.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "(untitled)",
      url: item.url ?? "",
      snippet: item.content ?? "",
      ...(item.published_date !== undefined ? { date: item.published_date } : {}),
      ...(options?.includeContent === true && item.raw_content !== undefined ? { content: item.raw_content } : {}),
    }));
  }

  async fetch(url: string, options?: UrlFetchOptions): Promise<UrlFetchResult> {
    const json = await this.post<{
      results?: TavilyResultItem[];
      failed_results?: { error?: string }[];
    }>("extract", {
      urls: url, format: "markdown",
      ...(this.options.extractDepth !== undefined ? { extract_depth: this.options.extractDepth } : {}),
    }, options?.signal);
    const page = json.results?.[0];
    if (!page?.raw_content?.trim()) {
      throw new WebToolError(`Tavily extraction failed: ${json.failed_results?.[0]?.error ?? "no page content returned"}`);
    }
    return {
      url: page.url || url, content: page.raw_content, kind: "markdown",
      ...(page.title ? { title: page.title } : {}),
    };
  }

  private async post<T>(endpoint: "search" | "extract", body: object, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new WebToolError(`Tavily request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!res.ok) throw new WebToolError(`Tavily returned HTTP ${res.status} ${res.statusText}.`);

    return (await res.json()) as T;
  }
}
