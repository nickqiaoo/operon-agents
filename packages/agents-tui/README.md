# operon-agents-tui

A terminal client for `operon-agents`, built with `@earendil-works/pi-tui` and wired only through the public Harness API.

```bash
ANTHROPIC_API_KEY=... pnpm --filter operon-agents-tui build
ANTHROPIC_API_KEY=... pnpm --filter operon-agents-tui start -- \
  --model anthropic/claude-opus-4-8 \
  --work-dir /path/to/project
```

The default permission mode is `manual`, so tool calls are presented as interactive approval dialogs. Use `--permission workspace` to auto-approve operations confined to the workspace, or `--yolo` only in a sandbox.

Sessions persist below `~/.operon/sessions`. Resume the latest session for the current workspace with `--continue`, resume a specific one with `--session <id>`, or use `/sessions` inside the TUI.

## Interaction

- Enter submits a prompt. While a turn is active, a normal submission steers that turn.
- `/follow-up <message>` queues a message for the next turn.
- Ctrl+C cancels the active dialog/run, clears non-empty input, then exits.
- Ctrl+D exits when the editor is empty.
- `/help` lists session, model, thinking, permission, compaction, and background controls.

The renderer handles assistant/thinking deltas, tool calls/progress/results, subagent addresses, guardrails, compaction, live approvals/questions, and durable interruption resume.
