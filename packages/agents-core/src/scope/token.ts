/**
 * Typed, scope-declaring keys for the {@link Scope} registry.
 *
 * A token names one service and says which tier it lives in. Registration checks the tier
 * (`Scope.register` refuses a session-scoped token in a harness scope), so "how many copies of
 * this exist" is written once, on the token, instead of being implied by wherever the `new`
 * happens to sit.
 *
 * Tokens compare by NAME: two `token("goal", "session")` calls are interchangeable (a file
 * extension re-importing the framework gets equivalent tokens). Declaring the same name with a
 * different scope is a bug and throws at declaration time.
 */

export type ScopeKind = "harness" | "workspace" | "session";

export const SCOPE_ORDER: readonly ScopeKind[] = ["harness", "workspace", "session"];

/**
 * `K` is the tier the token is declared in, as a literal type: `Scope<K>.register` only accepts
 * a `Token<_, K>`, so putting a session token in a harness scope is a COMPILE error (the
 * runtime check stays for untyped callers). Lookups (`get` / `require` / `handle`) take any tier.
 */
export interface Token<T, K extends ScopeKind = ScopeKind> {
  readonly name: string;
  readonly scope: K;
  /**
   * Who normally registers this, as a noun phrase ending in what the caller would DO about it:
   * `the "goal" capability — pass it in \`capabilities\``. A missing-service error quotes it, so
   * the stack trace names the fix instead of only the symptom. Optional: a token without one
   * fails with the bare name, as before.
   */
  readonly providedBy?: string;
  /** Phantom — carries `T` for inference only; never present at runtime. */
  readonly __type?: T;
}

interface Declaration {
  readonly scope: ScopeKind;
  readonly providedBy?: string;
}

const declared = new Map<string, Declaration>();

/**
 * Declare a token. The tier comes from the ARGUMENT, and these overloads exist so it survives
 * into the type even when only `T` is written out: `token<Thing>("thing", "workspace")` must be
 * a `Token<Thing, "workspace">`, not a `Token<Thing, ScopeKind>`. TypeScript stops inferring the
 * remaining parameters as soon as one is given explicitly, and a widened tier would silently
 * switch off the dependency rules that read it.
 */
export function token<T>(name: string, scope: "harness", providedBy?: string): Token<T, "harness">;
export function token<T>(name: string, scope: "workspace", providedBy?: string): Token<T, "workspace">;
export function token<T>(name: string, scope: "session", providedBy?: string): Token<T, "session">;
export function token<T, K extends ScopeKind>(name: string, scope: K, providedBy?: string): Token<T, K>;
export function token<T, K extends ScopeKind = ScopeKind>(name: string, scope: K, providedBy?: string): Token<T, K> {
  if (name.length === 0) throw new Error("token name must be non-empty");
  const prior = declared.get(name);
  if (prior !== undefined && prior.scope !== scope) {
    throw new Error(`token "${name}" is already declared ${prior.scope}-scoped; cannot redeclare it as ${scope}-scoped`);
  }
  declared.set(name, { scope, providedBy: providedBy ?? prior?.providedBy });
  return Object.freeze(providedBy === undefined ? { name, scope } : { name, scope, providedBy });
}

/**
 * A capability's service token. The token name IS the capability name unless they had to differ
 * (`mcp-session`, `user-hooks`), so the hint writes itself — and every such service gets the same
 * "this capability was not passed in" explanation rather than a per-token improvisation.
 */
export function capabilityToken<T>(name: string, capability: string = name): Token<T, "session"> {
  return token<T, "session">(name, "session", `the "${capability}" capability — pass it in \`capabilities\``);
}

/** The `providedBy` hint declared for a token name, for error paths that hold only the name. */
export function providerHintOf(name: string): string | undefined {
  return declared.get(name)?.providedBy;
}

/** Test-only: forget every declaration (so a suite can redeclare with a different scope). */
export function resetTokenDeclarationsForTest(): void {
  declared.clear();
}
