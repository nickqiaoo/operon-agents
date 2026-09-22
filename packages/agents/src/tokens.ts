/** Tokens for the objects this package adds on top of core (`Tokens` holds the core ones).
 *  Kept under its own name so `operon-agents` can export both without a clash. */
import { token } from "operon-agents-core";
import type { ExtensionRuntime } from "./extensions/runtime.ts";

export const HarnessTokens = Object.freeze({
  /** The session's extension runtime (the `extensions` capability's service). */
  Extensions: token<ExtensionRuntime, "session">("extensions", "session"),
});
