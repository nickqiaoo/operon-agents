/**
 * Mode 1 — low-level primitives (the engine, assemble-it-yourself).
 *
 * `import { Runner, defineAgent, defineModel } from 'operon-agents/core'`
 *
 * Everything the core engine exposes: Runner / Session / Agent / capabilities /
 * machines / tools. Pass no machine and omit file tools to run a stateless,
 * no-filesystem agent (a `NullMachine` refuses any stray I/O). For the
 * batteries-included facade, import from `operon-agents` instead.
 */
export * from "operon-agents-core";
