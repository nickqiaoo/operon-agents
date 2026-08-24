import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  ConfigError,
  ConfigStore,
  FileCredentialStore,
  MemoryCredentialStore,
  ProviderManager,
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

// ── Read: three tiers merge in precedence; rules concatenate; missing tiers skipped ──
async function testMergeAndPrecedence(root: string): Promise<void> {
  const { opts, user, project, local } = layout(join(root, "merge"));
  write(user, `defaultModel = "user"\n\n[modelCredentials]\npath = "user-credentials.json"\n\n[providers.anthropic]\ntype = "anthropic"\napiKey = "sk-user"\n\n[[permission.rules]]\ndecision = "allow"\nscope = "user"\npattern = "Read"\n`);
  write(project, `defaultModel = "project"\n\n[modelCredentials]\npath = "project-credentials.json"\n\n[[permission.rules]]\ndecision = "deny"\nscope = "project"\npattern = "Write"\n`);
  write(local, `defaultModel = "local"\n`);

  const { config, layers } = await resolveFromFiles(opts);
  check("read: local tier wins the scalar", config.defaultModel === "local");
  check("read: lower-tier provider survives", config.providers["anthropic"]?.apiKey === "sk-user");
  check(
    "read: higher-tier model credential path wins",
    config.modelCredentials?.path === "project-credentials.json",
  );
  check("read: rules concatenate across tiers", config.permission.rules.length === 2);
  check("read: all three layers reported loaded", layers.every((l) => l.loaded));

  const viaResolver = await fileResolver(opts).resolve();
  check("read: fileResolver matches resolveFromFiles", viaResolver.defaultModel === "local");
}

async function testModelCredentialPath(root: string): Promise<void> {
  const { opts, user } = layout(join(root, "model-credentials"));
  const credentialPath = join(root, "model-credentials", "secrets", "models.json");
  write(
    user,
    `[modelCredentials]\npath = ${JSON.stringify(credentialPath)}\n`,
  );

  const { config } = await resolveFromFiles(opts);
  const manager = new ProviderManager({ config });
  check(
    "credentials: TOML path selects FileCredentialStore",
    manager.runtime.credentials instanceof FileCredentialStore,
  );
  await manager.runtime.credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: "sk-persisted",
  }));
  const persisted = JSON.parse(readFileSync(credentialPath, "utf-8")) as {
    anthropic?: { type?: string; key?: string };
  };
  check(
    "credentials: canonical credential is written to configured path",
    persisted.anthropic?.type === "api_key" &&
      persisted.anthropic.key === "sk-persisted",
  );
  check(
    "credentials: configured credential file is owner-only",
    (statSync(credentialPath).mode & 0o777) === 0o600,
  );

  const injected = new MemoryCredentialStore();
  const ignoredPath = join(root, "model-credentials", "ignored.json");
  const injectedManager = new ProviderManager({
    config: {
      ...config,
      modelCredentials: { path: ignoredPath },
    },
    credentials: injected,
  });
  await injectedManager.runtime.credentials.modify("openai", async () => ({
    type: "api_key",
    key: "memory-only",
  }));
  check(
    "credentials: explicit store injection overrides TOML",
    injectedManager.runtime.credentials === injected &&
      !existsSync(ignoredPath),
  );
}

async function testMissingTiers(root: string): Promise<void> {
  const { opts, user } = layout(join(root, "sparse"));
  write(user, `defaultModel = "only-user"\n`);
  const { config, layers } = await resolveFromFiles(opts);
  check("read: resolves with only the user tier present", config.defaultModel === "only-user");
  check("read: absent tiers reported not loaded", layers.filter((l) => !l.loaded).length === 2);
}

// ── Validation: bad value → ConfigError naming the file + field path, no throw of raw Zod ──
async function testValidationError(root: string): Promise<void> {
  const { opts, project } = layout(join(root, "invalid"));
  write(project, `[models.bad]\nprovider = "x"\nmodel = "y"\nmaxContextSize = "huge"\n`);
  let err: unknown;
  try {
    await resolveFromFiles(opts);
  } catch (e) {
    err = e;
  }
  const ce = err instanceof ConfigError ? err : undefined;
  check("validate: throws ConfigError", ce !== undefined);
  check("validate: message names the file", ce?.message.includes(project) ?? false);
  check("validate: message names the field path", (ce?.issues ?? []).some((i) => i.includes("models.bad.maxContextSize")));
}

// ── Write: patch merges into a tier file, persists minimally, re-resolves ──
async function testPatchPersist(root: string): Promise<void> {
  const { opts, user } = layout(join(root, "patch"));
  write(user, `defaultModel = "before"\n`);
  const store = new ConfigStore(opts);
  await store.load();

  const after = await store.patch({ defaultModel: "after" }, "user");
  check("patch: returns re-resolved config", after.defaultModel === "after");
  check("patch: get() reflects the patch", store.get().defaultModel === "after");
  const onDisk = parseToml(readFileSync(user, "utf-8")) as Record<string, unknown>;
  check("patch: written file holds the new value", onDisk["defaultModel"] === "after");
  check("patch: file stays minimal (no injected defaults)", !("providers" in onDisk) && !("hooks" in onDisk));

  // Deep-merge preserves untouched keys; nested object merges.
  await store.patch({ providers: { anthropic: { type: "anthropic", apiKey: "sk" } } }, "user");
  const merged = parseToml(readFileSync(user, "utf-8")) as Record<string, unknown>;
  check("patch: deep-merge keeps prior keys", merged["defaultModel"] === "after" && merged["providers"] !== undefined);

  // A fresh store sees the persisted state.
  const reopened = new ConfigStore(opts);
  await reopened.load();
  check("patch: persists across store instances", reopened.get().providers["anthropic"]?.apiKey === "sk");
}

async function testPatchValidation(root: string): Promise<void> {
  const { opts, user } = layout(join(root, "patch-bad"));
  write(user, `defaultModel = "keep"\n`);
  const store = new ConfigStore(opts);
  await store.load();
  let threw = false;
  try {
    await store.patch({ models: { bad: { provider: "x", model: "y", maxContextSize: -5 } } }, "user");
  } catch (e) {
    threw = e instanceof ConfigError;
  }
  check("patch: invalid patch throws ConfigError", threw);
  const onDisk = parseToml(readFileSync(user, "utf-8")) as Record<string, unknown>;
  check("patch: file untouched on invalid patch", onDisk["defaultModel"] === "keep" && !("models" in onDisk));
}

// ── Format is pluggable: JSON instead of TOML ──
async function testJsonFormat(root: string): Promise<void> {
  const homeDir = join(root, "json", "home");
  const cwd = join(root, "json", "proj");
  const opts = { appName: "agents", homeDir, cwd, fileName: "config.json", format: jsonFormat };
  const store = new ConfigStore(opts);
  await store.load();
  await store.patch({ defaultModel: "via-json" }, "user");
  const text = readFileSync(join(homeDir, "config.json"), "utf-8");
  check("format: JSON written and parseable", JSON.parse(text).defaultModel === "via-json");
  const reopened = new ConfigStore(opts);
  await reopened.load();
  check("format: JSON re-resolves", reopened.get().defaultModel === "via-json");
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
    await testModelCredentialPath(root);
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
