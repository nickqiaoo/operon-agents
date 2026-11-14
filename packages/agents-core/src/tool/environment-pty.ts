import type { EnvironmentPty, PtyCreateOptions, PtyHandle, PtySize } from './environment.ts';
import { codedError } from './environment-commands.ts';
/** Injected by the host; the core package has no native dependency. */
export interface NodePtyModule {
  spawn(file: string, args: string[], options: { cols: number; rows: number; cwd: string; env: Record<string, string> }): {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(callback: (data: string) => void): { dispose(): void };
    onExit(callback: (event: { exitCode: number }) => void): { dispose(): void };
  };
}
export class LocalPty implements EnvironmentPty {
  private module: NodePtyModule;
  private shell: string;
  private cwd: () => string;
  private records = new Map<number, { process: ReturnType<NodePtyModule['spawn']>; listeners: Set<(data: Uint8Array) => void>; done: Promise<{ exitCode: number }> }>();
  constructor(module: NodePtyModule, shell: string, cwd: () => string) { this.module = module; this.shell = shell; this.cwd = cwd; }
  async create(options: PtyCreateOptions): Promise<PtyHandle> {
    const process_ = this.module.spawn(this.shell, [], { cols: options.cols, rows: options.rows, cwd: options.cwd ?? this.cwd(), env: { ...process.env as Record<string, string>, ...options.env } });
    const listeners = new Set<(data: Uint8Array) => void>();
    const dataSub = process_.onData(data => { for (const cb of listeners) cb(Buffer.from(data)); });
    const done = new Promise<{ exitCode: number }>(resolve => {
      process_.onExit(event => { dataSub.dispose(); this.records.delete(process_.pid); resolve(event); });
    });
    this.records.set(process_.pid, { process: process_, listeners, done });
    return this.connect(process_.pid, options);
  }
  async connect(pid: number, options: Pick<PtyCreateOptions, 'onData'>): Promise<PtyHandle> {
    const record = this.records.get(pid);
    if (!record) throw codedError(`No such PTY: ${pid}`, 'ESRCH');
    record.listeners.add(options.onData);
    return {
      pid, wait: () => record.done,
      sendInput: async data => { record.process.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); },
      resize: async size => { record.process.resize(size.cols, size.rows); },
      kill: async () => { record.process.kill('SIGKILL'); await record.done; return true; },
      disconnect: async () => { record.listeners.delete(options.onData); },
    };
  }
  async sendInput(pid: number, data: string | Uint8Array): Promise<void> {
    const record = this.records.get(pid); if (!record) throw codedError(`No such PTY: ${pid}`, 'ESRCH');
    record.process.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  }
  async resize(pid: number, size: PtySize): Promise<void> { const record = this.records.get(pid); if (!record) throw codedError(`No such PTY: ${pid}`, 'ESRCH'); record.process.resize(size.cols, size.rows); }
  async kill(pid: number): Promise<boolean> { const record = this.records.get(pid); if (!record) return false; record.process.kill('SIGKILL'); await record.done; return true; }
}
