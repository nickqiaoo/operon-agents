/**
 * The `workspace` half (design: docs/architecture.md §5.1, §5.7): a definition whose shared half
 * runs once per WORKSPACE KEY, not once per process. Its result is registered under the id in
 * that workspace's scope — one instance per working directory, shared by the sessions under it,
 * disposed when the last of them closes — and the session half reaches it as `ctx.shared`
 * exactly as it would a `harness` half's. Covered here:
 *   by value — two workspaces get two instances; a consumer's `uses` resolves per workspace; the
 *              host reaches one via `harness.workspaceService`; `createSession` from the half
 *              lands in the same workspace; last session out disposes; one shared half only.
 *   from file — a load lands in a workspace that is ALREADY open; reload swaps the instance under
 *               a live session; unload removes it.
 */
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness, type ExtensionDefinition, type Message } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function toolResultText(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

interface Room {
  key(): string;
  dataDir(): string | undefined;
  spawn(title: string): Promise<{ readonly id: string }>;
  close(): void;
}

async function byValue(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "extension-workspace-"));
  const dirA = join(root, "a");
  const dirB = join(root, "b");
  const dataDir = join(root, "data");
  await mkdir(dirA);
  await mkdir(dirB);

  const closed: string[] = [];
  const rooms: ExtensionDefinition<Room> = {
    id: "rooms",
    workspace(host) {
      const room: Room = {
        key: () => host.key,
        dataDir: () => host.dataDir,
        spawn: (title) => host.createSession({ title }),
        close: () => {
          closed.push(host.key);
        },
      };
      return room;
    },
    session(api, { shared }) {
      api.registerTool({
        name: "Room",
        description: "Which workspace's room this session is in.",
        parameters: { type: "object", properties: {} },
        execute: () => `room:${shared.key()}`,
      });
    },
  };
  const consumer: ExtensionDefinition<unknown, unknown, { rooms: Room }> = {
    id: "uses-rooms",
    uses: ["rooms"],
    session(api, { services }) {
      api.registerTool({
        name: "WhichRoom",
        description: "Third-party consumer of the rooms service.",
        parameters: { type: "object", properties: {} },
        execute: () => `which:${services.rooms.key()}`,
      });
    },
  };

  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  let both = "";
  try {
    createHarness({
      model,
      extensions: [{ id: "twice", harness: () => ({}), workspace: () => ({}), session() {} }],
    });
  } catch (error) {
    both = String(error);
  }
  check("shape: a definition with both a harness and a workspace half is refused at registration", both.includes("both a harness and a workspace half"));

  const harness = createHarness({ model, permission: { mode: "yolo" }, extensions: [rooms, consumer], extensionDataDir: dataDir });
  check("declare: the workspace-tier name counts as registered before any workspace exists (a consumer's `uses` passes)", harness.services.has("rooms"));
  let harnessHandle = "";
  try {
    harness.services.handle("rooms");
  } catch (error) {
    harnessHandle = String(error);
  }
  check("declare: the harness-tier handle refuses a workspace-tier name, pointing at workspaceService", harnessHandle.includes("workspace-scoped"));
  let early = "";
  try {
    harness.workspaceService<Room>("rooms", { workDir: dirA }).key();
  } catch (error) {
    early = String(error);
  }
  check("declare: the handle can be taken before the workspace exists; a call reports missing", early.includes("not registered"));

  const a1 = await harness.createSession({ workDir: dirA });
  const a2 = await harness.createSession({ workDir: dirA });
  const b = await harness.createSession({ workDir: dirB });
  check("session: every session is born with the session half and the consumer", [a1, a2, b].every((s) => s.attachedExtensionIds().includes("rooms") && s.attachedExtensionIds().includes("uses-rooms")));

  const useBoth = () =>
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Room", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("WhichRoom", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
  useBoth();
  const textA1 = toolResultText((await a1.prompt("where")).messages);
  useBoth();
  const textA2 = toolResultText((await a2.prompt("where")).messages);
  useBoth();
  const textB = toolResultText((await b.prompt("where")).messages);
  check("tier: two sessions in one working directory share one instance", textA1.includes(`room:dir::${dirA}`) && textA2.includes(`room:dir::${dirA}`));
  check("tier: a session in another working directory gets its own", textB.includes(`room:dir::${dirB}`));
  check("uses: a consumer's handle resolves to ITS session's workspace instance", textA1.includes(`which:dir::${dirA}`) && textB.includes(`which:dir::${dirB}`));

  const roomA = harness.workspaceService<Room>("rooms", { workDir: dirA });
  const roomB = harness.workspaceService<Room>("rooms", { workDir: dirB });
  check("host: workspaceService reaches one workspace's instance by working directory", roomA?.key() === `dir::${dirA}` && roomB?.key() === `dir::${dirB}`);
  const dataA = roomA?.dataDir();
  const dataB = roomB?.dataDir();
  check("dataDir: each workspace gets its own folder under the extension's data root", dataA !== undefined && dataB !== undefined && dataA !== dataB && dataA.startsWith(join(dataDir, "rooms", "workspaces")));

  const kid = await roomA!.spawn("kid");
  const summary = (await harness.listSessions()).find((s) => s.id === kid.id);
  check("spawn: createSession from the half lands the new session in the SAME workspace", summary?.workDir === dirA && summary.title === "kid");
  check("spawn: the spawned session holds the workspace open (no dispose while it lives)", closed.length === 0);

  await a1.close();
  await a2.close();
  check("lifetime: closing some of a workspace's sessions keeps its instance", closed.length === 0);
  await harness.closeSession(kid.id);
  check("lifetime: the last session out disposes the workspace's instance", closed.join(",") === `dir::${dirA}`);
  check("lifetime: the other workspace is untouched", roomB?.key() === `dir::${dirB}`);
  let after = "";
  try {
    roomA!.key();
  } catch (error) {
    after = String(error);
  }
  check("lifetime: a closed workspace has no instance to hand out (the handle reports missing)", after.includes("not registered"));
  check("host: openWorkspaces lists exactly the workspaces still held", harness.openWorkspaces().map((w) => w.workDir).join(",") === dirB);

  await harness.close();
  check("close: closing the harness disposes the remaining workspace instances", closed.includes(`dir::${dirB}`));
  faux.unregister();
  await rm(root, { recursive: true, force: true });
}

