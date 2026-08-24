import path from "node:path";
import type { HookDef } from "../capabilities/user-hooks/types.ts";
import type { McpServerConfig, SkillRoot, Machine } from "../index.ts";
import { downloadZip, extractZip } from "./archive.ts";
import { resolveGithubSource } from "./github-resolver.ts";
import { parseManifest, type ParsedManifestResult } from "./manifest.ts";
import { readInstalled, writeInstalled, type InstalledRecord } from "./store.ts";
import { resolveInstallSource } from "./source.ts";
import {
  normalizePluginId,
  type EnabledPluginSessionStart,
  type PluginCapabilityState,
  type PluginGithubMetadata,
  type PluginInfo,
  type PluginMcpServerInfo,
  type PluginRecord,
  type PluginSource,
  type PluginSummary,
  type ReloadSummary,
} from "./types.ts";

export interface PluginManagerOptions {
  readonly machine: Machine;
  readonly homeDir: string;
  readonly now?: () => number;
}

export class PluginManager {
  private readonly machine: Machine;
  private readonly homeDir: string;
  private readonly now: () => number;
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.machine = options.machine;
    this.homeDir = options.homeDir;
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.machine, this.homeDir);
    const next = new Map<string, PluginRecord>();
    for (const entry of file.plugins) {
      try {
        next.set(entry.id, await this.materialize(entry));
      } catch {
        // A vanished/broken root surfaces as an error record below; never abort the load.
        next.set(entry.id, errorRecord(entry));
      }
    }
    this.records = next;
  }

  list(): readonly PluginRecord[] {
    return [...this.records.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(normalizePluginId(id));
  }

  async install(source: string): Promise<PluginRecord> {
    const resolved = resolveInstallSource(source);
    let root: string;
    let sourceType: PluginSource;
    let originalSource: string;
    let github: PluginGithubMetadata | undefined;

    if (resolved.kind === "local-path") {
      root = resolved.path;
      sourceType = "local-path";
      originalSource = resolved.path;
    } else {
      let zipUrl: string;
      if (resolved.kind === "github") {
        const res = await resolveGithubSource(resolved);
        zipUrl = res.zipUrl;
        sourceType = "github";
        originalSource = source.trim();
        github = { owner: resolved.owner, repo: resolved.repo, ref: res.ref };
      } else {
        zipUrl = resolved.path;
        sourceType = "zip-url";
        originalSource = resolved.path;
      }
      const buffer = await downloadZip(zipUrl);
      const staging = path.join(this.homeDir, "plugins", "managed", `_staging-${this.now()}`);
      root = await extractZip(buffer, staging);
      // Monorepo plugin (e.g. openai/plugins → plugins/<name>): descend into the subdirectory.
      if (resolved.kind === "github" && resolved.subdir !== undefined) {
        root = path.join(root, resolved.subdir);
      }
    }

    const parsed = await parseManifest(this.machine, root);
    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === "error")?.message ?? "no manifest";
      throw new Error(`Cannot install plugin from ${originalSource}: ${msg}`);
    }
    const id = normalizePluginId(parsed.manifest.name);
    const existing = this.records.get(id);
    const stamp = new Date(this.now()).toISOString();
    const record = recordFrom({
      id,
      root,
      source: sourceType,
      enabled: existing?.enabled ?? true,
      installedAt: existing?.installedAt ?? stamp,
      updatedAt: stamp,
      originalSource,
      capabilities: existing?.capabilities,
      github,
      parsed,
    });
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.enabled === enabled) return;
    this.records.set(key, { ...current, enabled, updatedAt: new Date(this.now()).toISOString() });
    await this.persist();
  }

  async setMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.manifest?.mcpServers?.[server] === undefined) {
      throw new Error(`Plugin "${id}" does not declare MCP server "${server}"`);
    }
    const currentMcpServers = current.capabilities?.mcpServers ?? {};
    const nextCapabilities: PluginCapabilityState = {
      ...current.capabilities,
      mcpServers: {
        ...currentMcpServers,
        [server]: { enabled },
      },
    };
    this.records.set(key, {
      ...current,
      capabilities: nextCapabilities,
      updatedAt: new Date(this.now()).toISOString(),
    });
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    if (!this.records.delete(normalizePluginId(id))) throw new Error(`Plugin "${id}" is not installed`);
    await this.persist();
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.machine, this.homeDir);
    const next = new Map<string, PluginRecord>();
    const errors: Array<{ id: string; message: string }> = [];
    for (const entry of file.plugins) {
      try {
        next.set(entry.id, await this.materialize(entry));
      } catch (error) {
        errors.push({ id: entry.id, message: (error as Error).message });
        next.set(entry.id, errorRecord(entry));
      }
    }
    const added = [...next.keys()].filter((id) => !prevIds.has(id));
    const removed = [...prevIds].filter((id) => !next.has(id));
    this.records = next;
    return { added, removed, errors };
  }

  skillRoots(): readonly SkillRoot[] {
    const roots: SkillRoot[] = [];
    for (const record of this.enabledOk()) {
      for (const dir of record.manifest!.skills ?? []) {
        roots.push({ path: dir, source: "extra", plugin: { id: record.id, instructions: record.skillInstructions } });
      }
    }
    return roots;
  }

  mcpServerConfigs(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const record of this.enabledOk()) {
      for (const [name, config] of Object.entries(record.manifest!.mcpServers ?? {})) {
        if (!isMcpServerEnabled(record, name, config)) continue;
        out[pluginMcpRuntimeName(record.id, name)] = { ...config, enabled: true };
      }
    }
    return out;
  }

  sessionStarts(): readonly EnabledPluginSessionStart[] {
    const out: EnabledPluginSessionStart[] = [];
    for (const record of this.enabledOk()) {
      const skill = record.manifest!.sessionStart?.skill;
      if (skill !== undefined) out.push({ pluginId: record.id, skillName: skill });
    }
    return out;
  }

  /**
   * Shell hooks contributed by enabled plugins (PLUGIN_ROOT already expanded at parse time).
   * Order is stable: plugins sorted by id, then hook declaration order within each plugin.
   */
  hookDefs(): readonly HookDef[] {
    const out: HookDef[] = [];
    const records = this.enabledOk().toSorted((a, b) => a.id.localeCompare(b.id));
    for (const record of records) {
      for (const hook of record.manifest!.hooks ?? []) out.push(hook);
    }
    return out;
  }

  summaries(): readonly PluginSummary[] {
    return this.list().map(recordToSummary);
  }

  info(id: string): PluginInfo | undefined {
    const record = this.get(id);
    return record === undefined ? undefined : recordToInfo(record);
  }

  private enabledOk(): PluginRecord[] {
    return [...this.records.values()].filter((r) => r.enabled && r.state === "ok" && r.manifest !== undefined);
  }

  private async persist(): Promise<void> {
    const installed: InstalledRecord[] = [...this.records.values()].map((r) => ({
      id: r.id,
      root: r.root,
      source: r.source,
      enabled: r.enabled,
      installedAt: r.installedAt,
      updatedAt: r.updatedAt,
      originalSource: r.originalSource,
      capabilities: r.capabilities,
      github: r.github,
    }));
    await writeInstalled(this.machine, this.homeDir, { version: 1, plugins: installed });
  }

  private async materialize(entry: InstalledRecord): Promise<PluginRecord> {
    const parsed = await parseManifest(this.machine, entry.root);
    return recordFrom({
      id: entry.id,
      root: entry.root,
      source: entry.source,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      originalSource: entry.originalSource,
      capabilities: entry.capabilities,
      github: entry.github,
      parsed,
    });
  }
}

