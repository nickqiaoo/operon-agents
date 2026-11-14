import type { EnvironmentSandbox, SandboxInfo, SandboxMetrics } from './environment.ts';
export class PlainSandbox implements EnvironmentSandbox {
  readonly id: string;
  constructor(id = 'plain') { this.id = id; }
  async getHost(_port: number): Promise<string | undefined> { return undefined; }
  async getUrl(_port: number): Promise<string | undefined> { return undefined; }
  async isRunning(): Promise<boolean> { return true; }
  async getInfo(): Promise<SandboxInfo> { return { id: this.id, state: 'running' }; }
  async getMetrics(): Promise<SandboxMetrics | undefined> { return undefined; }
  async setTimeout(_timeoutMs: number): Promise<boolean> { return false; }
  async uploadUrl(_path?: string): Promise<string | undefined> { return undefined; }
  async downloadUrl(_path: string): Promise<string | undefined> { return undefined; }
}
