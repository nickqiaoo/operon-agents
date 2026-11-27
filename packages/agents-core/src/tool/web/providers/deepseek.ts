import { z } from "zod";
import { WebToolError, type UrlFetchOptions, type UrlFetchProvider, type UrlFetchResult, type WebSearchOptions, type WebSearchProvider, type WebSearchResult } from "../types.ts";

const searchResponse = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    content: z.string(),
    date: z.string().nullable(),
  })),
});
const fetchResponse = z.object({ title: z.string(), content: z.string().min(1) });

export interface DeepSeekWebProviderOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

/** DeepSeek's hosted search and page-reading tools (`/v1/tools/search`, `/v1/tools/fetch`). */
export class DeepSeekWebProvider implements WebSearchProvider, UrlFetchProvider {
  /** DeepSeek's search takes no site or date filter; WebSearch applies both to its results. */
  readonly supports = { domains: false, recency: false };
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekWebProviderOptions) {
    if (!options.apiKey.trim()) throw new WebToolError("DeepSeek requires an API key.");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    if (!query.trim() || Array.from(query).length > 128) throw new WebToolError("DeepSeek queries must contain 1 to 128 characters.");
    const data = searchResponse.parse(await this.post("search", {
      query,
      count: options?.limit ?? 5,
      need_content: options?.includeContent ?? false,
    }, options?.signal));
    return data.results.map(({ title, url, snippet, content, date }) => ({
      title,
      url,
      snippet,
      ...(content ? { content } : {}),
      ...(date ? { date } : {}),
    }));
  }

  async fetch(url: string, options?: UrlFetchOptions): Promise<UrlFetchResult> {
    const address = new URL(url);
    if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || url.length > 8192) {
      throw new WebToolError("DeepSeek requires an HTTP or HTTPS URL without embedded credentials, up to 8192 characters.");
    }
    const page = fetchResponse.parse(await this.post("fetch", { url }, options?.signal));
    return { ...page, url, kind: "markdown" };
  }

  private async post(endpoint: "search" | "fetch", body: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.deepseek.com/v1/tools/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) throw new WebToolError(`DeepSeek ${endpoint} returned HTTP ${response.status}.`);
    return response.json();
  }
}
