import { posix, win32 } from 'node:path';
import type { FileInfo, DirEntry, RunCommandOptions, RunCommandResult, Environment, EnvironmentFiles, EntryInfo, FileData, WriteInfo, WriteEntry, ByteRange } from './environment.ts';
import { codedError } from './environment-commands.ts';
export async function toBuffer(data: FileData): Promise<Buffer> {
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  const chunks: Buffer[] = [];
  if ('getReader' in data) {
    const reader = data.getReader();
    try { while (true) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); } }
    finally { reader.releaseLock(); }
  } else { for await (const chunk of data) chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export function sliceRange(bytes: Buffer, range?: ByteRange): Buffer {
  const offset = range?.offset ?? 0;
  return bytes.subarray(offset, range?.length === undefined ? undefined : offset + range.length);
}
export abstract class BaseFiles implements EnvironmentFiles {
  protected environment: Environment;
  constructor(environment: Environment) { this.environment = environment; }
  protected absolute(path: string): string {
    const paths = this.environment.pathClass() === 'win32' ? win32 : posix;
    return paths.resolve(this.environment.getcwd(), path);
  }
  abstract read(path: string, options?: { range?: ByteRange }): Promise<Buffer>;
  abstract write(path: string, data: FileData): Promise<WriteInfo>;
  abstract makeDir(path: string): Promise<boolean>;
  abstract getInfo(path: string, options?: { followSymlinks?: boolean }): Promise<EntryInfo>;
  protected abstract listShallow(path: string): Promise<readonly EntryInfo[]>;
  async list(path: string, options?: { depth?: number }): Promise<readonly EntryInfo[]> {
    const depth = options?.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 1) throw new RangeError('depth must be a positive integer');
    const result: EntryInfo[] = [];
    let pending = [this.absolute(path)];
    for (let level = 0; level < depth && pending.length; level++) {
      const next: string[] = [];
      for (const dir of pending) {
        const entries = level === 0 ? await this.listShallow(dir) : await this.listShallow(dir).catch(() => []);
        result.push(...entries);
        for (const entry of entries) if (entry.kind === 'dir') next.push(entry.path);
      }
      pending = next;
    }
    return result;
  }
  async exists(path: string): Promise<boolean> {
    try { await this.getInfo(path, { followSymlinks: false }); return true; }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
  }
  async writeFiles(files: readonly WriteEntry[]): Promise<readonly WriteInfo[]> {
    const written: WriteInfo[] = [];
    for (const file of files) written.push(await this.write(file.path, file.data));
    return written;
  }
  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const data = await this.read(path);
    return new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } });
  }
  async rename(oldPath: string, newPath: string): Promise<EntryInfo> {
    await this.getInfo(oldPath, { followSymlinks: false });
    const paths = this.environment.pathClass() === 'win32' ? win32 : posix;
    await this.getInfo(paths.dirname(this.absolute(newPath)));
    const result = await this.environment.commands.run(['mv', '--', this.absolute(oldPath), this.absolute(newPath)]);
    if (result.exitCode !== 0) throw codedError(result.stderr, 'EIO');
    return this.getInfo(newPath, { followSymlinks: false });
  }
  async remove(path: string): Promise<void> {
    const result = await this.environment.commands.run(['rm', '-rf', '--', this.absolute(path)]);
    if (result.exitCode !== 0) throw codedError(result.stderr, 'EIO');
  }
  async realpath(path: string): Promise<string> {
    if (this.environment.pathClass() === 'win32') return this.environment.normpath(path);
    const result = await this.environment.commands.run(['readlink', '-f', '--', this.absolute(path)], { timeoutMs: 10_000 });
    if (result.timedOut) throw codedError(`realpath timed out: ${path}`, 'ETIMEDOUT');
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : this.environment.normpath(path);
  }
}
/** Compatibility bridge while implementers migrate their primitive methods. */
export interface LegacyEnvironmentPrimitives extends Environment {
  fileInfo(path: string, options?: { followSymlinks?: boolean }): Promise<FileInfo>;
  listDir(path: string): Promise<readonly DirEntry[]>;
  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void>;
  readBytes(path: string, range?: ByteRange): Promise<Buffer>;
  writeBytes(path: string, data: Buffer): Promise<void>;
  realpath(path: string): Promise<string>;
}
export class EnvironmentFilesAdapter extends BaseFiles {
  protected declare environment: LegacyEnvironmentPrimitives;
  constructor(environment: LegacyEnvironmentPrimitives) { super(environment); }
  override async realpath(path: string): Promise<string> { return this.environment.realpath(path); }
  async read(path: string, options?: { range?: ByteRange }): Promise<Buffer> { return this.environment.readBytes(path, options?.range); }
  async write(path: string, data: FileData): Promise<WriteInfo> {
    const target = this.absolute(path);
    const paths = this.environment.pathClass() === 'win32' ? win32 : posix;
    await this.environment.mkdir(paths.dirname(target), { parents: true, existOk: true });
    await this.environment.writeBytes(target, await toBuffer(data));
    return { name: paths.basename(target), path: target };
  }
  async makeDir(path: string): Promise<boolean> {
    if (await this.exists(path)) {
      if ((await this.getInfo(path)).kind === 'dir') return false;
      throw codedError(`Not a directory: ${path}`, 'EEXIST');
    }
    await this.environment.mkdir(path, { parents: true, existOk: true }); return true;
  }
  async getInfo(path: string, options?: { followSymlinks?: boolean }): Promise<EntryInfo> {
    const target = this.absolute(path);
    const paths = this.environment.pathClass() === 'win32' ? win32 : posix;
    return { ...await this.environment.fileInfo(target, options), path: target, name: paths.basename(target) };
  }
  protected async listShallow(path: string): Promise<readonly EntryInfo[]> {
    const paths = this.environment.pathClass() === 'win32' ? win32 : posix;
    return Promise.all((await this.environment.listDir(path)).map(async entry => {
      const target = paths.join(path, entry.name);
      const info = await this.getInfo(target, { followSymlinks: false }).catch(() => ({ size: 0 }));
      return { ...info, ...entry, path: target };
    }));
  }
}
