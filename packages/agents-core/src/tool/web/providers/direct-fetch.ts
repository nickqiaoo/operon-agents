import {
  WebToolError,
  type UrlFetchOptions,
  type UrlFetchProvider,
  type UrlFetchResult,
} from "../types.ts";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Redirect chains longer than this are a loop or a tarpit, not a site reorganizing itself. */
const MAX_REDIRECTS = 10;
/** Past this a URL is a payload, not an address; browsers stop caring around here too. */
const MAX_URL_LENGTH = 2000;

export interface DirectFetchProviderOptions {
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly allowPrivateAddresses?: boolean;
}

export class DirectFetchProvider implements UrlFetchProvider {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly allowPrivate: boolean;

  constructor(options: DirectFetchProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowPrivate = options.allowPrivateAddresses ?? false;
  }

  async fetch(url: string, options?: UrlFetchOptions): Promise<UrlFetchResult> {
    const maxBytes = options?.maxBytes ?? this.maxBytes;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    // One deadline for the whole chain. Per-hop timeouts would let a redirect loop stall for
    // MAX_REDIRECTS × timeout while each individual hop looked responsive.
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);

    const { response, finalUrl } = await this.fetchFollowingSafeRedirects(url, signal, timeoutMs);

    if (response.status >= 400) {
      throw new WebToolError(`Fetch returned HTTP ${String(response.status)} ${response.statusText} for ${finalUrl}.`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new WebToolError(`Response too large (${String(declared)} bytes > ${String(maxBytes)}).`);
    }
    const raw = await response.text();
    if (raw.length > maxBytes) throw new WebToolError(`Response too large (${String(raw.length)} bytes > ${String(maxBytes)}).`);

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
      return { url: finalUrl, content: raw.trim(), kind: contentType.includes("markdown") ? "markdown" : "text" };
    }
    const { title, text } = extractFromHtml(raw);
    if (text.length === 0) throw new WebToolError(`No meaningful text content found at ${finalUrl}.`);
    return { url: finalUrl, content: text, kind: "text", ...(title !== undefined ? { title } : {}) };
  }

  /**
   * Walks the redirect chain by hand, re-checking every hop.
   *
   * `fetch` follows redirects on its own, and doing so silently defeats both guards this
   * provider has. The private-address check runs once, before the request — so a public URL
   * that redirects to `169.254.169.254` sails straight through to the cloud metadata endpoint.
   * And the caller's permission was granted for the ORIGINAL host, so a trusted domain with an
   * open redirect becomes a way to fetch somewhere the user never approved.
   *
   * A cross-host redirect is not followed but reported, naming the destination. Following it
   * would launder the approval; failing silently would leave the model guessing why a URL it
   * can see in a browser returns nothing. Told where it leads, the model can fetch that URL
   * directly — which goes through permissions again, as it should.
   */
  private async fetchFollowingSafeRedirects(
    startUrl: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ readonly response: Response; readonly finalUrl: string }> {
    let current = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertSafeTarget(current, this.allowPrivate);
      let response: Response;
      try {
        response = await this.fetchImpl(current, {
          headers: { "user-agent": this.userAgent, accept: "text/html,text/plain,text/markdown,*/*" },
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal.aborted && (error as Error | undefined)?.name === "TimeoutError") {
          throw new WebToolError(`Fetch timed out after ${String(timeoutMs)}ms for ${current}.`);
        }
        throw new WebToolError(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (!isRedirectStatus(response.status)) return { response, finalUrl: current };

      const location = response.headers.get("location");
      if (location === null || location.length === 0) {
        throw new WebToolError(`${current} returned HTTP ${String(response.status)} with no Location header.`);
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new WebToolError(`${current} redirected to an invalid URL: ${location}`);
      }
      if (!isPermittedRedirect(current, next)) {
        throw new WebToolError(
          `${current} redirects to ${next}, a different origin. Not following it automatically — ` +
            `fetch that URL directly if you meant to go there.`,
        );
      }
      current = next;
    }
    throw new WebToolError(`More than ${String(MAX_REDIRECTS)} redirects starting at ${startUrl}.`);
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Same scheme, same port, same host — `www.` may be added or dropped, and the path may change.
 *
 * Anything looser reopens the hole: a redirect to a sibling subdomain is still a redirect to a
 * host the user did not approve, and credentials in the target (`https://user:pass@host/`) are
 * refused outright since they are never part of a legitimate redirect.
 */
function isPermittedRedirect(fromUrl: string, toUrl: string): boolean {
  let from: URL;
  let to: URL;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    return false;
  }
  if (from.protocol !== to.protocol) return false;
  if (from.port !== to.port) return false;
  if (to.username.length > 0 || to.password.length > 0) return false;
  const stripWww = (host: string): string => host.replace(/^www\./, "");
  return stripWww(from.hostname.toLowerCase()) === stripWww(to.hostname.toLowerCase());
}

/** Runs on every hop of a redirect chain, not just the URL the caller supplied. */
function assertSafeTarget(url: string, allowPrivate: boolean): void {
  if (url.length > MAX_URL_LENGTH) {
    throw new WebToolError(`URL is longer than ${String(MAX_URL_LENGTH)} characters.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebToolError(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebToolError(`Unsupported URL scheme "${parsed.protocol}" (only http/https).`);
  }
  if (allowPrivate) return;
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    throw new WebToolError(`Refusing to fetch a private/loopback address: ${host}.`);
  }
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 loopback / ULA / link-local.
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true; // loopback / RFC1918 / "this host"
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  return false;
}

function extractFromHtml(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).trim() : undefined;
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ...(title !== undefined && title.length > 0 ? { title } : {}), text };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
