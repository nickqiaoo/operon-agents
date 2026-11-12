/**
 * `harness.readSessionMessages(id)` reads a session's transcript without opening it.
 *
 * - A CLOSED session stays closed: no Session is built, no open listener fires, and that holds
 *   for a fresh harness (a restarted process) over the same disk repository too.
 * - An OPEN session is read through its own store after pending appends land, so the reply of
 *   the run that just finished is already on the page.
 * - An extension's `harness` half reaches the same read as `host.readSessionMessages`.
 * - Unknown ids throw `SessionRepositoryNotFoundError`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness, SessionRepositoryNotFoundError, type TranscriptPage } from "../src/index.ts";
import type { ExtensionHostContext } from "../src/advanced.ts";
import { DiskSessionRepository } from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** The conversation as a reader sees it: framework injections (the skill catalog reminder) are
 *  on the transcript — they happened — but are told apart by origin, which is how a viewer hides
 *  them. */
function texts(page: TranscriptPage): string {
  return page.items
    .filter((item) => item.kind !== "message" || item.origin?.kind !== "injection")
    .map((item) => item.kind === "compaction" ? "[compaction]" : `${item.message.role}:${item.message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`)
    .join("|");
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "operon-read-messages-"));
  try {
    const repository = new DiskSessionRepository(home);
    const faux = registerFauxProvider();
    let host: ExtensionHostContext | undefined;
    const options = {
      infrastructure: () => ({ sessionRepository: repository }),
      ...faux.harnessModel(),
      extensions: [{ id: "reader", harness(h: ExtensionHostContext) { host = h; return {}; } }],
      config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" as const } } },
    };

    const harness = createHarness(options);
    let opened = 0;
    harness.onSessionOpened(() => {
      opened += 1;
    });
    const session = await harness.createSession({ workDir: home });
    faux.setResponses([fauxAssistantMessage("first reply", { stopReason: "stop" }), fauxAssistantMessage("second reply", { stopReason: "stop" })]);
    await session.prompt("hello");
    await session.prompt("again");

    // ── open: read through the live store, pending appends included ──
    const live = await harness.readSessionMessages(session.id);
    check("open: the run that just finished is on the page", texts(live) === "user:hello|assistant:first reply|user:again|assistant:second reply");
    check("open: injected context is on the transcript, marked by its origin", live.items.some((item) => item.kind === "message" && item.origin?.kind === "injection"));
    check("open: the session is still the same loaded instance", harness.getSession(session.id) === session);

    // ── closed: read from storage, never reopened ──
    await harness.closeSession(session.id);
    const openedBefore = opened;
    const closed = await harness.readSessionMessages(session.id);
    check("closed: the same transcript is read from storage", texts(closed) === texts(live));
    check("closed: reading did not load the session", harness.getSession(session.id) === undefined && opened === openedBefore);

    const newest = await harness.readSessionMessages(session.id, { limit: 2 });
    check("closed: a page is the newest messages", texts(newest) === "user:again|assistant:second reply" && newest.next !== undefined);
    const older = await harness.readSessionMessages(session.id, { limit: 3, before: newest.next! });
    check("closed: next pages to the older messages", texts(older) === "user:hello|assistant:first reply" && older.next === undefined);

    // ── an extension's harness half reads the same way ──
    const viaHost = host !== undefined ? await host.readSessionMessages(session.id) : undefined;
    check("extension host: reads the transcript without loading the session", viaHost !== undefined && texts(viaHost) === texts(closed) && harness.getSession(session.id) === undefined);

    let missing = false;
    try {
      await harness.readSessionMessages("no-such-session");
    } catch (error) {
      missing = error instanceof SessionRepositoryNotFoundError;
    }
    check("unknown id: SessionRepositoryNotFoundError", missing);
    await harness.close();

    // ── a fresh harness over the same storage: a restarted process ──
    const restarted = createHarness(options);
    let reopened = 0;
    restarted.onSessionOpened(() => {
      reopened += 1;
    });
    const cold = await restarted.readSessionMessages(session.id);
    check("restart: the transcript is read cold", texts(cold) === texts(live));
    check("restart: still nothing was opened", reopened === 0 && restarted.getSession(session.id) === undefined);
    await restarted.close();
    faux.unregister();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ READ SESSION MESSAGES E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ READ SESSION MESSAGES E2E PASS — ${checks.length} checks: a transcript read never opens the session`);
  process.exit(0);
}

void main();
