# Durable interruption and resume

This example shows the persisted human-in-the-loop path. It is different from registering a
live `setApprovalHandler`: no handler is installed, so `permission: { mode: "manual" }` pauses
the run and writes its bounded control tree to `SessionStore["interrupt"]`.

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm start
```

The script performs two process-shaped phases:

1. Start a session and ask the agent to call `Write`.
2. Receive `status: "interrupted"`; the file has not been written yet.
3. Inspect the persisted `InterruptionState`, then close the session and the entire Harness.
4. Create a fresh Harness over the same `homeDir` and call `resumeSession(sessionId)`.
5. Answer each pending control by its globally unique `approvalId` and call
   `session.resume(answers)`.
6. The Runner replays the appropriate log shard, validates its assistant anchor, executes the
   approved tool, and removes the `interrupt` key after the root agent completes.

The application-facing loop is intentionally small:

```ts
while (result.status === "interrupted") {
  const answers = Object.fromEntries(
    result.interruptions!.map((item) => [item.approvalId, { decision: "approved" }]),
  );
  result = await session.resume(answers);
}
```

`result.interruptions` is already flattened across the paused foreground Agent tree. A parent
with parallel subagents needs no special recovery API: completed siblings are in the parent log,
while unresolved child frames surface their own `approvalId`, `agent`, and `address` here.

Conversation messages are not duplicated in `InterruptionState`; each frame keeps only control
data and an anchor into its log shard.

The example also gives the Harness an `AppContext` containing an `audit` function. This context is
available to typed Agent callbacks but is not serialized. The second process supplies a fresh
context object when it creates its Harness; alternatively it could use:

```ts
const session = await harness.resumeSession(sessionId, { context: freshContext });
session.setContext(replacementContext); // affects subsequent prompt/resume calls
```

## Related

- Live, in-memory approval handler → [`../steer-and-interrupt`](../steer-and-interrupt)
- Durable approval over the app-server protocol → [`../app-server`](../app-server)
