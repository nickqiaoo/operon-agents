# Local quickstart

The smallest useful program: **one local session, one prompt, streamed events**.
Tools run on your machine, scoped to `./workspace`. Sessions persist under
`./.agent-home` (so they're resumable).

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm start
ANTHROPIC_API_KEY=sk-ant-... pnpm start "count the lines in package.json"
```

## What it shows

- `createLocalSession(...)` — the **local composition root**. It bundles the
  local-deployment backends (disk sessions, local machine, cron on) so you
  don't wire them by hand. One call gets you a session ready to `prompt()`.
- **Streaming**: `session.promptStream(task)` is async-iterable over `AgentEvent`s
  (`assistant.delta`, `tool.call.started`, `tool.result`, …) and exposes `.completed`
  for the final `RunResult`.
- **Permission**: `{ mode: "workspace" }` auto-approves tool calls that stay inside
  the workspace — the safe default when tools run on your own machine (vs `yolo`,
  which only makes sense behind a sandbox).

## Next

- Steer a running turn / handle approvals → [`../steer-and-interrupt`](../steer-and-interrupt)
- Goals + reading the conversation log → [`../goals-and-transcript`](../goals-and-transcript)
- Put it behind HTTP → [`../managed-agents`](../managed-agents)
