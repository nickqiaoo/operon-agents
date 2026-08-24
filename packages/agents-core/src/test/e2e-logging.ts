import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapabilityDiagnostic,
  ConsoleSink,
  DiagnosticLog,
  hasProxyConfig,
  installGlobalProxyDispatcher,
  MultiSink,
  resolveDiagnosticLogPath,
  resolveGlobalLogPath,
  resolveSessionLogPath,
  RotatingFileSink,
  sinkLogger,
  isSensitiveKey,
  redactDeep,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}
function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── RotatingFileSink: JSON lines + size rotation ──
async function testRotation(dir: string): Promise<void> {
  const path = join(dir, "rot", "app.log");
  const sink = new RotatingFileSink({ path, maxBytes: 80, maxFiles: 3 });
  for (let i = 0; i < 8; i++) sink.write({ level: "info", message: `line-${i}`, timestamp: 1 });
  await sink.flush();
  check("rotation: active file exists with JSON lines", existsSync(path) && lines(path).every((r) => r["level"] === "info"));
  check("rotation: a rotated file was produced", existsSync(`${path}.1`));

  // Under the limit → single file, no rotation.
  const path2 = join(dir, "norot", "app.log");
  const big = new RotatingFileSink({ path: path2, maxBytes: 1024 * 1024 });
  for (let i = 0; i < 5; i++) big.write({ level: "warn", message: `w-${i}`, timestamp: 1 });
  await big.flush();
  check("rotation: stays in one file under the limit", existsSync(path2) && !existsSync(`${path2}.1`) && lines(path2).length === 5);
}

// ── MultiSink + sinkLogger: fan-out, level filter, redaction ──
async function testLoggerAndMulti(dir: string): Promise<void> {
  const path = join(dir, "multi", "app.log");
  const captured: string[] = [];
  const multi = new MultiSink([new ConsoleSink({ write: (l) => captured.push(l) }), new RotatingFileSink({ path })]);
  const logger = sinkLogger(multi, { minLevel: "info", redact: true });

  logger.log("debug", "filtered out");
  logger.log("info", "hello", { user: "nick" });
  logger.log("error", "auth failed", { token: "supersecret-abcdef-1234" });
  await multi.flush();

  const fileLines = lines(path);
  check("multi: fan-out reaches console + file", captured.length === 2 && fileLines.length === 2);
  check("logger: below-minLevel records are dropped", fileLines.every((r) => r["msg"] !== "filtered out"));
  check("logger: fields are recorded", (fileLines[0]!["fields"] as Record<string, unknown>)["user"] === "nick");
  check("logger: sensitive field values are redacted", !readFileSync(path, "utf-8").includes("supersecret-abcdef-1234"));
}

// ── Log paths ──
function testPaths(): void {
  const opts = { appName: "demo", homeDir: "/tmp/demo-home" };
  check("paths: global log under <home>/logs", resolveGlobalLogPath(opts) === "/tmp/demo-home/logs/demo.log");
  check("paths: diagnostic log is separate", resolveDiagnosticLogPath(opts) === "/tmp/demo-home/logs/diagnostics.log");
  check("paths: session log next to session dir", resolveSessionLogPath("/data/sessions/s1") === "/data/sessions/s1/session.log");
}

// ── DiagnosticLog: capability diagnostics + errors to a separate channel ──
async function testDiagnostics(dir: string): Promise<void> {
  const path = join(dir, "diag", "diagnostics.log");
  const diag = new DiagnosticLog(new RotatingFileSink({ path }));
  const d: CapabilityDiagnostic = { capability: "mcp", phase: "start", level: "error", message: "connect failed" };
  diag.report(d);
  diag.error("boom", new Error("kaboom"), { where: "test" });
  await diag.flush();

  const recs = lines(path);
  check("diagnostics: capability diagnostic recorded with capability/phase", recs[0]!["msg"] === "[mcp/start] connect failed" && (recs[0]!["fields"] as Record<string, unknown>)["phase"] === "start");
  check("diagnostics: error captured with stack", recs[1]!["level"] === "error" && /kaboom/.test(JSON.stringify(recs[1]!["fields"])));
}

// ── Global proxy dispatcher: no-op without env, installs when configured ──
function testProxy(): void {
  check("proxy: no-op when no proxy env", installGlobalProxyDispatcher({ env: {} }) === false);
  check("proxy: hasProxyConfig reads env", hasProxyConfig({ HTTPS_PROXY: "http://proxy:8080" }) && !hasProxyConfig({}));
  // Installs (sets a global dispatcher) when a proxy is configured. No fetch is made.
  check("proxy: installs when proxy configured", installGlobalProxyDispatcher({ env: { HTTP_PROXY: "http://proxy:8080" } }) === true);
}

async function testSinkWriteFailureVisible(dir: string): Promise<void> {
  // A regular file where the sink needs a directory → mkdir fails → the write can't land.
  const blocker = join(dir, "blocker-file");
  writeFileSync(blocker, "x");
  const dropped: number[] = [];
  const sink = new RotatingFileSink({ path: join(blocker, "cant.log"), onError: (_e, total) => dropped.push(total) });
  sink.write({ level: "info", message: "will be lost", timestamp: 1 });
  await sink.flush(); // still resolves — a sink must not throw into its callers
  check(
    "sink: write failure surfaces via onError + dropped counter (flush still resolves)",
    sink.dropped === 1 && dropped.length === 1 && dropped[0] === 1,
  );
}

function testSensitiveKeyMatrix(): void {
  // Multi-word keys whose secret word is itself split across separators used to leak: no
  // single segment matches, and an opaque value matches no VALUE_PATTERN either.
  const sensitive = ["api_key", "apiKey", "x-api-key", "x-goog-api-key", "access_key_id", "client_secret", "set-cookie", "Authorization"];
  const benign = ["api_version", "key_count", "user_id", "content-type", "x-request-id", "monkey"];
  check("redact: multi-word secret keys are all detected", sensitive.every((k) => isSensitiveKey(k)));
  check("redact: benign keys are not over-matched", benign.every((k) => !isSensitiveKey(k)));

  // End-to-end through redactDeep: an opaque x-api-key value must not survive.
  const masked = redactDeep({ "x-api-key": "opaque-9f8e7d6c5b4a3", nested: { access_key_id: "AKIAsomethingopaque" } });
  const dumped = JSON.stringify(masked);
  check("redact: opaque x-api-key / access_key_id values are masked", !dumped.includes("opaque-9f8e7d6c5b4a3") && !dumped.includes("AKIAsomethingopaque"));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-logging-e2e-"));
  try {
    await testRotation(root);
    await testLoggerAndMulti(root);
    testPaths();
    await testDiagnostics(root);
    testProxy();
    await testSinkWriteFailureVisible(root);
    testSensitiveKeyMatrix();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ LOGGING E2E PASS — rotating file sink + multi-sink/logger + redaction + log paths + diagnostics + proxy dispatcher");
  } else {
    console.log("❌ LOGGING E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ LOGGING E2E ERROR:", error);
  process.exit(1);
});
