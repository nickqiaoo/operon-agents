import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CallbackResult {
  readonly code: string;
  readonly state: string | undefined;
}

export interface CallbackServer {
  readonly redirectUri: string;
  waitForCode(opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallbackResult>;
  close(): Promise<void>;
}

const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--card:#ffffff;--border:rgba(223,227,235,.9);--fg:#18181b;--muted:#71717a;--ok:#15803d;--ok-bg:rgba(21,128,61,.1);--err:#b91c1c;--err-bg:rgba(185,28,28,.08);--code:#f4f4f5;--shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--card:#141417;--border:rgba(63,63,70,.55);--fg:#f4f4f5;--muted:#a1a1aa;--ok:#4ade80;--ok-bg:rgba(74,222,128,.1);--err:#fca5a5;--err-bg:rgba(248,113,113,.1);--code:#1d1d21;--shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:400px;padding:32px 28px 28px;border:1px solid var(--border);border-radius:12px;background:var(--card);box-shadow:var(--shadow);text-align:center}
.icon{width:44px;height:44px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;border-radius:9999px}
.icon svg{width:22px;height:22px}
.ok .icon{background:var(--ok-bg);color:var(--ok)}
.err .icon{background:var(--err-bg);color:var(--err)}
h1{margin:0 0 6px;font-size:16px;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
.detail{margin-top:16px;padding:10px 12px;border-radius:8px;background:var(--code);color:var(--fg);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left;word-break:break-word}
.brand{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;font-weight:500;letter-spacing:.02em}
.brand span{width:6px;height:6px;border-radius:9999px;background:currentColor;opacity:.6}
`;

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CROSS_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(opts: { ok: boolean; title: string; message: string; detail?: string }): string {
  const detail = opts.detail ? `<div class="detail">${escapeHtml(opts.detail)}</div>` : "";
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(opts.title)} · Operon</title><style>${PAGE_STYLE}</style></head>` +
    `<body><main class="card ${opts.ok ? "ok" : "err"}">` +
    `<div class="icon">${opts.ok ? CHECK_ICON : CROSS_ICON}</div>` +
    `<h1>${escapeHtml(opts.title)}</h1><p>${escapeHtml(opts.message)}</p>${detail}</main>` +
    '<div class="brand"><span></span>Operon</div></body></html>'
  );
}

const SUCCESS_HTML = renderPage({
  ok: true,
  title: "Sign-in complete",
  message: "You can close this tab and return to Operon.",
});

function errorHtml(detail: string): string {
  return renderPage({
    ok: false,
    title: "Sign-in failed",
    message: "Return to Operon and try connecting again.",
    detail,
  });
}

export interface CallbackServerOptions {
  /** Listen on this loopback port instead of a random one (a pre-registered redirect URI). */
  readonly port?: number;
  /**
   * The exact redirect URI to advertise. Its port (when present) and path drive the listener;
   * wins over `port`. Must be an http loopback URL.
   */
  readonly redirectUri?: string;
}

export async function startCallbackServer(options: CallbackServerOptions = {}): Promise<CallbackServer> {
  const fixed = resolveFixedRedirect(options);
  let resolveCode: ((value: CallbackResult) => void) | undefined;
  let rejectCode: ((reason: Error) => void) | undefined;
  let settled = false;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res);
  });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" || req.url === undefined) {
      res.writeHead(404).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      res.writeHead(404).end();
      return;
    }
    if (url.pathname !== fixed.path) {
      res.writeHead(404).end();
      return;
    }
    const errorParam = url.searchParams.get("error");
    if (errorParam !== null) {
      const description = url.searchParams.get("error_description") ?? "";
      res
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(errorHtml(description ? `${errorParam}: ${description}` : errorParam));
      settle(() => {
        rejectCode?.(new Error(`OAuth error: ${errorParam}${description ? ` — ${description}` : ""}`));
      });
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null || code.length === 0) {
      res
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(errorHtml("The authorization server did not return an authorization code."));
      settle(() => {
        rejectCode?.(new Error("OAuth callback missing authorization code"));
      });
      return;
    }
    const state = url.searchParams.get("state") ?? undefined;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SUCCESS_HTML);
    settle(() => {
      resolveCode?.({ code, state });
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(fixed.port ?? 0, fixed.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = fixed.redirectUri ?? `http://127.0.0.1:${port}${fixed.path}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  const waitForCode: CallbackServer["waitForCode"] = ({ signal, timeoutMs } = {}) => {
    return new Promise<CallbackResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        settle(() =>
          rejectCode?.(signal?.reason instanceof Error ? signal.reason : new Error("OAuth flow aborted")),
        );
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      resolveCode = (value) => {
        cleanup();
        void close();
        resolve(value);
      };
      rejectCode = (reason) => {
        cleanup();
        void close();
        reject(reason);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle(() => rejectCode?.(new Error("OAuth callback timed out")));
        }, timeoutMs);
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  };

  return { redirectUri, waitForCode, close };
}

interface FixedRedirect {
  readonly host: string;
  readonly port?: number;
  readonly path: string;
  readonly redirectUri?: string;
}

function resolveFixedRedirect(options: CallbackServerOptions): FixedRedirect {
  if (options.redirectUri === undefined) {
    return { host: "127.0.0.1", ...(options.port !== undefined ? { port: options.port } : {}), path: "/callback" };
  }
  let url: URL;
  try {
    url = new URL(options.redirectUri);
  } catch {
    throw new Error(`invalid OAuth callback URL "${options.redirectUri}"`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`OAuth callback URL must be an http loopback URL (got "${options.redirectUri}")`);
  }
  const port = url.port !== "" ? Number(url.port) : options.port;
  if (port === undefined) {
    throw new Error(`OAuth callback URL "${options.redirectUri}" has no port`);
  }
  const host = url.hostname === "[::1]" ? "::1" : "127.0.0.1";
  return { host, port, path: url.pathname, redirectUri: options.redirectUri };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
