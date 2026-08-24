#!/usr/bin/env node
/**
 * Set the version of every publishable package in one go.
 *
 * Internal dependencies are declared as `workspace:*` and resolved to the real version at pack
 * time, so only the `version` field of each package has to move — nothing references these
 * numbers by hand. The private packages (agents-tui, codex-chat-ui) are deliberately left alone:
 * they are never published and their 0.0.0 says so.
 *
 * Usage:  node scripts/set-version.mjs 0.1.0-alpha.1
 *         pnpm version:set 0.1.0-alpha.1
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Publish order is irrelevant here, but this is the same set the publish workflow ships. */
const PACKAGES = ["agents-core", "agents", "agents-peers", "managed-agents", "sandbox", "os-sandbox"];

// Deliberately strict: a typo here becomes an unpublishable tag or, worse, a wrong one that
// cannot be taken back once npm has it.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const version = process.argv[2];
if (version === undefined) {
  console.error("usage: pnpm version:set <version>   e.g. pnpm version:set 0.1.0-alpha.1");
  process.exit(1);
}
if (!SEMVER.test(version)) {
  console.error(`"${version}" is not a valid semver version (e.g. 0.1.0, 0.1.0-alpha.1)`);
  process.exit(1);
}

let changed = 0;
for (const dir of PACKAGES) {
  const path = `packages/${dir}/package.json`;
  const before = readFileSync(path, "utf8");
  // Rewrite the field in place rather than reserialising, so formatting and key order survive.
  const after = before.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  const parsed = JSON.parse(after);
  if (parsed.version !== version) {
    console.error(`failed to set the version in ${path} — is the "version" field missing?`);
    process.exit(1);
  }
  const previous = JSON.parse(before).version;
  if (after !== before) {
    writeFileSync(path, after);
    changed += 1;
  }
  console.log(`  ${parsed.name.padEnd(24)} ${previous} → ${version}`);
}

console.log(
  changed === 0
    ? `\nAlready at ${version}; nothing to do.`
    : `\n${changed} package(s) set to ${version}. Commit, push to the open-source repo, then run the Publish workflow.`,
);
