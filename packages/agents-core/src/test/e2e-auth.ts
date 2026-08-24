import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApiKeyAuth,
  AuthInteraction,
  OAuthAuth,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxChatProvider,
} from "./faux.ts";
import {
  defineAgent,
  FileCredentialStore,
  MemoryCredentialStore,
  Runner,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const PID = "test-oauth";
const future = () => Date.now() + 1_000_000;
const interaction: AuthInteraction = {
  async prompt() {
    return "LOGIN_KEY";
  },
  notify() {},
};

let refreshCount = 0;
const fakeOAuth: OAuthAuth = {
  name: "Test OAuth",
  async login() {
    return {
      type: "oauth",
      access: "A0",
      refresh: "R0",
      expires: future(),
    };
  },
  async refresh(credential: OAuthCredential) {
    refreshCount += 1;
    return {
      ...credential,
      access: `${credential.access}+r`,
      expires: future(),
    };
  },
  async toAuth(credential: OAuthCredential) {
    return { apiKey: `key:${credential.access}` };
  },
};

const fakeApiKey: ApiKeyAuth = {
  name: "Test API key",
  async login(input) {
    return {
      type: "api_key",
      key: await input.prompt({
        type: "secret",
        message: "API key",
      }),
    };
  },
  async resolve({ credential }) {
    return credential?.key === undefined
      ? undefined
      : { auth: { apiKey: credential.key }, source: "Stored API key" };
  },
};

function replaceAuth(
  faux: FauxChatProvider,
  auth: { apiKey?: ApiKeyAuth; oauth?: OAuthAuth },
): void {
  const provider = faux.runtime.models.getProvider(faux.provider.id);
  if (provider === undefined) throw new Error("faux provider is not installed");
  faux.runtime.models.setProvider({ ...provider, auth });
}

// ── Canonical Models API-key lifecycle ─────────────────────────────────────

async function testApiKeyLifecycle(): Promise<void> {
  const faux = registerFauxProvider();
  replaceAuth(faux, { apiKey: fakeApiKey });
  const providerId = faux.provider.id;

  check(
    "api key: provider begins unconfigured",
    (await faux.runtime.models.checkAuth(providerId)) === undefined,
  );
  const credential = await faux.runtime.models.login(
    providerId,
    "api_key",
    interaction,
  );
  check(
    "api key: Models.login persists canonical credential",
    credential.type === "api_key" &&
      (await faux.runtime.credentials.read(providerId))?.type === "api_key",
  );
  const auth = await faux.runtime.models.getAuth(providerId);
  check(
    "api key: Models.getAuth derives request secret",
    auth?.auth.apiKey === "LOGIN_KEY" && auth.source === "Stored API key",
  );
  await faux.runtime.models.logout(providerId);
  check(
    "api key: Models.logout deletes stored credential",
    (await faux.runtime.credentials.read(providerId)) === undefined,
  );
  faux.unregister();
}

// ── Canonical OAuth lifecycle + locked refresh ─────────────────────────────

async function testOAuthLifecycle(): Promise<void> {
  const store = new MemoryCredentialStore();
  const faux = registerFauxProvider();
  // The helper owns a runtime-local store; exercise the same canonical API
  // against a separate store below for its raw locking semantics too.
  replaceAuth(faux, { oauth: fakeOAuth });
  const providerId = faux.provider.id;

  check(
    "oauth: provider begins logged out",
    (await faux.runtime.models.getAuth(providerId)) === undefined,
  );
  const loggedIn = await faux.runtime.models.login(
    providerId,
    "oauth",
    interaction,
  );
  check(
    "oauth: Models.login stores tagged OAuth credential",
    loggedIn.type === "oauth" &&
      (await faux.runtime.credentials.read(providerId))?.type === "oauth",
  );
  check(
    "oauth: Models.getAuth derives provider request key",
    (await faux.runtime.models.getAuth(providerId))?.auth.apiKey === "key:A0",
  );

  await faux.runtime.credentials.modify(providerId, async () => ({
    type: "oauth",
    access: "A1",
    refresh: "R1",
    expires: 0,
  }));
  refreshCount = 0;
  const refreshed = await faux.runtime.models.getAuth(providerId);
  check(
    "oauth: expired credential refreshes automatically",
    refreshed?.auth.apiKey === "key:A1+r" && refreshCount === 1,
  );
  check(
    "oauth: rotated credential is persisted",
    (await faux.runtime.credentials.read(providerId))?.type === "oauth" &&
      (await faux.runtime.credentials.read(providerId) as OAuthCredential)
        .access === "A1+r",
  );

  await faux.runtime.credentials.modify(providerId, async () => ({
    type: "oauth",
    access: "A2",
    refresh: "R2",
    expires: 0,
  }));
  refreshCount = 0;
  const concurrent = await Promise.all([
    faux.runtime.models.getAuth(providerId),
    faux.runtime.models.getAuth(providerId),
    faux.runtime.models.getAuth(providerId),
  ]);
  check(
    "oauth: concurrent getAuth calls refresh once under store lock",
    refreshCount === 1,
  );
  check(
    "oauth: concurrent callers receive the rotated key",
    concurrent.every((result) => result?.auth.apiKey === "key:A2+r"),
  );

  await faux.runtime.models.logout(providerId);
  check(
    "oauth: Models.logout clears credentials",
    (await faux.runtime.credentials.read(providerId)) === undefined,
  );

  // pi's in-memory store is also the public MemoryCredentialStore alias.
  await store.modify(PID, async () => ({
    type: "api_key",
    key: "memory",
  }));
  check(
    "store: MemoryCredentialStore is pi's canonical implementation",
    (await store.read(PID))?.type === "api_key",
  );
  faux.unregister();
}

// ── FileCredentialStore canonical format + legacy upgrade ──────────────────

async function testFileStore(dir: string): Promise<void> {
  const path = join(dir, "creds.json");
  const a = new FileCredentialStore(path);
  await a.modify(PID, async () => ({
    type: "oauth",
    access: "FA",
    refresh: "FR",
    expires: future(),
  }));
  const b = new FileCredentialStore(path);
  const persisted = await b.read(PID);
  check(
    "file store: canonical credential persists across instances",
    persisted?.type === "oauth" && persisted.access === "FA",
  );
  check(
    "file store: list exposes metadata without secrets",
    JSON.stringify(await b.list()) ===
      JSON.stringify([{ providerId: PID, type: "oauth" }]),
  );
  await b.delete(PID);
  check(
    "file store: delete removes the provider credential",
    (await new FileCredentialStore(path).read(PID)) === undefined,
  );

  const shared = new FileCredentialStore(join(dir, "shared.json"));
  await Promise.all(
    Array.from({ length: 8 }, (_value, index) =>
      shared.modify(`prov${index}`, async () => ({
        type: "api_key",
        key: `K${index}`,
      })),
    ),
  );
  const reader = new FileCredentialStore(join(dir, "shared.json"));
  const survived = await Promise.all(
    Array.from({ length: 8 }, (_value, index) =>
      reader.read(`prov${index}`),
    ),
  );
  check(
    "file store: serialized modifications do not lose providers",
    survived.every(
      (credential, index) =>
        credential?.type === "api_key" && credential.key === `K${index}`,
    ),
  );

  const legacyPath = join(dir, "legacy.json");
  writeFileSync(
    legacyPath,
    JSON.stringify({
      legacy: {
        access: "OLD_A",
        refresh: "OLD_R",
        expires: future(),
      },
    }),
  );
  const legacy = await new FileCredentialStore(legacyPath).read("legacy");
  check(
    "file store: legacy untagged OAuth row is normalized on read",
    legacy?.type === "oauth" && legacy.access === "OLD_A",
  );
}

// ── Request auth error and Operon's clean-401 retry policy ──────────────────

async function testRequestScopedModel(): Promise<void> {
  const failingFaux = registerFauxProvider();
  failingFaux.setResponses([
    fauxAssistantMessage("unused", { stopReason: "stop" }),
  ]);
  replaceAuth(failingFaux, { oauth: fakeOAuth });
  const failing = failingFaux.getChatModel()!;
  const failed = await new Runner({}).run(
    defineAgent({ name: "a", model: failing, instructions: "x" }),
    "hi",
  );
  check(
    "model: missing request credential surfaces as an error result",
    failed.status === "error" &&
      /auth|credential|configured/i.test(JSON.stringify(failed.messages)),
  );
  failingFaux.unregister();

  const workingFaux = registerFauxProvider();
  workingFaux.setResponses([
    fauxAssistantMessage("hello there", { stopReason: "stop" }),
  ]);
  const completed = await new Runner({}).run(
    defineAgent({
      name: "b",
      model: workingFaux.getChatModel()!,
      instructions: "x",
    }),
    "hi",
  );
  check(
    "model: provider-owned keyless auth still streams normally",
    completed.status === "completed" &&
      completed.output.includes("hello there"),
  );
  workingFaux.unregister();
}

async function test401Refresh(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "401 Unauthorized",
    }),
    fauxAssistantMessage("ok", { stopReason: "stop" }),
  ]);
  replaceAuth(faux, { oauth: fakeOAuth });
  const providerId = faux.provider.id;
  await faux.runtime.credentials.modify(providerId, async () => ({
    type: "oauth",
    access: "VALID",
    refresh: "R",
    expires: future(),
  }));

  refreshCount = 0;
  const result = await new Runner({}).run(
    defineAgent({
      name: "c",
      model: faux.getChatModel()!,
      instructions: "x",
    }),
    "hi",
  );
  const stored = await faux.runtime.credentials.read(providerId);
  check("401: forces exactly one OAuth refresh", refreshCount === 1);
  check(
    "401: clean pre-content retry completes",
    result.status === "completed" && result.output.includes("ok"),
  );
  check(
    "401: forced refresh persists the rotated token",
    stored?.type === "oauth" && stored.access === "VALID+r",
  );
  faux.unregister();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-auth-e2e-"));
  try {
    await testApiKeyLifecycle();
    await testOAuthLifecycle();
    await testFileStore(root);
    await testRequestScopedModel();
    await test401Refresh();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log(
      "✅ AUTH E2E PASS — Models login/getAuth/logout + locked OAuth refresh + canonical file store + clean-401 recovery",
    );
  } else {
    console.log("❌ AUTH E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ AUTH E2E ERROR:", error);
  process.exit(1);
});
