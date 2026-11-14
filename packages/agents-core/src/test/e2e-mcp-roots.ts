// MCP `roots`: a server bound to a workspace must be told the workspace, and an stdio server
// with no cwd of its own must run in it.
//
// Regression: the client declared no capabilities at all, so a server that checks paths against
// roots (chrome-devtools-mcp ≥ 1.6 writing a screenshot) fell back to the OS temp directory and
// refused every project path ("is not within any of the configured workspace roots"); and the
// server inherited the host's cwd — `/` for a desktop app launched from the Finder — so a relative
// path like `test-results/shot.png` resolved to `/test-results/shot.png`.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serverFromConfig } from "../mcp/manager.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `✅ ${label}` : `❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

interface ProbeReport {
  readonly declared: boolean;
  readonly roots: { uri: string; name?: string }[] | null;
  readonly rootsError: string | null;
  readonly cwd: string;
}

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-roots-server.ts", import.meta.url));

async function probe(options: { roots?: readonly string[]; cwd?: string }): Promise<ProbeReport> {
  const server = serverFromConfig(
    "roots-probe",
    {
      transport: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types", "--no-warnings", FIXTURE],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    },
    options.roots !== undefined ? { roots: options.roots } : {},
  );
  await server.connect();
  try {
    const result = await server.callTool("probe", {});
    const first = result.content?.[0] as { type?: string; text?: string } | undefined;
    return JSON.parse(first?.text ?? "{}") as ProbeReport;
  } finally {
    await server.close();
  }
}

async function main(): Promise<void> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "mcp-roots-ws-")));
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "mcp-roots-cwd-")));
  try {
    // 1. Bound to a workspace: roots declared and answered, stdio cwd defaults to it.
    const bound = await probe({ roots: [workspace] });
    check("client declares the roots capability", bound.declared, bound);
    check(
      "roots/list answers the workspace as a file:// URI",
      bound.roots?.length === 1 && bound.roots[0]!.uri === pathToFileURL(workspace).href,
      bound.roots,
    );
    check("stdio server with no cwd starts in the workspace", bound.cwd === workspace, bound.cwd);

    // 2. A cwd of its own wins over the workspace; roots are still declared.
    const ownCwd = await probe({ roots: [workspace], cwd: elsewhere });
    check("explicit stdio cwd wins over the first root", ownCwd.cwd === elsewhere, ownCwd.cwd);
    check("roots still answered with an explicit cwd", ownCwd.roots?.[0]?.uri === pathToFileURL(workspace).href, ownCwd.roots);

    // 3. Not bound (a process-wide set): no capability, host cwd — unchanged behaviour.
    const unbound = await probe({});
    check("no roots: capability not declared", !unbound.declared, unbound);
    check("no roots: roots/list is refused", unbound.roots === null && unbound.rootsError !== null, unbound);
    check("no roots: stdio server inherits the host cwd", unbound.cwd === (await realpath(process.cwd())), unbound.cwd);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
