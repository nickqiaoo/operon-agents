# Steer & interrupt (+ human-in-the-loop approvals)

Three control-plane features you can't see from a plain prompt/response loop:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm start            # approvals + steer a running turn
ANTHROPIC_API_KEY=sk-ant-... pnpm start --cancel   # abort a run after 3s
```

## What it shows

- **Approvals (HITL).** With `permission: { mode: "manual" }`, every tool call pauses and
  routes to `session.setApprovalHandler(...)`. In a real app this is where you render a
  confirm dialog; here the handler approves file tools and **rejects `bash`**, returning
  `feedback` the model reads and adapts to. The four modes are `manual` (ask for everything),
  `workspace` (auto-approve inside the workspace), `yolo` (approve all — behind a sandbox),
  and `auto` (a model judge clears low-risk calls, escalating the rest).
- **Steer.** `session.steer(text)` injects a user message into the turn that is *already
  running* — the example changes the task the moment the first tool call starts, and the
  agent incorporates it without a new prompt.
- **Cancel.** `session.cancel()` aborts the in-flight run; the `RunResult.status` comes back
  `aborted`. `--cancel` starts a long write and cancels it after 3s.

## Related

- Persist an approval, close the process, and resume later → [`../durable-interruption`](../durable-interruption)
- Streaming basics → [`../local-quickstart`](../local-quickstart)
- The same control plane over HTTP (steer/cancel as routes) → [`../managed-agents`](../managed-agents)
