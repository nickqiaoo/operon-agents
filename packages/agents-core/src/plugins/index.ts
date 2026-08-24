import type { Capability } from "../index.ts";
import { PluginManager } from "./manager.ts";
import { PluginSessionStartInjector, type SessionStartSkillResolver } from "./injector.ts";

export { PluginManager } from "./manager.ts";
export type { PluginManagerOptions } from "./manager.ts";
export { PluginSessionStartInjector } from "./injector.ts";
export type { SessionStartSkillResolver } from "./injector.ts";
export { resolveInstallSource } from "./source.ts";
export type { ResolvedSource } from "./source.ts";
export { parseManifest } from "./manifest.ts";
export type { ParsedManifestResult } from "./manifest.ts";
export {
  parseHooksDocument,
  loadPluginHooks,
  expandPluginRoot,
  expandPluginRootInHook,
  hookDefsFromConfig,
} from "./hooks.ts";
export type { ParsedPluginHooks } from "./hooks.ts";
export { resolveGithubSource, codeloadZipUrl } from "./github-resolver.ts";
export { downloadZip, extractZip } from "./archive.ts";
export { readInstalled, writeInstalled } from "./store.ts";
export type { InstalledRecord, InstalledFile } from "./store.ts";
export { loadMarketplace, parseMarketplace } from "./marketplace.ts";
export type { Marketplace, MarketplaceEntry, LoadMarketplaceOptions } from "./marketplace.ts";
export {
  PLUGIN_NAME_REGEX,
  normalizePluginId,
} from "./types.ts";
export type {
  PluginManifest,
  PluginRecord,
  PluginSummary,
  PluginInfo,
  PluginSource,
  PluginState,
  PluginDiagnostic,
  PluginDiagnosticSeverity,
  PluginCapabilityState,
  PluginMcpServerInfo,
  PluginMcpServerState,
  PluginGithubRef,
  PluginGithubMetadata,
  PluginSessionStart,
  PluginInterface,
  PluginAuthor,
  EnabledPluginSessionStart,
  ReloadSummary,
} from "./types.ts";

export function pluginsCapability(manager: PluginManager, resolveSkill: SessionStartSkillResolver): Capability {
  return {
    name: "plugins",
    service: manager,
    openSession: async () => {
      await manager.load();
    },
    injectors: [new PluginSessionStartInjector(manager, resolveSkill)],
  };
}
