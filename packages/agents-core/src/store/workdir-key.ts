import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

const WORKDIR_KEY_PREFIX = "wd_";
const HASH_LENGTH = 12;
const SLUG_MAX = 32;

// Known limitation: `resolve` only lexically normalizes — it does NOT resolve symlinks or fold
// case. So `/tmp/x` vs `/private/tmp/x` (a macOS ancestor symlink), or `/Users/Foo` vs
// `/Users/foo` (case-insensitive APFS), hash to DIFFERENT workdir keys and thus split one real
// directory across session namespaces. Deliberate (local-first: no realpath I/O on the hot path,
// and case-sensitivity can't be probed reliably); the risk is a split, not a collision.
export function normalizeWorkDir(workDir: string): string {
  return resolve(workDir);
}

export function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
  return slug.length > 0 ? slug : "root";
}

export function encodeWorkdirKey(workDir: string): string {
  const normalized = normalizeWorkDir(workDir);
  const slug = slugifyWorkDirName(basename(normalized));
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}
