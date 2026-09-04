/**
 * Outbound redaction for telemetry properties.
 *
 * Builds on `logging/redact.ts` (key-based masking + secret shapes) and adds the three shapes
 * that are fine in a log file but not in an analytics warehouse: emails, URLs and absolute
 * paths. Paths keep their `node_modules/` tail — that part is a package name, not the user's
 * directory layout, and it is what makes a dependency problem diagnosable.
 *
 * Runs in the appender, AFTER context merge, so context strings are covered too.
 */

import { redactText, type RedactOptions } from "../logging/redact.ts";
import type { TelemetryPrimitive } from "./events.ts";

const EMAIL = /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
const URL = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+/gi;
// Absolute POSIX paths (two or more segments) and Windows drive paths. Home-relative `~/x` too.
const ABSOLUTE_PATH = /(?:~|[A-Za-z]:)?(?:\/|\\)(?:[\w.@+-]+(?:\/|\\))+[\w.@+-]*/g;

export const REDACTED_EMAIL = "<redacted:email>";
export const REDACTED_URL = "<redacted:url>";
export const REDACTED_PATH = "<redacted:path>";

export function redactTelemetryString(value: string, options: RedactOptions = {}): string {
  let out = redactText(value, options);
  out = out.replace(URL, REDACTED_URL);
  out = out.replace(EMAIL, REDACTED_EMAIL);
  out = out.replace(ABSOLUTE_PATH, (match) => {
    const index = match.indexOf("node_modules/");
    return index === -1 ? REDACTED_PATH : match.slice(index);
  });
  return out;
}

export function redactTelemetryProperties(
  properties: Readonly<Record<string, TelemetryPrimitive>>,
  options: RedactOptions = {},
): Record<string, TelemetryPrimitive> {
  const out: Record<string, TelemetryPrimitive> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = typeof value === "string" ? redactTelemetryString(value, options) : value;
  }
  return out;
}

/** Bound a free-text property (error messages) so a stack trace never becomes an event. */
export function capTelemetryText(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
