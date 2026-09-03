/** Tokens for the objects this package adds on top of core (`T` holds the core ones). */
import { token } from "operon-agents-core";
import type { ExtensionRuntime } from "./extensions/runtime.ts";

export const HT = Object.freeze({
  /** The session's extension runtime (the `extensions` capability's service). */
  Extensions: token<ExtensionRuntime>("extensions", "session"),
});
