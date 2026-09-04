import { createTelemetryService, PostHogAppender, type PostHogClientLike } from "../src/telemetry.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface Captured {
  distinctId?: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp?: Date;
}

function fakeClient(): PostHogClientLike & { captured: Captured[]; flushes: number; shutdowns: number } {
  const client = {
    captured: [] as Captured[],
    flushes: 0,
    shutdowns: 0,
    capture(message: Captured): void {
      client.captured.push(message);
    },
    flush(): Promise<void> {
      client.flushes += 1;
      return Promise.resolve();
    },
    shutdown(): Promise<void> {
      client.shutdowns += 1;
      return Promise.resolve();
    },
  };
  return client;
}

async function main(): Promise<void> {
  // ── Mode (b): injected client — identity is the product's, nothing is dropped for lack of it ──
  {
    const client = fakeClient();
    const warnings: string[] = [];
    const appender = new PostHogAppender({ client, app: { name: "operon", version: "1.2.3" }, warn: (m) => warnings.push(m) });
    const service = createTelemetryService({ now: () => 1_700_000_000_000 });
    service.addAppender(appender);
    const session = service.withContext({ session_id: "s1" });

    session.track("turn_error", { turn_id: "t1", message: "failed for nick@example.com at /Users/me/x.ts" });
    const e = client.captured[0];
    check("injected: event reaches the client without a distinctId", client.captured.length === 1 && e?.distinctId === undefined && e?.event === "turn_error");
    check(
      "injected: enriched with app_name/app_version/framework_version/platform + context",
      e?.properties.app_name === "operon" &&
        e?.properties.app_version === "1.2.3" &&
        typeof e?.properties.framework_version === "string" &&
        e?.properties.platform === process.platform &&
        e?.properties.session_id === "s1",
    );
    check("injected: redacted on the way out", e?.properties.message === "failed for <redacted:email> at <redacted:path>");
    check("injected: service clock becomes the capture timestamp", e?.timestamp instanceof Date && e.timestamp.getTime() === 1_700_000_000_000);

    await service.flush();
    await service.shutdown();
    // The service detaches appenders on shutdown; poke the appender directly for its own guard.
    appender.track({ name: "session_started", properties: {}, timestamp: 0 });
    check("injected: flush/shutdown forwarded once; track after shutdown is dropped", client.flushes === 1 && client.shutdowns === 1 && client.captured.length === 1 && appender.dropped === 1);
    check("injected: no warnings in the happy path", warnings.length === 0);
  }

  // ── Mode (a): appender-owned client via the createClient seam ─────────────────────────────────
  {
    const client = fakeClient();
    let seenApiKey = "";
    let seenHost = "";
    const warnings: string[] = [];
    let distinctId: string | undefined = undefined;
    const appender = new PostHogAppender({
      apiKey: "phc_test",
      host: "https://eu.i.posthog.com",
      app: { name: "other-product" },
      getDistinctId: () => distinctId,
      warn: (m) => warnings.push(m),
      createClient: (apiKey, options) => {
        seenApiKey = apiKey;
        seenHost = options.host;
        return client;
      },
    });
    const service = createTelemetryService({ now: () => 1 });
    service.addAppender(appender);

    // No distinct id yet → dropped, never substituted.
    service.track("session_started", { resumed: false });
    await appender.flush();
    check("owned: createClient received apiKey + host", seenApiKey === "phc_test" && seenHost === "https://eu.i.posthog.com");
    check("owned: undefined distinctId drops the event and warns once", client.captured.length === 0 && appender.dropped === 1 && warnings.length === 1);

    service.track("session_started", { resumed: true });
    check("owned: second drop does not warn again", appender.dropped === 2 && warnings.length === 1);

    distinctId = "user_42";
    service.track("compaction", { before_tokens: 10, after_tokens: 5, compacted_count: 1 });
    const e = client.captured[0];
    check("owned: with a distinctId the event is captured under it", client.captured.length === 1 && e?.distinctId === "user_42" && e?.properties.app_version === null);
    await service.shutdown();
    check("owned: shutdown forwarded to the owned client", client.shutdowns === 1);
  }

  // ── Mode (a): events before the client resolves are queued, then flushed in order ─────────────
  {
    const client = fakeClient();
    // `createClient` is sync but the appender resolves it through a promise, so anything tracked
    // synchronously after construction lands in the pending queue — the same path a slow
    // `import("posthog-node")` takes.
    const appender = new PostHogAppender({ apiKey: "k", host: "h", app: { name: "p" }, getDistinctId: () => "u", warn: () => {}, createClient: () => client });
    const service = createTelemetryService({ now: () => 1 });
    service.addAppender(appender);
    service.track("session_started", { resumed: false });
    service.track("session_started", { resumed: true });
    check("owned: nothing captured before the client resolved", client.captured.length === 0);
    await appender.flush();
    check("owned: events tracked before the client resolved were delivered in order", client.captured.length === 2 && client.captured[1]?.properties.resumed === true);
    await service.shutdown();
  }

  // ── Client that throws is contained ───────────────────────────────────────────────────────────
  {
    const warnings: string[] = [];
    const appender = new PostHogAppender({
      client: {
        capture: () => {
          throw new Error("network down");
        },
      },
      app: { name: "p" },
      warn: (m) => warnings.push(m),
    });
    const service = createTelemetryService();
    service.addAppender(appender);
    service.track("session_started", { resumed: false });
    service.track("session_started", { resumed: false });
    check("throwing client: contained and warned once", warnings.length === 1 && warnings[0]?.includes("capture threw") === true);
    await service.shutdown();
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
