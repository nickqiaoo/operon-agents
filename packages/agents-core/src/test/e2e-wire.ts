import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRecord,
  DiskSessionStore,
  type Message,
  replayContext,
} from "../index.ts";
import { isBlobRef, migrateRecord, WIRE_PROTOCOL_VERSION } from "../internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function imageMessage(id: string, data: string): AgentRecord {
  const message: Message = { role: "user", content: [{ type: "image", data, mimeType: "image/png" }], timestamp: 1 };
  return { time: Number(id.slice(1)) || 1, address: "main", type: "context.append_message", message };
}
function textMessage(id: string, text: string): AgentRecord {
  const message: Message = { role: "user", content: [{ type: "text", text }], timestamp: 1 };
  return { time: Number(id.slice(1)) || 1, address: "main", type: "context.append_message", message };
}
function logPath(dir: string): string {
  return join(dir, "agents", "main", "log.jsonl");
}
function readState(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as Record<string, unknown>;
}
function firstImageData(history: readonly Message[]): string | undefined {
  for (const m of history) for (const c of m.content) if (c.type === "image") return c.data;
  return undefined;
}

// ── A: the migration chain applies registered steps in order ──
function testMigrateChain(): void {
  const registry = {
    0: (e: Record<string, unknown>) => ({ ...e, n: 1 }),
    1: (e: Record<string, unknown>) => ({ ...e, n: 2 }),
    2: (e: Record<string, unknown>) => ({ ...e, n: 3 }),
  };
  const out = migrateRecord({ n: 0 }, 0, registry, 3) as unknown as { n: number };
  check("A: migrateRecord chains 0→1→2→3", out.n === 3);
  const partial = migrateRecord({ n: 0 }, 2, registry, 3) as unknown as { n: number };
  check("A: migrateRecord starts at fromVersion", partial.n === 3 && Object.keys(partial).length === 1);
}

// ── A: a fresh session stamps the current wire version on first write ──
async function testFreshVersionStamp(dir: string): Promise<void> {
  const store = new DiskSessionStore(dir);
  await store.appendRecord(textMessage("a1", "hello"));
  check("A: fresh session stamps wire_version", readState(dir)["wire_version"] === WIRE_PROTOCOL_VERSION);
}

// ── B: oversized image data is offloaded to a blob ref on disk and rehydrated on read ──
async function testBlobOffload(dir: string): Promise<void> {
  const bigImage = Buffer.alloc(6000, 7).toString("base64"); // > 4096 → offloaded
  const store = new DiskSessionStore(dir);
  await store.appendRecord(imageMessage("b1", bigImage));
  await store.appendRecord(imageMessage("b2", bigImage)); // same bytes → dedup

  const rawLog = readFileSync(logPath(dir), "utf-8");
  check("B: log line carries a blobref, not the base64", rawLog.includes("blobref:") && !rawLog.includes(bigImage));
  const blobs = readdirSync(join(dir, "blobs"));
  check("B: a blob file was written", blobs.length >= 1);
  check("B: identical images dedup to one blob", blobs.length === 1);

  const replayed = await replayContext(store, "main");
  check("B: image rehydrated identical on read", firstImageData(replayed.history) === bigImage);
}

// ── B: small images stay inline (no offload) ──
async function testSmallImageInline(dir: string): Promise<void> {
  const small = Buffer.alloc(16, 1).toString("base64");
  const store = new DiskSessionStore(dir);
  await store.appendRecord(imageMessage("s1", small));
  const rawLog = readFileSync(logPath(dir), "utf-8");
  check("B: small image stays inline", rawLog.includes(small) && !isBlobRef(small));
}

// ── C: rewrite re-emits the shard compactly (offloaded) and drops a torn trailing line ──
async function testRewrite(dir: string): Promise<void> {
  const store = new DiskSessionStore(dir);
  await store.appendRecord(textMessage("r1", "one"));
  await store.appendRecord(textMessage("r2", "two"));
  // Simulate a crash: append a torn (incomplete JSON) trailing line.
  writeFileSync(logPath(dir), `${readFileSync(logPath(dir), "utf-8")}{"id":"r3","torn`, { flag: "w" });

  const before = await replayContext(store, "main");
  await store.rewrite();
  const rawLog = readFileSync(logPath(dir), "utf-8");
  check("C: rewrite drops the torn trailing line", !rawLog.includes("torn"));
  const after = await replayContext(store, "main");
  const t = (h: readonly Message[]) => h.flatMap((m) => m.content).map((c) => (c.type === "text" ? c.text : "")).join("|");
  check("C: rewrite preserves history", t(before.history) === "one|two" && t(after.history) === "one|two");

  await store.flush();
  await store.close();
  check("C: flush + close resolve without error", true);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-wire-e2e-"));
  try {
    testMigrateChain();
    await testFreshVersionStamp(join(root, "fresh"));
    await testBlobOffload(join(root, "blob"));
    await testSmallImageInline(join(root, "small"));
    await testRewrite(join(root, "rewrite"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ WIRE E2E PASS — version+migration (A) + blob offload (B) + rewrite/flush/close (C)");
  } else {
    console.log("❌ WIRE E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ WIRE E2E ERROR:", error);
  process.exit(1);
});
