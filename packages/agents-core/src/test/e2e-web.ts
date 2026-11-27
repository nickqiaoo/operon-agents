import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalEnvironment,
  webSearchTool,
  webFetchTool,
  FirecrawlProvider,
  TavilyProvider,
  DirectFetchProvider,
  WebToolError,
  type Tool,
  type ToolResult,
  type WebSearchProvider,
  type UrlFetchProvider,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

async function runTool(tool: Tool, args: unknown, environment: LocalEnvironment): Promise<ToolResult> {
  const ctx = { turnId: "t", toolCallId: "tc", signal: new AbortController().signal, environment };
  const plan = await tool.resolve(args, ctx);
  return plan.run(ctx);
}

function fakeFetch(body: string, init?: { status?: number; contentType?: string }): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init?.status ?? 200,
      headers: { "content-type": init?.contentType ?? "application/json" },
    })) as unknown as typeof fetch;
}

async function testToolFormatting(environment: LocalEnvironment): Promise<void> {
  const search: WebSearchProvider = {
    async search() {
      return [
        { title: "Result A", url: "https://a.example", snippet: "snippet a", date: "2026-01-01" },
        { title: "Result B", url: "https://b.example", snippet: "snippet b" },
      ];
    },
  };
  const out = textOf(await runTool(webSearchTool(search), { query: "hello world" }, environment));
  check("websearch: formats ranked results", out.includes("Title: Result A") && out.includes("URL: https://b.example") && out.includes("---"));
  check("websearch: includes date when present", out.includes("Date: 2026-01-01"));

  const day = 24 * 60 * 60 * 1000;
  const mixed = [
    { title: "Docs", url: "https://docs.python.org/3/x", snippet: "s", date: new Date(Date.now() - day).toISOString() },
    { title: "Blog", url: "https://blog.example/post", snippet: "s", date: new Date(Date.now() - 400 * day).toISOString() },
    { title: "Old docs", url: "https://python.org/old", snippet: "s", date: new Date(Date.now() - 400 * day).toISOString() },
    { title: "Undated", url: "https://www.python.org/u", snippet: "s" },
  ];
  let seen: Parameters<WebSearchProvider["search"]>[1];
  const plain: WebSearchProvider = { async search(_q, options) { seen = options; return mixed; } };
  const dout = textOf(await runTool(webSearchTool(plain), { query: "q", domains: ["https://Python.org/"] }, environment));
  check("websearch: emulated domains keep the site and its subdomains only",
    dout.includes("Docs") && dout.includes("Old docs") && dout.includes("Undated") && !dout.includes("Blog"));
  check("websearch: emulated filter is disclosed and not passed down", dout.includes("cannot restrict sites") && seen?.domains === undefined && seen?.limit === 15);
  const rout = textOf(await runTool(webSearchTool(plain), { query: "q", recency: "month" }, environment));
  check("websearch: emulated recency drops old results, keeps undated", rout.includes("Docs") && rout.includes("Undated") && !rout.includes("Blog") && !rout.includes("Old docs"));
  check("websearch: emulated recency says undated were kept", rout.includes("cannot filter by date") && rout.includes("1 without a date"));

  const native: WebSearchProvider = { supports: { domains: true, recency: true }, async search(_q, options) { seen = options; return mixed; } };
  const nout = textOf(await runTool(webSearchTool(native), { query: "q", domains: ["python.org"], recency: "week", limit: 2 }, environment));
  check("websearch: native filters are passed down without a note", seen?.domains?.[0] === "python.org" && seen?.recency === "week" && seen?.limit === 2 && !nout.includes("Note:"));
  check("websearch: domains are enforced even when native", !nout.includes("Blog"));

  const empty: WebSearchProvider = { async search() { return []; } };
  check("websearch: empty → friendly message", textOf(await runTool(webSearchTool(empty), { query: "x" }, environment)).includes("No search results"));

  const fetcher: UrlFetchProvider = {
    async fetch(url) {
      return { url, content: "# Page\n\nbody text", kind: "markdown", title: "Page Title" };
    },
  };
  const fout = textOf(await runTool(webFetchTool(fetcher), { url: "https://a.example/p" }, environment));
  check("fetchurl: renders title + url + body", fout.includes("# Page Title") && fout.includes("https://a.example/p") && fout.includes("body text"));

  const longFetcher: UrlFetchProvider = {
    async fetch(url) { return { url, content: "x".repeat(100), kind: "text" }; },
  };
  const tout = textOf(await runTool(webFetchTool(longFetcher), { url: "https://a.example/long", max_length: 10 }, environment));
  check("fetchurl: truncates to max_length and says where to continue",
    tout.includes("x".repeat(10)) && !tout.includes("x".repeat(11)) && tout.includes("of 100") && tout.includes("offset=10"));

  let fetches = 0;
  const paged: UrlFetchProvider = {
    async fetch(url) { fetches++; return { url, content: "a".repeat(30) + "b".repeat(30) + "c".repeat(40), kind: "text" }; },
  };
  const pagedTool = webFetchTool(paged);
  const p1 = textOf(await runTool(pagedTool, { url: "https://a.example/paged", max_length: 30 }, environment));
  const p2 = textOf(await runTool(pagedTool, { url: "https://a.example/paged", max_length: 30, offset: 30 }, environment));
  const p3 = textOf(await runTool(pagedTool, { url: "https://a.example/paged", offset: 60 }, environment));
  check("fetchurl: offset pages through the body", p1.includes("a".repeat(30)) && !p1.includes("bb") && p2.includes("b".repeat(30)) && !p2.includes("aa") && p2.includes("offset=60"));
  check("fetchurl: last page says it is the end", p3.includes("c".repeat(40)) && p3.includes("end of the page"));
  check("fetchurl: pages come from one cached fetch", fetches === 1);
  const past = textOf(await runTool(pagedTool, { url: "https://a.example/paged", offset: 500 }, environment));
  check("fetchurl: offset past the end → explains the page length", past.includes("past the end") && past.includes("100 characters"));

  let flaky = 0;
  const flakyTool = webFetchTool({ async fetch(url) { if (flaky++ === 0) throw new WebToolError("first fails"); return { url, content: "ok", kind: "text" }; } });
  await runTool(flakyTool, { url: "https://a.example/flaky" }, environment);
  check("fetchurl: a failed fetch is not cached", textOf(await runTool(flakyTool, { url: "https://a.example/flaky" }, environment)).includes("ok"));

  const uncached = webFetchTool(paged, { cacheTtlMs: 0 });
  fetches = 0;
  await runTool(uncached, { url: "https://a.example/paged" }, environment);
  await runTool(uncached, { url: "https://a.example/paged" }, environment);
  check("fetchurl: cacheTtlMs 0 fetches every time", fetches === 2);

  const failing: UrlFetchProvider = {
    async fetch() { throw new WebToolError("upstream exploded"); },
  };
  const eout = await runTool(webFetchTool(failing), { url: "https://a.example/err" }, environment);
  check("fetchurl: provider error → isError + message", (eout.isError ?? false) && textOf(eout).includes("upstream exploded"));
}

