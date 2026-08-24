/**
 * Machine-level smoke test for the real E2B integration (no LLM needed).
 * Run:  E2B_API_KEY=... node --experimental-strip-types --no-warnings smoke-e2b.ts
 *
 * Proves: `Sandbox` (e2b SDK) → E2BWorkspace → E2BMachine → a live E2B sandbox, exercising
 * run + write/read + listDir against the real backend. The package's own e2e covers the same
 * surface against a fake; this is the one that talks to the vendor.
 */
import { Sandbox } from "e2b";
import { E2BWorkspace } from "operon-sandbox";

async function main(): Promise<void> {
  if (!process.env.E2B_API_KEY) throw new Error("set E2B_API_KEY");

  console.log("→ opening E2B sandbox…");
  const workspace = await E2BWorkspace.open({
    sandbox: Sandbox,
    ...(process.env.E2B_TEMPLATE !== undefined ? { template: process.env.E2B_TEMPLATE } : {}),
  });
  const machine = workspace.machine;
  try {
    console.log("  sandbox:", workspace.id, "| machine:", machine.name, "| cwd:", machine.getcwd());

    const probe = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        const v = await fn();
        console.log(`✅ ${label} →`, typeof v === "string" ? JSON.stringify(v) : v);
      } catch (e) {
        console.log(`❌ ${label} → ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    // `run()` is the intent-shaped entry point: it carries the timeout, the output cap and
    // the kill that a bare exec on this backend could not.
    await probe("run (echo)", async () => (await machine.run(["echo", "hello-from-e2b"])).stdout.trim());
    await probe("writeText+readBytes roundtrip", async () => {
      await machine.writeText("note.txt", "hi e2b 🚀");
      const back = (await machine.readBytes("note.txt")).toString("utf8");
      return back === "hi e2b 🚀" ? "match" : `MISMATCH: ${back}`;
    });
    // A byte window is taken on the far side (tail/head/base64), so only these bytes travel.
    await probe("readBytes window", async () => JSON.stringify((await machine.readBytes("note.txt", { offset: 3, length: 3 })).toString("utf8")));
    await probe("listDir", async () => await machine.listDir("."));
    await probe("fileInfo (stat)", async () => (await machine.fileInfo("note.txt")).size);
    await probe("ripgrep present in base image", async () => {
      const { stdout } = await machine.run(["sh", "-c", "command -v rg || echo NO"]);
      return stdout.trim();
    });
    await probe("timeout really kills", async () => {
      const r = await machine.run(["sh", "-c", "sleep 30"], { timeoutMs: 2_000 });
      return r.timedOut ? "timed out as asked" : `NOT honoured (exit ${String(r.exitCode)})`;
    });
  } finally {
    // The host owns the sandbox's lifetime — nothing else will clean this up.
    console.log("→ killing sandbox…");
    await workspace.kill();
  }
  console.log("✅ E2B smoke test complete");
}

await main();
