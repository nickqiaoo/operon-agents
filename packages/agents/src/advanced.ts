/**
 * `operon-agents/advanced` — everything beyond the main entry point: extension and cron plumbing,
 * custom capabilities, stores, providers, MCP wiring and the event and store contracts.
 *
 * Supported, but for hosts composing their own deployment. Most applications only need
 * `operon-agents`. Engine internals with no stability guarantee live on `operon-agents/internal`.
 */
export * from "./harness.ts";
export * from "./extensions/index.ts";
export * from "./cron/index.ts";
export * from "./providers.ts";
export * from "./local.ts";
export * from "./workspace-mcp.ts";
export * from "operon-agents-core";
