import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  ConfigError,
  ConfigStore,
  fileResolver,
  jsonFormat,
  resolveFromFiles,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
function layout(root: string): { opts: { appName: string; homeDir: string; cwd: string }; user: string; project: string; local: string } {
  const homeDir = join(root, "home");
  const cwd = join(root, "proj");
  return {
    opts: { appName: "agents", homeDir, cwd },
    user: join(homeDir, "config.toml"),
    project: join(cwd, ".agents", "config.toml"),
    local: join(cwd, ".agents", "config.local.toml"),
  };
}

function maxTurnsOn(onDisk: Record<string, unknown>): unknown {
  return (onDisk["loopControl"] as { maxTurns?: unknown } | undefined)?.maxTurns;
}

// ── Read: three tiers merge in precedence; rules concatenate; missing tiers skipped ──
async function testMergeAndPrecedence(root: string): Promise<void> {
  const { opts, user, project, local } = layout(join(root, "merge"));
  write(user, `[loopControl]\nmaxTurns = 1\n\n[flags]\nlower = true\n\n[[permission.rules]]\ndecision = "allow"\nscope = "user"\npattern = "Read"\n`);
  write(project, `[loopControl]\nmaxTurns = 2\n\n[[permission.rules]]\ndecision = "deny"\nscope = "project"\npattern = "Write"\n`);
  write(local, `[loopControl]\nmaxTurns = 3\n`);

  const { config, layers } = await resolveFromFiles(opts);
  check("read: local tier wins the scalar", config.loopControl.maxTurns === 3);
  check("read: lower-tier setting survives", config.flags["lower"] === true);
  check("read: rules concatenate across tiers", config.permission.rules.length === 2);
  check("read: all three layers reported loaded", layers.every((l) => l.loaded));

  const viaResolver = await fileResolver(opts).resolve();
  check("read: fileResolver matches resolveFromFiles", viaResolver.loopControl.maxTurns === 3);
}

async function testMissingTiers(root: string): Promise<void> {
  const { opts, user } = layout(join(root, "sparse"));
  write(user, `[loopControl]\nmaxTurns = 7\n`);
  const { config, layers } = await resolveFromFiles(opts);
  check("read: resolves with only the user tier present", config.loopControl.maxTurns === 7);
  check("read: absent tiers reported not loaded", layers.filter((l) => !l.loaded).length === 2);
}

// ── Validation: bad value → ConfigError naming the file + field path, no throw of raw Zod ──
async function testValidationError(root: string): Promise<void> {
  const { opts, project } = layout(join(root, "invalid"));
  write(project, `[loopControl]\nmaxTurns = "huge"\n`);
  let err: unknown;
  try {
    await resolveFromFiles(opts);
  } catch (e) {
    err = e;
  }
  const ce = err instanceof ConfigError ? err : undefined;
  check("validate: throws ConfigError", ce !== undefined);
  check("validate: message names the file", ce?.message.includes(project) ?? false);
  check("validate: message names the field path", (ce?.issues ?? []).some((i) => i.includes("loopControl.maxTurns")));
}

// ── Write: patch merges into a tier file, persists minimally, re-resolves ──
async function testPatchPersist(root: string): Promise<void> {
  const { opts, user } = layout(join(root, "patch"));
  write(user, `[loopControl]\nmaxTurns = 1\n`);
  const store = new ConfigStore(opts);
  await store.load();

  const after = await store.patch({ loopControl: { maxTurns: 2 } }, "user");
  check("patch: returns re-resolved config", after.loopControl.maxTurns === 2);
  check("patch: get() reflects the patch", store.get().loopControl.maxTurns === 2);
  const onDisk = parseToml(readFileSync(user, "utf-8")) as Record<string, unknown>;
  check("patch: written file holds the new value", maxTurnsOn(onDisk) === 2);
  check("patch: file stays minimal (no injected defaults)", !("flags" in onDisk) && !("hooks" in onDisk));

  // Deep-merge preserves untouched keys; nested object merges.
  await store.patch({ flags: { added: true } }, "user");
  const merged = parseToml(readFileSync(user, "utf-8")) as Record<string, unknown>;
  check("patch: deep-merge keeps prior keys", maxTurnsOn(merged) === 2 && merged["flags"] !== undefined);

  // A fresh store sees the persisted state.
  const reopened = new ConfigStore(opts);
  await reopened.load();
  check("patch: persists across store instances", reopened.get().flags["added"] === true);
}

async function testPatchValidation(root: string): Promise<void> {
  const { opts, user } = layout(join(root, "patch-bad"));
  write(user, `[loopControl]\nmaxTurns = 1\n`);
  const store = new ConfigStore(opts);
  await store.load();
  let threw = false;
  try {
    await store.patch({ loopControl: { maxTurns: -5 } }, "user");
  } catch (e) {
    threw = e instanceof ConfigError;
  }
  check("patch: invalid patch throws ConfigError", threw);
  const onDisk = parseToml(readFileSync(user, "utf-8")) as Record<string, unknown>;
  check("patch: file untouched on invalid patch", maxTurnsOn(onDisk) === 1);
}

// ── Format is pluggable: JSON instead of TOML ──
async function testJsonFormat(root: string): Promise<void> {
  const homeDir = join(root, "json", "home");
  const cwd = join(root, "json", "proj");
  const opts = { appName: "agents", homeDir, cwd, fileName: "config.json", format: jsonFormat };
  const store = new ConfigStore(opts);
  await store.load();
  await store.patch({ loopControl: { maxTurns: 4 } }, "user");
  const text = readFileSync(join(homeDir, "config.json"), "utf-8");
  check("format: JSON written and parseable", JSON.parse(text).loopControl.maxTurns === 4);
  const reopened = new ConfigStore(opts);
  await reopened.load();
  check("format: JSON re-resolves", reopened.get().loopControl.maxTurns === 4);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-config-e2e-"));
  try {
    await testMergeAndPrecedence(root);
    await testMissingTiers(root);
    await testValidationError(root);
    await testPatchPersist(root);
    await testPatchValidation(root);
    await testJsonFormat(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ CONFIG-FILE E2E PASS — TOML tiers (read/merge/precedence) + validation errors + patch/persist + JSON format");
  } else {
    console.log("❌ CONFIG-FILE E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ CONFIG-FILE E2E ERROR:", error);
  process.exit(1);
});
