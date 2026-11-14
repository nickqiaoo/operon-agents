import type { Command, CommandHandle, CommandStartOptions, CommandResult, RunCommandOptions, RunCommandResult, OsInfo, ProcessInfo, CommandConnectOptions } from './environment.ts';
import type { SpawnedProcess } from './environment-base.ts';
import { StringDecoder } from 'node:string_decoder';

export function codedError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/@%+=:,.-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
export function shellJoin(argv: readonly string[]): string { return argv.map(shellQuote).join(' '); }
export function commandLine(command: Command): string { return typeof command === 'string' ? command : shellJoin(command); }
export function commandArgv(command: Command, os: OsInfo): string[] {
  return typeof command !== 'string' ? [...command] : [os.shellPath, ...(os.shellName === 'cmd' ? ['/d', '/s', '/c'] : ['-c']), command];
}
class CappedText {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  private cap: number;
  constructor(cap: number) { this.cap = Math.max(0, cap); }
  push(data: string): void {
    const bytes = Buffer.from(data);
    const room = Math.max(0, this.cap - this.size);
    this.chunks.push(bytes.subarray(0, room));
    this.size += Math.min(room, bytes.length);
    if (bytes.length > room) this.truncated = true;
  }
  get text(): string { return Buffer.concat(this.chunks).toString('utf8'); }
}
export async function runViaHandle(start: (command: Command, options: CommandStartOptions) => Promise<CommandHandle>, command: Command, options: RunCommandOptions = {}): Promise<RunCommandResult> {
  const { timeoutMs, maxOutputBytes = Infinity, signal, onOutput } = options;
  if (signal?.aborted) return { stdout: '', stderr: '', exitCode: undefined, timedOut: false, truncated: false, terminated: true };
  const out = new CappedText(maxOutputBytes), err = new CappedText(maxOutputBytes);
  const collect = (stream: 'stdout' | 'stderr', sink: CappedText) => (data: string) => {
    if (sink.truncated) return;
    onOutput?.({ stream, data }); sink.push(data);
  };
  const handle = await start(command, { cwd: options.cwd, env: options.env, stdin: options.stdin !== undefined, retainOutput: false, onStdout: collect('stdout', out), onStderr: collect('stderr', err) });
  let timedOut = false, terminated = false;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= handle.kill().then(ok => { terminated = ok; }, () => { terminated = false; });
  const onAbort = () => { void stop(); };
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) onAbort();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; void stop(); }, timeoutMs);
  try {
    if (options.stdin !== undefined) {
      try { await handle.sendStdin(options.stdin); await handle.closeStdin(); }
      catch (error) { await stop(); throw error; }
    }
    let finished: CommandResult;
    try { finished = await handle.wait(); }
    catch (error) { if (!stopping) throw error; finished = { exitCode: undefined, stdout: '', stderr: '' }; }
    await stopping;
    return { stdout: out.text, stderr: err.text, exitCode: timedOut ? undefined : finished.exitCode, timedOut, truncated: out.truncated || err.truncated, terminated };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
interface RecordEntry {
  proc: SpawnedProcess;
  info: ProcessInfo;
  subscribers: Set<(stream: 'stdout' | 'stderr', data: string) => void>;
  done: Promise<CommandResult>;
  stdin: boolean;
  kill(): Promise<boolean>;
}
/** Process-local pipes only: reconnecting across host restarts requires a backend with durable commands. */
export class ProcessTable {
  private records = new Map<number, RecordEntry>();
  private nextPid = -1;
  async start(proc: SpawnedProcess, command: Command, options: CommandStartOptions, kill: () => Promise<boolean>): Promise<CommandHandle> {
    const pid = proc.pid ?? this.nextPid--;
    let abandon!: () => void;
    const abandoned = new Promise<void>(resolve => { abandon = resolve; });
    const record: RecordEntry = {
      proc, info: { pid, cmd: commandLine(command), args: typeof command === 'string' ? [] : command.slice(1), envs: options.env ?? {}, cwd: options.cwd },
      subscribers: new Set(), done: Promise.resolve({ stdout: '', stderr: '', exitCode: undefined }), stdin: options.stdin === true,
      kill: async () => {
        const ok = await kill();
        if (!ok) { proc.stdout.destroy(); proc.stderr.destroy(); abandon(); }
        return ok;
      },
    };
    proc.stdin.on('error', () => {});
    if (!options.stdin) proc.stdin.end();
    this.records.set(pid, record);
    const handle = this.subscribe(record, options);
    const read = async (stream: 'stdout' | 'stderr') => {
      const decoder = new StringDecoder('utf8');
      const emit = (data: string) => { if (data) for (const cb of record.subscribers) cb(stream, data); };
      try { for await (const chunk of proc[stream]) emit(decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)); }
      catch { /* killed pipes may close before EOF */ }
      emit(decoder.end());
    };
    record.done = Promise.all([read('stdout'), read('stderr'), Promise.race([proc.wait(), abandoned.then(() => undefined)])])
      .then(([, , exitCode]) => ({ stdout: '', stderr: '', exitCode }))
      .finally(() => { this.records.delete(pid); });
    record.done.catch(() => {});
    return handle;
  }
  private subscribe(record: RecordEntry, options: CommandConnectOptions): CommandHandle {
    let stdout = '', stderr = '';
    const receive = (stream: 'stdout' | 'stderr', data: string) => {
      if (options.retainOutput !== false) { if (stream === 'stdout') stdout += data; else stderr += data; }
      if (stream === 'stdout') options.onStdout?.(data); else options.onStderr?.(data);
    };
    record.subscribers.add(receive);
    return {
      pid: record.info.pid,
      get stdout() { return stdout; }, get stderr() { return stderr; },
      get exitCode() { return record.proc.exitCode ?? undefined; },
      wait: async () => ({ ...await record.done, stdout, stderr }),
      kill: () => record.kill(),
      disconnect: async () => { record.subscribers.delete(receive); },
      sendStdin: async data => {
        if (!record.stdin) throw codedError('stdin is not open', 'EPIPE');
        record.proc.stdin.write(data);
      },
      closeStdin: async () => { record.stdin = false; record.proc.stdin.end(); },
    };
  }
  async list(): Promise<readonly ProcessInfo[]> { return [...this.records.values()].map(record => record.info); }
  async connect(pid: number, options: CommandConnectOptions = {}): Promise<CommandHandle> {
    const record = this.records.get(pid);
    if (!record) throw codedError(`No such process: ${pid}`, 'ESRCH');
    return this.subscribe(record, options);
  }
  async kill(pid: number): Promise<boolean> { return this.records.get(pid)?.kill() ?? false; }
  async sendStdin(pid: number, data: string | Uint8Array): Promise<void> { const h = await this.connect(pid, { retainOutput: false }); try { await h.sendStdin(data); } finally { await h.disconnect(); } }
  async closeStdin(pid: number): Promise<void> { const h = await this.connect(pid, { retainOutput: false }); try { await h.closeStdin(); } finally { await h.disconnect(); } }
}