async function testFirecrawl(): Promise<void> {
  const searchBody = JSON.stringify({ data: [{ title: "FC", url: "https://fc.example", description: "desc", markdown: "full md" }] });
  const fc = new FirecrawlProvider({ apiKey: "k", fetchImpl: fakeFetch(searchBody) });
  const results = await fc.search("q", { includeContent: true });
  check("firecrawl: maps /v1/search result", results[0]?.title === "FC" && results[0]?.url === "https://fc.example" && results[0]?.snippet === "desc" && results[0]?.content === "full md");

  const scrapeBody = JSON.stringify({ data: { markdown: "scraped body", metadata: { title: "Scraped" } } });
  const fc2 = new FirecrawlProvider({ apiKey: "k", fetchImpl: fakeFetch(scrapeBody) });
  const fetched = await fc2.fetch("https://fc.example/page");
  check("firecrawl: maps /v1/scrape markdown + title", fetched.content === "scraped body" && fetched.title === "Scraped" && fetched.kind === "markdown");

  let fcBody: Record<string, unknown> = {};
  const fcFiltered = new FirecrawlProvider({ apiKey: "k", location: "Germany", fetchImpl: async (_u, init) => {
    fcBody = JSON.parse(String(init?.body));
    return Response.json({ data: [] });
  } });
  await fcFiltered.search("rust async", { domains: ["a.example", "b.example"], recency: "day" });
  check("firecrawl: domains become site: operators, recency becomes tbs",
    fcBody.query === "rust async (site:a.example OR site:b.example)" && fcBody.tbs === "qdr:d" && fcBody.location === "Germany");

  const errProvider = new FirecrawlProvider({ apiKey: "k", fetchImpl: fakeFetch("{}", { status: 402 }) });
  let threw = false;
  try { await errProvider.search("q"); } catch (e) { threw = e instanceof WebToolError; }
  check("firecrawl: non-2xx → WebToolError", threw);
}

