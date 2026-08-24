/**
 * Test fixture: an `operon-app-server` process backed by pi's faux provider, so a
 * real subprocess + real stdio round-trip can be tested without a live model.
 * Spawned by e2e-app-server.ts (the real-process half). Not an e2e* file itself,
 * so the test runner never executes it directly.
 *
 * stdout is the protocol; everything else goes to stderr.
 */
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { defineModel } from "operon-agents-core";
import { createHarness } from "../src/index.ts";
import { nodeStreamTransport } from "../src/app-server/codec.ts";
import { AppServer } from "../src/app-server/server.ts";

// Keep stdout pristine for the protocol.
console.log = (...p: unknown[]) => process.stderr.write(`${p.join(" ")}\n`);
console.info = console.log;
console.debug = console.log;

const faux = registerFauxProvider();
faux.setResponses([fauxAssistantMessage("hello from subprocess", { stopReason: "stop" })]);

const harness = createHarness({
  model: faux.getChatModel()!,
  workDir: process.cwd(),
  permission: { mode: "yolo" },
});

const transport = nodeStreamTransport(process.stdin, process.stdout, {
  onParseError: (line, error) => process.stderr.write(`boot parse error: ${String(error)} :: ${line}\n`),
});
const server = new AppServer({ harness, transport, serverInfo: { name: "faux-app-server", version: "test" }, log: (m) => process.stderr.write(`${m}\n`) });

server.serve().catch((error) => {
  process.stderr.write(`boot fatal: ${String(error)}\n`);
  process.exit(1);
});
