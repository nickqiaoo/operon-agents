/**
 * How a refused tool call was refused, carried on its error result's `details` so the session
 * record — and the `auto`-mode judge reading it later — can tell a user's "no" from a rule, from
 * the judge's own block. The values are the outcome words the judge's prompt defines.
 */
export type PermissionDenialKind =
  | "rejected-by-user" // a person declined this call
  | "blocked-by-permissions" // a deny rule / policy refused it before it ran
  | "automode-blocked" // the auto-mode judge judged it dangerous
  | "automode-unavailable"; // the judge could not be reached; held back fail-closed

const KINDS: ReadonlySet<string> = new Set<PermissionDenialKind>([
  "rejected-by-user",
  "blocked-by-permissions",
  "automode-blocked",
  "automode-unavailable",
]);

/** The `details` shape a refused call's error result carries. */
export interface PermissionDenialDetails {
  readonly permissionDenial: PermissionDenialKind;
  /** With `automode-blocked`: the BLOCK rule the judge named. */
  readonly category?: string;
}

export function permissionDenialDetails(kind: PermissionDenialKind, category?: string): PermissionDenialDetails {
  return { permissionDenial: kind, ...(category !== undefined ? { category } : {}) };
}

/** The denial kind recorded on a tool result's `details`, if any. */
export function permissionDenialOf(details: unknown): PermissionDenialKind | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const kind = (details as { permissionDenial?: unknown }).permissionDenial;
  return typeof kind === "string" && KINDS.has(kind) ? (kind as PermissionDenialKind) : undefined;
}
