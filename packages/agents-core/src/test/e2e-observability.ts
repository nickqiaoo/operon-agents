import { testRunner, openTestSession } from "./faux.ts";
import { token } from "../index.ts";
import {
  LocalMachine,
  ListenerSink,
  MemoryStore,
  RedactingSessionStore,
  RedactingSink,
  Session,
  consoleLogger,
  noopLogger,
  redactDeep,
  redactText,
  type AgentEvent,
  type Capability,
  type AgentRecord,
  type Logger,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const SECRETS = {
  anthropic: "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF",
  openai: "sk-ABCDEFGHIJ1234567890abcdef",
  bearer: "Authorization: Bearer abcdef0123456789xyz",
  jwt: "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fwpM",
  aws: "AKIAIOSFODNN7EXAMPLE",
  github: "ghp_0123456789012345678901234567890123456",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIabcdefonly\n-----END RSA PRIVATE KEY-----",
};

async function readAll(store: { readRecords(): AsyncIterable<AgentRecord> }): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const record of store.readRecords()) out.push(record);
  return out;
}

async function main(): Promise<void> {
  for (const [name, secret] of Object.entries(SECRETS)) {
    const red = redactText(`prefix ${secret} suffix`);
    check(`redactText masks ${name}`, red.includes("[REDACTED]") && !red.includes(secret.split(/\s|\n/).at(-1)!));
  }
  check("redactText keeps key in key=value", redactText("password=hunter2longvalue") === "password=[REDACTED]");
  check("redactText masks token: value", (() => {
    const r = redactText("token: abc123def456ghi");
    return r.startsWith("token:") && r.includes("[REDACTED]") && !r.includes("abc123def456ghi");
  })());
  const ordinary = "The quick brown fox jumps. version 1.2.3, select * from users where id = 42.";
  check("redactText leaves ordinary prose untouched", redactText(ordinary) === ordinary);

  const input = {
    role: "assistant",
    id: "e123",
    apiKey: "whatever-value",
    nested: { authorization: "Bearer x", note: `use ${SECRETS.openai} here` },
    list: ["plain", `key ${SECRETS.github}`],
  };
  const frozenCopy = JSON.parse(JSON.stringify(input));
  const out = redactDeep(input) as typeof input;
  check("redactDeep masks sensitive key by name", out.apiKey === "[REDACTED]" && out.nested.authorization === "[REDACTED]");
  check("redactDeep scrubs secrets inside nested strings", out.nested.note.includes("[REDACTED]") && !out.nested.note.includes(SECRETS.openai));
  check("redactDeep scrubs secrets inside arrays", out.list[0] === "plain" && out.list[1]!.includes("[REDACTED]"));
  check("redactDeep preserves structural fields", out.role === "assistant" && out.id === "e123");
  check("redactDeep does not mutate input", JSON.stringify(input) === JSON.stringify(frozenCopy));

  const store = new RedactingSessionStore(new MemoryStore());
  const record: AgentRecord = {
    eventId: "evt_redaction_test",
    time: 1_700_000_000_000,
    type: "context.append_message",
    message: { role: "assistant", content: [{ type: "text", text: `here is ${SECRETS.anthropic}` }], timestamp: 1_700_000_000_000 },
  };
  await store.appendRecord(record);
  const persisted = await readAll(store);
  const persistedText = JSON.stringify(persisted.find((r) => r.type === "context.append_message"));
  check("RedactingSessionStore masks secrets in wire records", persistedText.includes("[REDACTED]") && !persistedText.includes(SECRETS.anthropic));
  const appended = persisted.find((r) => r.type === "context.append_message");
  check("RedactingSessionStore preserves record envelope", appended?.type === "context.append_message" && appended.eventId === "evt_redaction_test" && persisted.some((r) => r.type === "metadata"));
  await store.putState("meta", { title: "ok" });
  check("RedactingSessionStore passes state through by default", JSON.stringify(await store.getState("meta")) === JSON.stringify({ title: "ok" }));

  const inner = new ListenerSink();
  const seen: AgentEvent[] = [];
  inner.subscribe((event) => seen.push(event));
  const sink = new RedactingSink(inner);
  await sink.emit({ type: "error", address: "main", sessionId: "s1", message: `boom ${SECRETS.bearer}` } as AgentEvent);
  const evt = seen[0] as AgentEvent & { message: string };
  check("RedactingSink masks secrets in event bodies", evt.message.includes("[REDACTED]") && !evt.message.includes("abcdef0123456789xyz"));
  check("RedactingSink preserves event envelope", evt.eventId.startsWith("evt_") && evt.address === "main" && evt.sessionId === "s1" && evt.type === "error");
  const childSeen: AgentEvent[] = [];
  inner.subscribe((event) => childSeen.push(event));
  await sink.child("sub").emit({ type: "warning", address: "", sessionId: "s1", message: `k ${SECRETS.github}` } as AgentEvent);
  check("RedactingSink.child redacts too", (childSeen.at(-1) as { message: string }).message.includes("[REDACTED]"));

  const lines: string[] = [];
  const logger = consoleLogger({ minLevel: "debug", write: (line) => lines.push(line) });
  logger.log("debug", "low");
  logger.log("warn", `token leak ${SECRETS.openai}`, { apiKey: "secret-field", ok: 1 });
  check("consoleLogger emits below-threshold debug when minLevel=debug", lines.some((l) => l.includes("[debug] low")));
  check("consoleLogger redacts message + fields by default", lines.some((l) => l.includes("[REDACTED]") && !l.includes(SECRETS.openai) && !l.includes("secret-field")));
  const quiet: string[] = [];
  consoleLogger({ write: (l) => quiet.push(l) }).log("debug", "dropped");
  check("consoleLogger drops below minLevel (default info)", quiet.length === 0);
  noopLogger.log("error", "nothing"); // must not throw
  check("noopLogger is a silent no-op", true);

  const captured: string[] = [];
  const wiringLogger: Logger = { log: (level, message) => captured.push(`${level}:${message}`) };
  const boom: Capability = {
    name: "boom",
    provides: [{ token: token("boom", "session"), create: async () => { throw new Error("kapow"); } }],
  };
  const session = await openTestSession({ machine: new LocalMachine(process.cwd()), events: new ListenerSink(), logger: wiringLogger, capabilities: [boom] });
  await session.close();
  check("Session routes capability provision failure to the logger", captured.some((l) => l.startsWith("error:") && l.includes("boom")));

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ OBSERVABILITY E2E PASS — redact (text/deep) + redacting store/sink + logger + session wiring");
  } else {
    console.log("❌ OBSERVABILITY E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ OBSERVABILITY E2E ERROR:", error);
  process.exit(1);
});