async function testTavily(): Promise<void> {
  const body = JSON.stringify({ results: [{ title: "TV", url: "https://tv.example", content: "tv snippet", published_date: "2025-12-01", raw_content: "raw" }] });
  const tv = new TavilyProvider({ apiKey: "k", fetchImpl: fakeFetch(body) });
  const results = await tv.search("q", { includeContent: true });
  let tavilyBody: Record<string, unknown> = {};
  const tvFiltered = new TavilyProvider({ apiKey: "k", searchDepth: "advanced", topic: "news", fetchImpl: async (_u, init) => {
    tavilyBody = JSON.parse(String(init?.body));
    return Response.json({ results: [] });
  } });
  await tvFiltered.search("q", { domains: ["a.example"], recency: "week" });
  check("tavily: domains/recency/options map to include_domains/time_range/search_depth/topic",
    (tavilyBody.include_domains as string[])[0] === "a.example" && tavilyBody.time_range === "week" &&
    tavilyBody.search_depth === "advanced" && tavilyBody.topic === "news");
  check("tavily: search tells WebSearch it filters natively", tvFiltered.supports.domains === true && tvFiltered.supports.recency === true);
  check("tavily: maps /search result + date + raw_content", results[0]?.title === "TV" && results[0]?.snippet === "tv snippet" && results[0]?.date === "2025-12-01" && results[0]?.content === "raw");

  const url = "https://tv.example/page";
  const extract = new TavilyProvider({ apiKey: "k", fetchImpl: async (endpoint, init) => {
    check("tavily: POST /extract with shared key", endpoint === "https://api.tavily.com/extract" &&
      init?.method === "POST" && new Headers(init.headers).get("authorization") === "Bearer k");
    const request = JSON.parse(String(init?.body));
    check("tavily: requests a single page as markdown", request.urls === url && request.format === "markdown");
    return Response.json({ results: [{ url, raw_content: "# Page" }], failed_results: [] });
  } });
  const page = await extract.fetch(url);
  check("tavily: maps extracted markdown", page.url === url && page.kind === "markdown" && page.content === "# Page");

  const failed = new TavilyProvider({ apiKey: "k", fetchImpl: fakeFetch(JSON.stringify({
    results: [], failed_results: [{ url, error: "Page unavailable" }],
  })) });
  let failure: unknown;
  try { await failed.fetch(url); } catch (error) { failure = error; }
  check("tavily: surfaces per-page failure on HTTP 200", failure instanceof WebToolError && failure.message.includes("Page unavailable"));
}

async function testDirectFetch(): Promise<void> {
  // SSRF guard: private/loopback/link-local hosts rejected statically (fetchImpl never called).
  let called = false;
  const spyFetch = (async () => { called = true; return new Response("x"); }) as unknown as typeof fetch;
  const guarded = new DirectFetchProvider({ fetchImpl: spyFetch });
  for (const bad of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8080/", "http://192.168.0.1/", "http://localhost/x"]) {
    let blocked = false;
    try { await guarded.fetch(bad); } catch (e) { blocked = e instanceof WebToolError; }
    check(`directfetch: SSRF guard blocks ${bad}`, blocked);
  }
  check("directfetch: blocked targets never hit the network", !called);

  // HTML extraction.
  const html = "<html><head><title>My Page</title><style>x{}</style></head><body><script>bad()</script><h1>Heading</h1><p>Hello&nbsp;world.</p></body></html>";
  const htmlProvider = new DirectFetchProvider({ fetchImpl: fakeFetch(html, { contentType: "text/html" }) });
  const r = await htmlProvider.fetch("https://pub.example/page");
  check("directfetch: HTML → title extracted", r.title === "My Page");
  check("directfetch: HTML → script/style stripped, text kept", r.content.includes("Heading") && r.content.includes("Hello world.") && !r.content.includes("bad()") && !r.content.includes("x{}"));

  // text/plain passthrough.
  const txtProvider = new DirectFetchProvider({ fetchImpl: fakeFetch("just text", { contentType: "text/plain" }) });
  const t = await txtProvider.fetch("https://pub.example/raw.txt");
  check("directfetch: text/plain passthrough", t.content === "just text" && t.kind === "text");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "af-web-e2e-"));
  const environment = new LocalEnvironment(dir);
  try {
    await testToolFormatting(environment);
    await testFirecrawl();
    await testTavily();
    await testDirectFetch();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ WEB E2E PASS — provider interface + WebSearch/WebFetch tools + Firecrawl/Tavily/DirectFetch impls");
  } else {
    console.log("❌ WEB E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ WEB E2E ERROR:", error);
  process.exit(1);
});