function recordFrom(input: {
  id: string;
  root: string;
  source: PluginSource;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  capabilities?: PluginCapabilityState;
  github?: PluginGithubMetadata;
  parsed: ParsedManifestResult;
}): PluginRecord {
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === "error") || parsed.manifest === undefined;
  return {
    id: input.id,
    root: input.root,
    source: input.source,
    enabled: input.enabled,
    state: hasError ? "error" : "ok",
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    originalSource: input.originalSource,
    capabilities: input.capabilities,
    github: input.github,
    manifest: parsed.manifest,
    manifestPath: parsed.manifestPath,
    diagnostics: parsed.diagnostics,
    skillInstructions: parsed.manifest?.skillInstructions,
  };
}

function errorRecord(entry: InstalledRecord): PluginRecord {
  return {
    id: entry.id,
    root: entry.root,
    source: entry.source,
    enabled: entry.enabled,
    state: "error",
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
    originalSource: entry.originalSource,
    capabilities: entry.capabilities,
    github: entry.github,
    diagnostics: [{ severity: "error", message: `Plugin root unreadable: ${entry.root}` }],
  };
}

function recordToSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    enabled: record.enabled,
    state: record.state,
    skillCount: (record.manifest?.skills ?? []).length,
    mcpServerCount: Object.keys(record.manifest?.mcpServers ?? {}).length,
    enabledMcpServerCount: pluginMcpServersInfo(record).filter((server) => server.enabled).length,
    hasErrors: record.diagnostics.some((d) => d.severity === "error"),
    source: record.source,
    originalSource: record.originalSource,
    github: record.github,
  };
}

function recordToInfo(record: PluginRecord): PluginInfo {
  return {
    ...recordToSummary(record),
    root: record.root,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    manifestPath: record.manifestPath,
    manifest: record.manifest,
    mcpServers: pluginMcpServersInfo(record),
    diagnostics: record.diagnostics,
  };
}

function isMcpServerEnabled(record: PluginRecord, name: string, config: McpServerConfig): boolean {
  return record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false;
}

function pluginMcpServersInfo(record: PluginRecord): readonly PluginMcpServerInfo[] {
  return Object.entries(record.manifest?.mcpServers ?? {})
    .map(([name, config]) => pluginMcpServerInfo(record, name, config))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function pluginMcpServerInfo(record: PluginRecord, name: string, config: McpServerConfig): PluginMcpServerInfo {
  if (config.transport === "http") {
    return {
      name,
      runtimeName: pluginMcpRuntimeName(record.id, name),
      enabled: isMcpServerEnabled(record, name, config),
      transport: "http",
      ...(config.url !== undefined ? { url: config.url } : {}),
      ...(config.headers !== undefined ? { headerKeys: Object.keys(config.headers).toSorted() } : {}),
    };
  }
  return {
    name,
    runtimeName: pluginMcpRuntimeName(record.id, name),
    enabled: isMcpServerEnabled(record, name, config),
    transport: "stdio",
    ...(config.command !== undefined ? { command: config.command } : {}),
    ...(config.args !== undefined ? { args: config.args } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.env !== undefined ? { envKeys: Object.keys(config.env).toSorted() } : {}),
  };
}

function pluginMcpRuntimeName(pluginId: string, serverName: string): string {
  return `plugin-${pluginId}:${serverName}`;
}
