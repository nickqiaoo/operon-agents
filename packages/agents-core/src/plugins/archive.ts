import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function downloadZip(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function extractZip(buffer: Buffer, destDir: string): Promise<string> {
  const unzipSync = await loadUnzip();
  const entries = unzipSync(new Uint8Array(buffer)) as Record<string, Uint8Array>;
  const root = path.resolve(destDir);
  const topLevel = new Set<string>();
  for (const name of Object.keys(entries)) {
    const first = name.split("/")[0];
    if (first) topLevel.add(first);
  }
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue; // directory entry
    // zip-slip guard: the archive is untrusted remote content. A crafted entry name
    // (`../../../.zshrc`, or an absolute path) would otherwise `path.join` OUTSIDE destDir
    // and overwrite arbitrary files. Resolve and require containment; a violation means a
    // malicious archive, so refuse the whole extraction rather than partially installing it.
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Refusing to extract zip entry "${name}": resolves outside the destination directory (zip-slip).`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  // GitHub archives nest under `repo-ref/`; descend into a lone top-level dir.
  return topLevel.size === 1 ? path.join(destDir, [...topLevel][0]!) : destDir;
}

async function loadUnzip(): Promise<(data: Uint8Array) => Record<string, Uint8Array>> {
  try {
    // Non-literal specifier so TS infers `any` and does NOT resolve the optional dep at
    // typecheck — it loads only at call time (same posture as operon-agents-mcp's SDK import).
    const specifier = "fflate";
    const mod = (await import(specifier)) as { unzipSync?: (d: Uint8Array) => Record<string, Uint8Array> };
    if (typeof mod.unzipSync !== "function") throw new Error("fflate.unzipSync missing");
    return mod.unzipSync;
  } catch (error) {
    throw new Error(
      `Zip extraction requires the optional "fflate" dependency (install it to use zip-url / github plugin sources). Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
