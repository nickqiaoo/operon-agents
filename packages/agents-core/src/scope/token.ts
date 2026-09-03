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

export interface Token<T> {
  readonly name: string;
  readonly scope: ScopeKind;
  /** Phantom — carries `T` for inference only; never present at runtime. */
  readonly __type?: T;
}

const declared = new Map<string, ScopeKind>();

export function token<T>(name: string, scope: ScopeKind): Token<T> {
  if (name.length === 0) throw new Error("token name must be non-empty");
  const prior = declared.get(name);
  if (prior !== undefined && prior !== scope) {
    throw new Error(`token "${name}" is already declared ${prior}-scoped; cannot redeclare it as ${scope}-scoped`);
  }
  declared.set(name, scope);
  return Object.freeze({ name, scope });
}

/** Test-only: forget every declaration (so a suite can redeclare with a different scope). */
export function resetTokenDeclarationsForTest(): void {
  declared.clear();
}
