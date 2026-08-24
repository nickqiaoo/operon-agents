export interface RedactOptions {
  readonly mask?: string;
  readonly extraPatterns?: readonly RegExp[];
  readonly sensitiveKeyPattern?: RegExp;
  readonly maxDepth?: number;
}

const DEFAULT_MASK = "[REDACTED]";

const SENSITIVE_KEY_WORDS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "secretkey",
  "clientsecret",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "privatekey",
  "sessionkey",
  "bearer",
  "cookie",
  "setcookie",
]);

export function isSensitiveKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[_\-\s]/g, "");
  if (SENSITIVE_KEY_WORDS.has(compact)) return true;
  const segments = key
    .split(/[_\-\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    if (SENSITIVE_KEY_WORDS.has(segments[i]!)) return true;
    // Merge adjacent segments so multi-word keys whose secret word is itself split —
    // `x-api-key`/`x-goog-api-key` → ["x","api","key"], `access_key_id` → ["access","key","id"] —
    // still match `apikey`/`accesskey`. Without this they leak (no single segment matches, and an
    // opaque value matches no VALUE_PATTERN either).
    if (i + 1 < segments.length && SENSITIVE_KEY_WORDS.has(segments[i]! + segments[i + 1]!)) return true;
  }
  return false;
}

const VALUE_PATTERNS: readonly RegExp[] = [
  // PEM private-key blocks (any flavour).
  /-----BEGIN(?:[ A-Z]*)PRIVATE KEY-----[\s\S]*?-----END(?:[ A-Z]*)PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  // GitHub tokens (classic + fine-grained + app).
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  // AWS access key id, Slack, Google API keys.
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // JSON Web Tokens (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // `Authorization: Bearer <token>` / bare `Bearer <token>`.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

const KEY_VALUE_PATTERN =
  /\b(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|auth(?:orization)?|private[_-]?key|session[_-]?key)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"'&,;]+)/gi;

export function redactText(input: string, options: RedactOptions = {}): string {
  const mask = options.mask ?? DEFAULT_MASK;
  // Standalone secret shapes FIRST — e.g. `Authorization: Bearer <tok>` must be caught by the
  // Bearer pattern before the key=value pass (which would otherwise only mask the word "Bearer").
  let out = input;
  for (const re of VALUE_PATTERNS) out = out.replace(re, mask);
  for (const re of options.extraPatterns ?? []) out = out.replace(re, mask);
  out = out.replace(KEY_VALUE_PATTERN, (_m, key: string, sep: string) => `${key}${sep}${mask}`);
  return out;
}

export function redactDeep<T>(value: T, options: RedactOptions = {}): T {
  return walk(value, options, options.maxDepth ?? 16) as T;
}

function walk(value: unknown, options: RedactOptions, depth: number): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (depth <= 0 || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) return value.map((item) => walk(item, options, depth - 1));

  const customPattern = options.sensitiveKeyPattern;
  const sensitive = customPattern ? (key: string) => customPattern.test(key) : isSensitiveKey;
  const mask = options.mask ?? DEFAULT_MASK;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (sensitive(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      out[key] = mask;
    } else {
      out[key] = walk(item, options, depth - 1);
    }
  }
  return out;
}
