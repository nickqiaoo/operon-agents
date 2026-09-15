import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The package version, read from package.json at runtime. */
export function getVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
