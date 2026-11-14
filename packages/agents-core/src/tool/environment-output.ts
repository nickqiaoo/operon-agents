import { StringDecoder } from 'node:string_decoder';
import type { CommandHandle, EnvironmentFiles, WatchHandle } from './environment.ts';
import { shellQuote } from './environment-commands.ts';
const outputSubscriptions = new WeakMap<CommandHandle, () => Promise<void>>();
/** Stop a local/SSH file observer without discarding the command's lifecycle subscription. */
export async function stopOutputSubscription(handle: CommandHandle): Promise<void> {
  await outputSubscriptions.get(handle)?.();
}
export function wrapForTaskLog(command: string, output: string, stderr?: string, tee = false): string {
  const trap = shellQuote(`printf '%s' "$?" > ${shellQuote(`${output}.exit`)}`);
  const redirects = stderr ? `2> ${shellQuote(stderr)}` : '2>&1';
  return tee
    ? `set -o pipefail; trap ${trap} EXIT; ( ${command}\n) ${redirects} | tee -a ${shellQuote(output)}`
    : `trap ${trap} EXIT; ( ${command}\n) > ${shellQuote(output)} ${stderr ? `2> ${shellQuote(stderr)}` : '2>&1'}`;
}
/** Local notifications avoid polling; SSH uses the same byte-window reader with a timer. */
export async function followFile(files: EnvironmentFiles, path: string, onChunk: (data: string) => void): Promise<{ stop(): Promise<void>; drain(): Promise<void> }> {
  let offset = 0, stopped = false;
  const decoder = new StringDecoder('utf8');
  let queue = Promise.resolve();
  const drain = () => queue = queue.catch(() => {}).then(async () => {
    if (stopped) return;
    for (;;) {
      const bytes = await files.read(path, { range: { offset, length: 64 * 1024 } });
      offset += bytes.length;
      const text = decoder.write(bytes); if (text) onChunk(text);
      if (bytes.length < 64 * 1024) break;
    }
  });
  const tick = () => { void drain().catch(() => {}); };
  let watcher: WatchHandle | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const native = files as EnvironmentFiles & { watchOutputFile?: (path: string, onChange: () => void) => Promise<WatchHandle> };
  if (native.watchOutputFile) watcher = await native.watchOutputFile(path, tick);
  else if (files.watchDir) {
    const parent = path.replace(/[\\/][^\\/]*$/, '') || '/';
    watcher = await files.watchDir(parent, tick);
  } else { timer = setInterval(tick, 1000); timer.unref(); }
  await drain();
  return {
    drain,
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      await watcher?.stop(); await queue.catch(() => {});
    },
  };
}
export async function attachFileOutput(handle: CommandHandle, files: EnvironmentFiles, path: string, onChunk?: (data: string) => void, retainOutput = true): Promise<CommandHandle> {
  if (!onChunk && !retainOutput) return handle;
  let stdout = '';
  const follow = await followFile(files, path, data => {
    if (retainOutput) stdout += data;
    onChunk?.(data);
  });
  Object.defineProperty(handle, 'stdout', { get: () => stdout });
  outputSubscriptions.set(handle, () => follow.stop());
  const wait = handle.wait.bind(handle), disconnect = handle.disconnect.bind(handle);
  const result = (async () => {
    try { const done = await wait(); await follow.drain(); return { ...done, stdout }; }
    finally { await follow.stop(); }
  })();
  result.catch(() => {});
  handle.wait = () => result;
  handle.disconnect = async () => { await follow.stop(); await disconnect(); };
  return handle;
}
