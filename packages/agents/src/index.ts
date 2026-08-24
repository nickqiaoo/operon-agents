/**
 * `operon-agents` — the batteries-included public API (Mode 2).
 *
 *   import { createHarness } from "operon-agents"
 *
 * The headline is the Harness facade + deployment presets. The whole (curated) core engine
 * is re-exported here for convenience — `operon-agents-core` defines its own public surface,
 * so this dump is already clean: engine plumbing (the turn/step loop, store migration/blob
 * machinery, capability assembly, …) is NOT here — it lives on `operon-agents/internal`
 * (≡ `operon-agents-core/internal`) for advanced embedders.
 *
 * For the low-level "assemble it yourself" path, import from `operon-agents/core`.
 */

export * from "./harness.ts";
// Extensions are a harness concept: they need the session/provider reach only this layer has.
// Core supplies the primitives they are built on (Capability / LoopHooks / ToolFilter / Injector).
export * from "./extensions/index.ts";
export * from "./cron/index.ts";

// Deployment composition roots: local vs server injection presets (Invariant 7 — no engine "mode").
export * from "./local.ts";

// The curated core engine, re-exported for convenience; `operon-agents/core` is the dedicated
// primitives entrypoint.
export * from "operon-agents-core";

export * as llm from "operon-agents-core/llm";
export * as mcp from "operon-agents-core/mcp";
export * as protocol from "operon-agents-core/protocol";
export * as tools from "operon-agents-core/tools";
export * as tracing from "operon-agents-core/tracing";
