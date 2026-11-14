import type { EnvironmentSandbox } from '../tool/environment.ts';
/** Renew only while a turn or a process task is active. No environment lifecycle ownership. */
export class SandboxKeepalive {
  private sandbox: EnvironmentSandbox;
  private ttlMs: number;
  private active: () => boolean;
  private onError: (error: unknown) => void;
  private unsupported = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  constructor(sandbox: EnvironmentSandbox, ttlMs: number, active: () => boolean, onError: (error: unknown) => void) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('sandboxTtlMs must be positive');
    this.sandbox = sandbox; this.ttlMs = ttlMs; this.active = active; this.onError = onError;
  }
  async renew(): Promise<void> {
    if (this.closed || this.unsupported) return;
    if (this.timer) clearTimeout(this.timer);
    await (this.pending ??= this.sandbox.setTimeout(this.ttlMs).then(supported => { this.unsupported = !supported; }).catch(this.onError).finally(() => { this.pending = undefined; }));
    if (this.closed || this.unsupported) return;
    this.timer = setTimeout(() => {
      if (this.active()) void this.renew();
    }, this.ttlMs / 3);
    this.timer.unref();
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); }
}
