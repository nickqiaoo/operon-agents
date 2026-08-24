import {
  WebToolError,
  type UrlFetchOptions,
  type UrlFetchProvider,
  type UrlFetchResult,
  type WebSearchOptions,
  type WebSearchProvider,
  type WebSearchResult,
} from "../types.ts";

export interface FirecrawlProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface FirecrawlSearchItem {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string;
  readonly markdown?: string;
}
interface FirecrawlScrapeData {
  readonly markdown?: string;
  readonly metadata?: { readonly title?: string };
}

export class FirecrawlProvider implements WebSearchProvider, UrlFetchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FirecrawlProviderOptions) {
    if (!options.apiKey) throw new WebToolError("Firecrawl provider requires an apiKey.");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.firecrawl.dev").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: string, options?: WebSearchOptions): Promise<readonly WebSearchResult[]> {
    const body: Record<string, unknown> = { query };
    if (options?.limit !== undefined) body.limit = options.limit;
    if (options?.includeContent === true) body.scrapeOptions = { formats: ["markdown"] };
    const json = await this.post<{ data?: FirecrawlSearchItem[] }>("/v1/search", body, options?.signal);
    return (json.data ?? []).map((item) => ({
      title: item.title ?? item.url ?? "(untitled)",
      url: item.url ?? "",
      snippet: item.description ?? "",
      ...(item.markdown !== undefined ? { content: item.markdown } : {}),
    }));
  }

  async fetch(url: string, options?: UrlFetchOptions): Promise<UrlFetchResult> {
    const json = await this.post<{ data?: FirecrawlScrapeData }>("/v1/scrape", { url, formats: ["markdown"] }, options?.signal);
    const markdown = json.data?.markdown;
    if (markdown === undefined || markdown.length === 0) {
      throw new WebToolError(`Firecrawl returned no content for ${url}.`);
    }
    return {
      url,
      content: markdown,
      kind: "markdown",
      ...(json.data?.metadata?.title !== undefined ? { title: json.data.metadata.title } : {}),
    };
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new WebToolError(`Firecrawl request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!res.ok) {
      throw new WebToolError(`Firecrawl returned HTTP ${res.status} ${res.statusText}.`);
    }
    return (await res.json()) as T;
  }
}
