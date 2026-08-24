import {
  WebToolError,
  type WebSearchOptions,
  type WebSearchProvider,
  type WebSearchResult,
} from "../types.ts";

export interface TavilyProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface TavilyResultItem {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
  readonly raw_content?: string;
  readonly published_date?: string;
}

export class TavilySearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TavilyProviderOptions) {
    if (!options.apiKey) throw new WebToolError("Tavily provider requires an apiKey.");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: string, options?: WebSearchOptions): Promise<readonly WebSearchResult[]> {
    const body: Record<string, unknown> = { api_key: this.apiKey, query };
    if (options?.limit !== undefined) body.max_results = options.limit;
    if (options?.includeContent === true) body.include_raw_content = true;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
    } catch (error) {
      throw new WebToolError(`Tavily request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!res.ok) throw new WebToolError(`Tavily returned HTTP ${res.status} ${res.statusText}.`);

    const json = (await res.json()) as { results?: TavilyResultItem[] };
    return (json.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "(untitled)",
      url: item.url ?? "",
      snippet: item.content ?? "",
      ...(item.published_date !== undefined ? { date: item.published_date } : {}),
      ...(options?.includeContent === true && item.raw_content !== undefined ? { content: item.raw_content } : {}),
    }));
  }
}
