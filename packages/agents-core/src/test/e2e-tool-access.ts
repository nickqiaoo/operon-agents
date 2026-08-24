/**
 * Unit-style coverage for tool/access.ts (ToolAccesses.conflict) — previously zero direct
 * test coverage despite being what the ToolScheduler uses to decide which tool calls in a
 * batch may run concurrently vs must serialize. Covers the read/write matrix, recursive
 * containment in both directions, `all`/`none` sentinels, and the known case-folding
 * quirk (paths are compared case-insensitively regardless of platform — flagged in review
 * as over-conservative on case-sensitive filesystems, not a false negative/safety bug, so
 * this test pins down the CURRENT behavior rather than silently asserting it's ideal).
 */
import { ToolAccesses } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function main(): void {
  check("none() vs anything: never conflicts (empty access list)", !ToolAccesses.conflict(ToolAccesses.none(), ToolAccesses.all()));
  check("all() vs a lone read: conflicts (all is the universal serializer)", ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.readFile("/a")));
  check("all() vs none(): does not conflict (none has nothing to overlap with)", !ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.none()));

  check("read vs read, same path: never conflicts (reads don't serialize each other)", !ToolAccesses.conflict(ToolAccesses.readFile("/a"), ToolAccesses.readFile("/a")));
  check("search vs read, same path: never conflicts (neither writes)", !ToolAccesses.conflict(ToolAccesses.searchTree("/a"), ToolAccesses.readFile("/a/b")));
  check("read vs write, same path: conflicts", ToolAccesses.conflict(ToolAccesses.readFile("/a"), ToolAccesses.writeFile("/a")));
  check("write vs write, same path: conflicts", ToolAccesses.conflict(ToolAccesses.writeFile("/a"), ToolAccesses.writeFile("/a")));
  check("write vs write, different paths, non-recursive: does not conflict", !ToolAccesses.conflict(ToolAccesses.writeFile("/a"), ToolAccesses.writeFile("/b")));
  check("readwrite counts as a write for conflict purposes", ToolAccesses.conflict(ToolAccesses.readWriteFile("/a"), ToolAccesses.readFile("/a")));

  check(
    "recursive containment: writeTree(/dir) conflicts with writeFile(/dir/sub/file)",
    ToolAccesses.conflict(ToolAccesses.writeTree("/dir"), ToolAccesses.writeFile("/dir/sub/file")),
  );
  check(
    "recursive containment is symmetric: writeFile(/dir/sub/file) vs writeTree(/dir) also conflicts",
    ToolAccesses.conflict(ToolAccesses.writeFile("/dir/sub/file"), ToolAccesses.writeTree("/dir")),
  );
  check(
    "recursive containment requires an actual prefix match, not a lookalike sibling",
    !ToolAccesses.conflict(ToolAccesses.writeTree("/dir"), ToolAccesses.writeFile("/dir-other/file")),
  );
  check(
    "recursive read vs non-recursive read under it: no conflict (neither writes)",
    !ToolAccesses.conflict(ToolAccesses.readTree("/dir"), ToolAccesses.readFile("/dir/file")),
  );
  check(
    "trailing slash on the recursive root is normalized before prefix matching",
    ToolAccesses.conflict(ToolAccesses.writeTree("/dir/"), ToolAccesses.writeFile("/dir/x")),
  );

  // Known quirk (flagged in review, not fixed here): path comparison always lowercases
  // regardless of platform/filesystem case sensitivity, so two *different* files on a
  // case-sensitive filesystem are still treated as the same resource — over-conservative
  // serialization, not a missed-conflict safety hole.
  check(
    "KNOWN QUIRK: case differs but is folded, so distinct case-sensitive paths still 'conflict'",
    ToolAccesses.conflict(ToolAccesses.writeFile("/Repo/Foo.ts"), ToolAccesses.writeFile("/repo/foo.ts")),
  );

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — ToolAccesses.conflict");
}

main();
