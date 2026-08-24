#!/usr/bin/env node
/**
 * Pack a built extension (`dist/`) into a distributable zip — zero dependencies.
 *
 *   pnpm release   (= pnpm build && node ../scripts/pack-extension.mjs, from the extension's folder;
 *                   not `pack` — that name is pnpm's own tarball command)
 *
 * Produces, under `release/`:
 *   <id>-<version>.zip          the contents of dist/ (manifest.json + index.js + …) at the zip root;
 *                               install = unzip into `<extensionDir>/<id>/`, then `harness.extensions.load(id)`
 *   <id>-<version>.zip.sha256   `sha256sum` format — what an installer verifies before unzipping
 *   <id>-<version>.json         the index entry a download site lists: manifest display fields + file + hash
 *
 * The zip is deterministic (fixed timestamps, sorted entries): the same dist/ always hashes the same.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = resolve(process.argv[2] ?? process.cwd());
const dist = join(root, "dist");
const manifestPath = join(dist, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`pack: cannot read ${manifestPath} — run the build first (${error.message})`);
  process.exit(1);
}
if (typeof manifest.id !== "string" || !manifest.id.trim()) {
  console.error("pack: manifest.json must declare a non-empty string \"id\"");
  process.exit(1);
}
const version = manifest.version ?? "0.0.0";

// ── Collect dist/ recursively, sorted, as zip entries ──────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const files = walk(dist).map((full) => ({ name: relative(dist, full).split("\\").join("/"), data: readFileSync(full) }));

// ── Minimal ZIP writer (deflate, UTF-8 names, fixed 1980-01-01 timestamps) ────────
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const DOS_TIME = 0x0000, DOS_DATE = 0x0021; // 1980-01-01 00:00:00 → reproducible archives
const FLAGS = 0x0800; // UTF-8 file names

const locals = [], centrals = [];
let offset = 0;
for (const { name, data } of files) {
  const nameBuf = Buffer.from(name, "utf8");
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(FLAGS), u16(8), u16(DOS_TIME), u16(DOS_DATE),
    u32(crc), u32(packed.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, packed,
  ]);
  centrals.push(Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(FLAGS), u16(8), u16(DOS_TIME), u16(DOS_DATE),
    u32(crc), u32(packed.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
    u32(0), u32(offset), nameBuf,
  ]));
  locals.push(local);
  offset += local.length;
}
const centralDir = Buffer.concat(centrals);
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralDir.length), u32(offset), u16(0),
]);
const zip = Buffer.concat([...locals, centralDir, eocd]);

// ── Write release/ ─────────────────────────────────────────────────────────────────
const releaseDir = join(root, "release");
mkdirSync(releaseDir, { recursive: true });
const base = `${manifest.id}-${version}`;
const sha256 = createHash("sha256").update(zip).digest("hex");
writeFileSync(join(releaseDir, `${base}.zip`), zip);
writeFileSync(join(releaseDir, `${base}.zip.sha256`), `${sha256}  ${base}.zip\n`);
const entry = {
  id: manifest.id,
  ...(manifest.name !== undefined ? { name: manifest.name } : {}),
  ...(manifest.description !== undefined ? { description: manifest.description } : {}),
  version,
  ...(manifest.engine !== undefined ? { engine: manifest.engine } : {}),
  file: `${base}.zip`,
  sha256,
  size: zip.length,
  files: files.map((f) => f.name),
};
writeFileSync(join(releaseDir, `${base}.json`), JSON.stringify(entry, null, 2) + "\n");
console.log(`packed ${manifest.id}@${version}: ${files.length} files, ${zip.length} bytes → release/${base}.zip  sha256 ${sha256.slice(0, 12)}…`);