const fileSource = (version: string): string => `
export default {
  id: "rooms-file",
  workspace(host) {
    return { v: () => "${version}", key: () => host.key, close: () => {} };
  },
  session(api, { shared }) {
    api.registerTool({
      name: "RoomV",
      description: "Version and workspace of the file-loaded rooms service.",
      parameters: { type: "object", properties: {} },
      execute: () => "${version}:" + shared.v() + ":" + shared.key(),
    });
  },
};
`;

async function fromFile(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "extension-workspace-file-"));
  const dirA = join(root, "a");
  await mkdir(dirA);
  const extensionDir = join(root, "extensions");
  const bundle = join(extensionDir, "rooms-file");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "manifest.json"), JSON.stringify({ id: "rooms-file" }));
  await writeFile(join(bundle, "index.js"), fileSource("v1"));

  const faux = registerFauxProvider();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, extensionDir });
  const manager = harness.extensions!;

  // The workspace is open BEFORE the extension loads: the load must land in it.
  const early = await harness.createSession({ workDir: dirA });
  await manager.load("rooms-file");
  check("load: the half composed into a workspace that was already open", harness.workspaceService<{ v(): string }>("rooms-file", { workDir: dirA }).v() === "v1");
  check("load: the session born before the load is untouched (no session half attached)", !early.attachedExtensionIds().includes("rooms-file"));

  const session = await harness.createSession({ workDir: dirA });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("RoomV", {}), { stopReason: "toolUse" }), fauxAssistantMessage("ok", { stopReason: "stop" })]);
  check("load: a session born after it runs the session half against the workspace's instance", toolResultText((await session.prompt("v")).messages).includes(`v1:v1:dir::${dirA}`));

  await writeFile(join(bundle, "index.js"), fileSource("v2"));
  await utimes(join(bundle, "index.js"), new Date(), new Date(Date.now() + 5_000));
  await manager.reload("rooms-file");
  faux.setResponses([fauxAssistantMessage(fauxToolCall("RoomV", {}), { stopReason: "toolUse" }), fauxAssistantMessage("ok", { stopReason: "stop" })]);
  check("reload: the SAME session runs the new session half against the workspace's REPLACED instance", toolResultText((await session.prompt("v")).messages).includes(`v2:v2:dir::${dirA}`));
  check("reload: the host's handle followed the swap", harness.workspaceService<{ v(): string }>("rooms-file", { workDir: dirA }).v() === "v2");

  await manager.unload("rooms-file");
  check("unload: the name is no longer registered", !harness.services.has("rooms-file"));
  check("unload: the session half was removed from the live session", !session.attachedExtensionIds().includes("rooms-file"));
  let gone = "";
  try {
    harness.workspaceService<{ v(): string }>("rooms-file", { workDir: dirA }).v();
  } catch (error) {
    gone = String(error);
  }
  check("unload: the workspace's instance is gone (a call on the handle reports missing)", gone.includes("not registered"));

  await harness.close();
  faux.unregister();
  await rm(root, { recursive: true, force: true });
}

await byValue();
await fromFile();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
