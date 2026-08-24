# Goals & the conversation log

A **goal-driven** session with a turn/token budget, then reading the flat **conversation
log** back out.

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm start
```

## What it shows

- **Goals.** `session.createGoal({ objective, budget: { turns, tokens } })` sets a standing
  objective. The agent works toward it and the budget bounds the effort; `session.getGoal()`
  reports `status`, `turnsUsed`, `tokensUsed`, and what's remaining. Goals also have a
  lifecycle — `pauseGoal` / `resumeGoal` / `cancelGoal` / `setGoalBudget`.
- **The log is the source of truth.** A session is a *flat, linear, append-only* record
  stream (one shard per agent address). `session.getRecords()` returns it. The example prints
  the record-type histogram (`metadata`, `context.append_message`, `usage.record`, …) and
  rebuilds the transcript from the `context.append_message` records — which is exactly what
  the engine does internally to reconstruct history (`reduceHistory`). Because it's a log, a
  resumed session replays to the same state.

## Related

- Streaming basics → [`../local-quickstart`](../local-quickstart)
- Mid-run control → [`../steer-and-interrupt`](../steer-and-interrupt)
