/**
 * Workflow sandbox — script compilation plus determinism/escape hardening:
 *   - the async IIFE runs in `'use strict'`, so `with` is a SyntaxError and
 *     silent-failure footguns become throws;
 *   - dynamic `import()` is rejected (no importModuleDynamically callback is
 *     provided to vm, so any import() throws — we machine a clear message).
 *
 * Node's built-in `vm` is NOT a security sandbox on its own; the hardening here
 * covers the realistic failure modes: strip `constructor`/`prototype` off injected functions,
 * make Date/Math.random throw (so runs are deterministic and journaling/resume
 * is stable), and remove a few escape-prone globals. The script is authored by
 * our own model, so this guards against non-determinism + casual escapes rather
 * than a determined attacker.
 */

import vm from "node:vm";
import { WORKFLOW_VM_TIMEOUT_MS } from "./types.ts";

export type CompileResult = { ok: true; vmScript: vm.Script } | { ok: false; error: string };

/** Wrap the script body in a strict async IIFE, syntax-check it, then compile. */
export function compileScriptBody(body: string): CompileResult {
  const wrapped = `(async () => {'use strict';\n${body}\n})()`;
  try {
    // Parse-only pre-check (does not execute) for a clean SyntaxError message.
    // 'use strict' here too so `with`/duplicate params/etc. are caught the same way.
    // eslint-disable-next-line no-new-func
    new Function(`async function _check() {'use strict';\n${body}\n}`);
    return { ok: true, vmScript: new vm.Script(wrapped, { filename: "workflow.js" }) };
  } catch (err) {
    return { ok: false, error: `SyntaxError: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const NOW_ERR =
  "Date.now() / new Date() are unavailable in workflow scripts (breaks resume). " +
  "Stamp results after the workflow returns, or pass timestamps via args.";
const RANDOM_ERR =
  "Math.random() is unavailable in workflow scripts (breaks resume). " +
  "For N independent samples, include the index in the agent label or prompt.";

/** Determinism shim — Date/Math.random throw. */
const DETERMINISM_SHIM = `(() => {
  const NOW_ERR = ${JSON.stringify(NOW_ERR)};
  const RANDOM_ERR = ${JSON.stringify(RANDOM_ERR)};
  Math.random = function random() { throw new Error(RANDOM_ERR); };
  const RealDate = Date;
  RealDate.now = function now() { throw new Error(NOW_ERR); };
  function ShimDate(...a) {
    if (!new.target) throw new Error(NOW_ERR);
    if (a.length === 0) throw new Error(NOW_ERR);
    return Reflect.construct(RealDate, a, new.target);
  }
  ShimDate.now = RealDate.now;
  ShimDate.parse = RealDate.parse;
  ShimDate.UTC = RealDate.UTC;
  ShimDate.prototype = RealDate.prototype;
  RealDate.prototype.constructor = ShimDate;
  Object.freeze(RealDate);
  globalThis.Date = ShimDate;
})()`;

/** Escape hardening — neuter stack-trace backdoor, drop escape-prone globals. */
const ESCAPE_SHIM = `(() => {
  Object.defineProperty(Error, 'prepareStackTrace', {
    value: (err, sites) => String(err && err.stack ? err.stack : err),
    writable: false, configurable: false,
  });
  try { delete globalThis.ShadowRealm; } catch {}
  try { delete globalThis.WebAssembly; } catch {}
})()`;

/**
 * Strip `constructor`/`prototype` off an injected function and null its
 * prototype, so script code cannot reach the host `Function` constructor
 * via `agent.constructor("...")`.
 */
export function harden<T extends object>(fn: T): T {
  Object.setPrototypeOf(fn, null);
  const f = fn as unknown as { constructor?: unknown; prototype?: unknown };
  delete f.constructor;
  delete f.prototype;
  return fn;
}

/** Create a hardened VM context populated with the given globals. */
export function createSandboxContext(globals: Record<string, unknown>): vm.Context {
  const context = vm.createContext(globals);
  vm.runInContext(DETERMINISM_SHIM, context);
  vm.runInContext(ESCAPE_SHIM, context);
  return context;
}

/** Run a compiled workflow script in a hardened context. Returns its resolved value. */
export async function runCompiled(vmScript: vm.Script, context: vm.Context): Promise<unknown> {
  // The timeout bounds only the SYNCHRONOUS prefix until the first await; long
  // agent() awaits are not killed by it. A purely-synchronous infinite loop is.
  const result = await vmScript.runInContext(context, { timeout: WORKFLOW_VM_TIMEOUT_MS });
  return result;
}
