/**
 * Unit-style coverage for tool/policies/path-access.ts + tool/policies/sensitive.ts —
 * previously zero test coverage despite being the workspace security boundary every
 * file tool (Read/Write/Edit/Glob/Grep) resolves through.
 *
 * Covers:
 *  - resolvePathAccess: pure canonicalization, workspace/absolute/relative rules,
 *    guardMode variants, sensitive-file blocking.
 *  - resolvePathAccessPath / resolveToolPath: the symlink-escape fix — a workspace-
 *    internal symlink that targets an outside or sensitive path must be rejected,
 *    even though the pure string canonicalization alone would allow it.
 *  - isSensitiveFile: basename/prefix/suffix matching edge cases.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMachine } from "../index.ts";
import {
  canonicalizePath,
  isWithinWorkspace,
  PathSecurityError,
  resolvePathAccess,
  resolvePathAccessPath,
  type WorkspaceAccessPolicy,
} from "../tool/policies/path-access.ts";
import { isSensitiveFile } from "../tool/policies/sensitive.ts";
import { resolveToolPath } from "../tool/support/tool-path.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function throws(label: string, fn: () => unknown | Promise<unknown>, code?: string): Promise<void> {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    const matches = code === undefined || (error instanceof PathSecurityError && error.code === code);
    check(label, matches);
  }
}

async function ok(label: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(label, true);
  } catch (error) {
    console.log(`  (unexpected throw: ${error instanceof Error ? error.message : String(error)})`);
    check(label, false);
  }
}

const DEFAULT_POLICY: WorkspaceAccessPolicy = { guardMode: "absolute-outside-allowed", checkSensitive: true };
const DISABLED_GUARD_POLICY: WorkspaceAccessPolicy = { guardMode: "disabled", checkSensitive: true };

async function main(): Promise<void> {
  const cwd = "/workspace/project";

  // ── resolvePathAccess: pure canonicalization (no I/O) ──
  check(
    "canonicalizePath: relative resolves against cwd",
    canonicalizePath("src/index.ts", cwd) === "/workspace/project/src/index.ts",
  );
  check(
    "canonicalizePath: absolute stays absolute",
    canonicalizePath("/etc/passwd", cwd) === "/etc/passwd",
  );
  check(
    "canonicalizePath: '..' segments normalized",
    canonicalizePath("../other/file.ts", cwd) === "/workspace/other/file.ts",
  );
  check("canonicalizePath: empty path throws PATH_INVALID", (() => {
    try {
      canonicalizePath("", cwd);
      return false;
    } catch (error) {
      return error instanceof PathSecurityError && error.code === "PATH_INVALID";
    }
  })());

  check(
    "isWithinWorkspace: true for a path under workspaceDir",
    isWithinWorkspace("/workspace/project/src/x.ts", { workspaceDir: cwd, additionalDirs: [] }),
  );
  check(
    "isWithinWorkspace: false for a sibling directory with shared prefix (no path-sep boundary bypass)",
    !isWithinWorkspace("/workspace/project-evil/x.ts", { workspaceDir: cwd, additionalDirs: [] }),
  );
  check(
    "isWithinWorkspace: true for the workspaceDir itself",
    isWithinWorkspace(cwd, { workspaceDir: cwd, additionalDirs: [] }),
  );

  await ok("resolvePathAccess: relative path inside workspace is allowed", () =>
    resolvePathAccess("src/index.ts", cwd, { workspaceDir: cwd, additionalDirs: [] }, { operation: "read" }),
  );

  await throws(
    "resolvePathAccess: relative path resolving outside workspace is rejected (must be absolute)",
    () => resolvePathAccess("../../etc/passwd", cwd, { workspaceDir: cwd, additionalDirs: [] }, { operation: "read" }),
    "PATH_OUTSIDE_WORKSPACE",
  );

  await ok(
    "resolvePathAccess: absolute path outside workspace allowed under absolute-outside-allowed",
    () =>
      resolvePathAccess("/etc/hosts", cwd, { workspaceDir: cwd, additionalDirs: [] }, { operation: "read", policy: DEFAULT_POLICY }),
  );

  await ok(
    "resolvePathAccess: relative-escaping path allowed when guardMode disabled",
    () =>
      resolvePathAccess("../../etc/hosts", cwd, { workspaceDir: cwd, additionalDirs: [] }, { operation: "read", policy: DISABLED_GUARD_POLICY }),
  );

  await throws(
    "resolvePathAccess: sensitive basename blocked even inside workspace",
    () => resolvePathAccess("secrets/id_rsa", cwd, { workspaceDir: cwd, additionalDirs: [] }, { operation: "read" }),
    "PATH_SENSITIVE",
  );

  // ── isSensitiveFile: basename/prefix/suffix edge cases ──
  check("isSensitiveFile: id_rsa_prod.pem matches (prefix + dot-variant suffix)", isSensitiveFile("/x/id_rsa_prod.pem"));
  check("isSensitiveFile: id_rsa.pub is exempt (public key)", !isSensitiveFile("/x/id_rsa.pub"));
  check("isSensitiveFile: .env.production matches (.env. prefix)", isSensitiveFile("/x/.env.production"));
  check("isSensitiveFile: .env.example is exempt", !isSensitiveFile("/x/.env.example"));
  check("isSensitiveFile: .aws/credentials matches (path suffix rule)", isSensitiveFile("/home/u/.aws/credentials"));
  check("isSensitiveFile: unrelated file does not match", !isSensitiveFile("/x/readme.md"));

  // ── resolvePathAccessPath / resolveToolPath: symlink-escape resolution (needs real fs) ──
  const root = await mkdtemp(join(tmpdir(), "path-access-e2e-"));
  const workspaceDir = join(root, "workspace");
  const outsideDir = join(root, "outside");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "secret.txt"), "top secret\n");
  await writeFile(join(outsideDir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  await mkdir(join(workspaceDir, "realdir"), { recursive: true });
  await writeFile(join(workspaceDir, "realdir", "a.txt"), "a\n");

  await symlink(outsideDir, join(workspaceDir, "escape"), "dir");
  await symlink(join(outsideDir, "id_rsa"), join(workspaceDir, "keylink"), "file");
  await symlink(join(workspaceDir, "realdir"), join(workspaceDir, "inner"), "dir");

  const machine = new LocalMachine(workspaceDir);

  await throws(
    "resolveToolPath: symlinked dir escaping workspace is rejected",
    () => resolveToolPath("escape/secret.txt", machine, "read"),
    "PATH_OUTSIDE_WORKSPACE",
  );

  await throws(
    "resolveToolPath: symlink to a sensitive file outside workspace is rejected",
    () => resolveToolPath("keylink", machine, "read"),
    "PATH_SENSITIVE",
  );

  await ok("resolveToolPath: symlink that stays inside workspace is allowed", () =>
    resolveToolPath("inner/a.txt", machine, "read"),
  );

  await ok("resolveToolPath: brand-new file under an existing dir does not throw (no ENOENT from realpath)", () =>
    resolveToolPath("newfile.txt", machine, "write"),
  );

  await ok(
    "resolveToolPath: brand-new file under a brand-new nested dir does not throw (recursive walk-up)",
    () => resolveToolPath("newdir/nested/newfile.txt", machine, "write"),
  );

  await ok(
    "resolvePathAccessPath: absolute path outside workspace via symlink-free machine still resolves",
    () => resolvePathAccessPath("realdir/a.txt", { machine, workspace: { workspaceDir, additionalDirs: [] }, operation: "read" }),
  );

  // ── additionalDirs: extra roots resolve like the cwd tree ──
  {
    const extraDir = join(root, "extra");
    await mkdir(extraDir, { recursive: true });
    await writeFile(join(extraDir, "granted.txt"), "granted\n");
    await symlink(join(extraDir, "granted.txt"), join(workspaceDir, "into-extra"), "file");

    // The same symlink is an escape without the grant...
    await throws(
      "additionalDirs: symlink into an UNgranted outside dir is still rejected",
      () => resolveToolPath("into-extra", machine, "read"),
      "PATH_OUTSIDE_WORKSPACE",
    );
    // ...and legitimate with it (the grant rides on the machine into resolveToolPath).
    const granted = new LocalMachine({ cwd: workspaceDir, additionalDirs: [extraDir] });
    await ok("additionalDirs: symlink into a granted dir is allowed", () =>
      resolveToolPath("into-extra", granted, "read"),
    );
    check(
      "additionalDirs: a path inside a granted dir is not outsideWorkspace",
      !resolvePathAccess(join(extraDir, "granted.txt"), workspaceDir, { workspaceDir, additionalDirs: [extraDir] }, { operation: "read" }).outsideWorkspace,
    );
    check(
      "additionalDirs: withCwd (worktree re-root) carries the grants",
      (granted.withCwd(join(workspaceDir, "realdir")).additionalDirs?.() ?? []).includes(extraDir),
    );
  }

  // Fail-closed: a backend realpath failure that is NOT "path missing" (dropped SSH
  // connection, EACCES, EIO) must propagate — never silently degrade the symlink guard
  // back to string-only matching. Only ENOENT/ENOTDIR trigger the new-file walk-up.
  {
    const brokenMachine = {
      pathClass: () => machine.pathClass(),
      gethome: () => machine.gethome(),
      realpath: async (): Promise<string> => {
        const err = new Error("connection lost") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      },
    };
    let failedClosed = false;
    try {
      await resolvePathAccessPath("realdir/a.txt", { machine: brokenMachine, workspace: { workspaceDir, additionalDirs: [] }, operation: "read" });
    } catch (error) {
      failedClosed = !(error instanceof PathSecurityError) && /connection lost/.test(error instanceof Error ? error.message : "");
    }
    check("resolvePathAccessPath: non-ENOENT realpath failure propagates (fail-closed, no silent degrade)", failedClosed);
  }

  await rm(root, { recursive: true, force: true });

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — path-access + sensitive-file policy");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
