import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalMachine,
  webSearchTool,
  fetchUrlTool,
  FirecrawlProvider,
  TavilySearchProvider,
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

async function runTool(tool: Tool, args: unknown, machine: LocalMachine): Promise<ToolResult> {
  const ctx = { turnId: "t", toolCallId: "tc", signal: new AbortController().signal, machine };
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

async function testToolFormatting(machine: LocalMachine): Promise<void> {
  const search: WebSearchProvider = {
    async search() {
      return [
        { title: "Result A", url: "https://a.example", snippet: "snippet a", date: "2026-01-01" },
        { title: "Result B", url: "https://b.example", snippet: "snippet b" },
      ];
    },
  };
  const out = textOf(await runTool(webSearchTool(search), { query: "hello world" }, machine));
  check("websearch: formats ranked results", out.includes("Title: Result A") && out.includes("URL: https://b.example") && out.includes("---"));
  check("websearch: includes date when present", out.includes("Date: 2026-01-01"));

  const empty: WebSearchProvider = { async search() { return []; } };
  check("websearch: empty → friendly message", textOf(await runTool(webSearchTool(empty), { query: "x" }, machine)).includes("No search results"));

  const fetcher: UrlFetchProvider = {
    async fetch(url) {
      return { url, content: "# Page\n\nbody text", kind: "markdown", title: "Page Title" };
    },
  };
  const fout = textOf(await runTool(fetchUrlTool(fetcher), { url: "https://a.example/p" }, machine));
  check("fetchurl: renders title + url + body", fout.includes("# Page Title") && fout.includes("https://a.example/p") && fout.includes("body text"));

  const longFetcher: UrlFetchProvider = {
    async fetch(url) { return { url, content: "x".repeat(100), kind: "text" }; },
  };
  const tout = textOf(await runTool(fetchUrlTool(longFetcher), { url: "https://a.example/long", max_length: 10 }, machine));
  check("fetchurl: truncates to max_length", tout.includes("…[truncated]") && tout.includes("x".repeat(10)) && !tout.includes("x".repeat(11)));

  const failing: UrlFetchProvider = {
    async fetch() { throw new WebToolError("upstream exploded"); },
  };
  const eout = await runTool(fetchUrlTool(failing), { url: "https://a.example/err" }, machine);
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

  const errProvider = new FirecrawlProvider({ apiKey: "k", fetchImpl: fakeFetch("{}", { status: 402 }) });
  let threw = false;
  try { await errProvider.search("q"); } catch (e) { threw = e instanceof WebToolError; }
  check("firecrawl: non-2xx → WebToolError", threw);
}

async function testTavily(): Promise<void> {
  const body = JSON.stringify({ results: [{ title: "TV", url: "https://tv.example", content: "tv snippet", published_date: "2025-12-01", raw_content: "raw" }] });
  const tv = new TavilySearchProvider({ apiKey: "k", fetchImpl: fakeFetch(body) });
  const results = await tv.search("q", { includeContent: true });
  check("tavily: maps /search result + date + raw_content", results[0]?.title === "TV" && results[0]?.snippet === "tv snippet" && results[0]?.date === "2025-12-01" && results[0]?.content === "raw");
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
  const machine = new LocalMachine(dir);
  try {
    await testToolFormatting(machine);
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
    console.log("✅ WEB E2E PASS — provider interface + WebSearch/FetchURL tools + Firecrawl/Tavily/DirectFetch impls");
  } else {
    console.log("❌ WEB E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ WEB E2E ERROR:", error);
  process.exit(1);
});
