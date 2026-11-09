# operon-agents-core

Internal engine for `operon-agents`.

Application code should import from `operon-agents`. This package intentionally
contains lower-level runtime, loop, permission, storage, and capability modules
that may change as the engine evolves.

## Execution recovery

`Runner.run` and `runStream` reconcile abandoned lifecycle frames before a Session's
first fresh run, under its run lock and any configured `SessionLock`. Durable
approval/input pauses remain resumable through `Runner.resume`. `Session.open`
alone never closes unfinished turns: opening is not proof that another executor died.

Hosts can call `recoverOrphanedTurns` without opening a Session, or
`closeOrphanedTurns` to receive the committed repair events for broadcasting.
Both require exclusive execution ownership. For stores shared across processes,
provide a distributed lock to Runner or acquire a host-managed lease before takeover.
Recovery closes orphan frames; it does not retry tools with unknown side effects.
