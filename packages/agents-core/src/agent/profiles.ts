import { load as loadYaml } from "js-yaml";
import nunjucks from "nunjucks";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "pathe";
import { z } from "zod";
import type { ChatModel } from "../llm/define-model.ts";
import type { Tool } from "../tool/types.ts";
import { Agent, defineAgent } from "./agent.ts";
import { formatSystemPromptDate } from "./instruction-context.ts";
import type { SystemPromptContext } from "./instruction-context.ts";
export { prepareSystemPromptContext } from "./instruction-context.ts";
export type { SystemPromptContext } from "./instruction-context.ts";

// Prompts aren't HTML, so don't escape; a missing template var is a loud error, never a silent
// `{{ placeholder }}` leaked to the model.
const njk = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });

// ── profile schema (YAML on disk; `extends` inheritance) ─────────────────────────────────────

const SubagentRefSchema = z.object({ description: z.string().optional() });

/** A raw agent profile as authored in YAML (before `extends` is merged). */
export const RawAgentProfileSchema = z.object({
  extends: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  /** Path to a system-prompt template file, relative to the profile (resolved by the loader). */
  systemPromptPath: z.string().optional(),
  /** The system-prompt template inline (set by the loader from `systemPromptPath`, or directly). */
  systemPromptTemplate: z.string().optional(),
  promptVars: z.record(z.string(), z.string()).optional(),
  /** Exact tool names; entries containing `*` are MCP access globs (informational here — AF adds
   *  MCP tools via the MCP capability, and does not gate the active set). */
  tools: z.array(z.string()).optional(),
  /** Optional model ref the host resolves; absent → inherit the session model. */
  model: z.string().optional(),
  whenToUse: z.string().optional(),
  subagents: z.record(z.string(), SubagentRefSchema).optional(),
});
export type RawAgentProfile = z.infer<typeof RawAgentProfileSchema>;
export type RawSubagentProfile = z.infer<typeof SubagentRefSchema>;

// ── system-prompt rendering ──────────────────────────────────────────────────────────────────

export type SystemPromptRenderer = (context: SystemPromptContext) => string;

/** A profile with `extends` merged and its system prompt exposed as a context-driven renderer. */
export interface ResolvedAgentProfile {
  name: string;
  description?: string;
  model?: string;
  systemPrompt: SystemPromptRenderer;
  tools: string[];
  whenToUse?: string;
  subagents?: Record<string, ResolvedAgentProfile>;
}

function buildTemplateVars(context: SystemPromptContext, promptVars: Record<string, string>): Record<string, unknown> {
  const now = context.now instanceof Date ? formatSystemPromptDate(context.now) : (context.now ?? "");
  return {
    ...promptVars,
    os: context.osKind,
    osArch: context.osArch ?? "",
    osVersion: context.osVersion ?? "",
    shell: context.shell,
    now,
    workDir: context.cwd,
    agentsMd: context.agentsMd ?? "",
    roleAdditional: context.roleAdditional ?? promptVars["roleAdditional"] ?? "",
  };
}

// ── extends resolution (merge parent → child, cycle-checked, subagents linked) ──────────────────

interface MergedProfile {
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly systemPromptTemplate: string;
  readonly promptVars: Record<string, string>;
  readonly tools: string[];
  readonly whenToUse?: string;
  readonly subagents?: Record<string, RawSubagentProfile>;
}

/** Resolve raw profiles with `extends` inheritance into renderers + a linked subagent graph. */
export function resolveAgentProfiles(raw: readonly RawAgentProfile[]): Record<string, ResolvedAgentProfile> {
  const byName = new Map<string, RawAgentProfile>();
  for (const profile of raw) {
    if (byName.has(profile.name)) throw new Error(`duplicate agent profile name: "${profile.name}"`);
    byName.set(profile.name, profile);
  }

  const mergedCache = new Map<string, MergedProfile>();
  const resolved = new Map<string, ResolvedAgentProfile>();
  for (const profile of raw) {
    const merged = mergeProfile(profile.name, byName, mergedCache, []);
    resolved.set(profile.name, {
      name: merged.name,
      description: merged.description,
      model: merged.model,
      systemPrompt: (context) => {
        try {
          return njk.renderString(merged.systemPromptTemplate, buildTemplateVars(context, merged.promptVars));
        } catch (error) {
          throw new Error(`render system prompt for profile "${merged.name}" failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      },
      tools: [...merged.tools],
      whenToUse: merged.whenToUse,
    });
  }

  // Link declared subagents after all profiles exist. Pass 1 links every graph to the
  // SHARED resolved targets, so each target's own `subagents` is fully linked before pass 2
  // snapshots any per-edge view of it.
  for (const profile of raw) {
    const merged = mergedCache.get(profile.name)!;
    if (merged.subagents === undefined) continue;
    const graph: Record<string, ResolvedAgentProfile> = {};
    for (const subName of Object.keys(merged.subagents)) {
      const target = resolved.get(subName);
      if (target === undefined) throw new Error(`profile "${profile.name}" declares subagent "${subName}" but it was not found`);
      graph[subName] = target;
    }
    resolved.get(profile.name)!.subagents = graph;
  }
  // Pass 2: a ref's description belongs to THIS parent's edge, not to the shared target —
  // two parents may describe the same subagent differently. Materialize it as a per-edge
  // copy (winning over the target's own description on that edge) instead of mutating the
  // shared profile, which made the outcome depend on profile processing order.
  for (const profile of raw) {
    const merged = mergedCache.get(profile.name)!;
    if (merged.subagents === undefined) continue;
    const graph = resolved.get(profile.name)!.subagents!;
    for (const [subName, ref] of Object.entries(merged.subagents)) {
      const target = graph[subName]!;
      if (ref.description === undefined || ref.description === target.description) continue;
      graph[subName] = { ...target, description: ref.description };
    }
  }

  return Object.fromEntries(resolved);
}

function mergeProfile(name: string, byName: Map<string, RawAgentProfile>, cache: Map<string, MergedProfile>, stack: string[]): MergedProfile {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  if (stack.includes(name)) throw new Error(`agent profile extends cycle: ${[...stack.slice(stack.indexOf(name)), name].join(" -> ")}`);

  const profile = byName.get(name);
  if (profile === undefined) throw new Error(`agent profile "${name}" not found`);

  let parent: MergedProfile | undefined;
  if (profile.extends !== undefined) {
    if (!byName.has(profile.extends)) throw new Error(`profile "${profile.name}" extends "${profile.extends}" but the parent was not found`);
    parent = mergeProfile(profile.extends, byName, cache, [...stack, name]);
  }

  const merged: MergedProfile = {
    name: profile.name,
    description: profile.description ?? parent?.description,
    model: profile.model ?? parent?.model,
    systemPromptTemplate: profile.systemPromptTemplate ?? parent?.systemPromptTemplate ?? "",
    promptVars: { ...parent?.promptVars, ...profile.promptVars },
    tools: profile.tools !== undefined ? [...profile.tools] : [...(parent?.tools ?? [])],
    whenToUse: profile.whenToUse ?? parent?.whenToUse,
    subagents: profile.subagents !== undefined ? { ...profile.subagents } : undefined,
  };
  cache.set(profile.name, merged);
  return merged;
}

// ── building runnable Agents from profiles ─────────────────────────────────────────────────────

export interface BuildAgentOptions {
  /** Resolve a profile's `model` ref to a `ChatModel`. Omit to inherit the session model. */
  readonly resolveModel?: (modelRef: string) => ChatModel | Promise<ChatModel>;
  /** Tool registry the profile's `tools` names resolve against. Glob (`mcp__*`) + unknown names are skipped. */
  readonly tools?: Readonly<Record<string, Tool>>;
  /**
   * Called for each non-glob tool name that did not resolve against `tools`. Unknown names
   * CANNOT be errors — capability tools (goal/plan/todo/…) join at runtime and are invisible
   * here — but a typo lands in the same bucket, so hosts should log these for diagnosis.
   * Only invoked when a `tools` registry was provided. Default: silent (unchanged behavior).
   */
  readonly onUnknownTool?: (toolName: string) => void;
  /** Force the built agent's model, overriding the profile's `model`. Omit to keep the profile's ref
   *  (or inherit the session model when the profile declares none). */
  readonly model?: string | ChatModel;
  /** Fill the template's `roleAdditional` slot (rendered after the profile's own prompt), overriding
   *  the profile's `promptVars.roleAdditional`. The builtin default profile leaves this empty, so
   *  it reads as an append; on a profile that already sets it (e.g. a subagent role) this replaces it. */
  readonly roleAdditional?: string;
  /** Cap on steps within one turn for this agent. Overrides the Runner's own default — see
   *  `Agent.maxStepsPerTurn`. Lets a host vary the cap per agent (and so per session) without
   *  standing up a second Runner. */
  readonly maxStepsPerTurn?: number;
}

/** Turn a resolved profile into a runnable Agent whose system prompt renders from live context. */
export async function buildAgentFromProfile<TContext = unknown>(
  profile: ResolvedAgentProfile,
  options: BuildAgentOptions = {},
): Promise<Agent<TContext>> {
  const toolset: Tool[] = [];
  for (const name of profile.tools) {
    if (name.includes("*")) continue; // MCP access glob — added by the MCP capability, not here
    const tool = options.tools?.[name];
    if (tool !== undefined) toolset.push(tool);
    // Unresolved names are capability tools joining at runtime — or typos. Not distinguishable
    // here, so never throw; surface them through the optional diagnostic callback instead.
    else if (options.tools !== undefined) options.onUnknownTool?.(name);
  }
  const model =
    options.model ??
    (profile.model !== undefined && options.resolveModel !== undefined ? await options.resolveModel(profile.model) : undefined);
  const roleAdditional = options.roleAdditional;

  return defineAgent<TContext>({
    name: profile.name,
    instructions: async (runContext) => {
      if (runContext.resolveSystemPromptContext === undefined) {
        throw new Error(`profile agent "${profile.name}" requires a runtime Session to render its system prompt`);
      }
      const context = await runContext.resolveSystemPromptContext();
      return profile.systemPrompt({
        ...context,
        ...(roleAdditional !== undefined ? { roleAdditional } : {}),
      });
    },
    model,
    tools: toolset,
    ...(options.maxStepsPerTurn !== undefined ? { maxStepsPerTurn: options.maxStepsPerTurn } : {}),
    handoffDescription: profile.whenToUse ?? profile.description,
  });
}

// ── loading profiles (YAML files on disk, + inlined builtin sources) ────────────────────────────

export interface ProfileLoadOptions {
  readonly appName?: string;
  readonly homeDir?: string;
  readonly cwd?: string;
}

/** Profile dirs, low → high precedence: user (`~/.<app>/agents`) < project (`<cwd>/.<app>/agents`). */
export function resolveProfileDirs(options: ProfileLoadOptions = {}): string[] {
  const appName = options.appName ?? "agents";
  const home = options.homeDir ?? join(homedir(), `.${appName}`);
  const cwd = options.cwd ?? process.cwd();
  return [join(home, "agents"), join(cwd, `.${appName}`, "agents")];
}

function parseProfile(content: string, path: string): RawAgentProfile {
  let raw: unknown;
  try {
    raw = loadYaml(content);
  } catch (error) {
    throw new Error(`agent profile YAML parse failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = RawAgentProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid agent profile ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Discover + parse `*.yaml`/`*.yml` profiles across tiers (project name overrides user), resolving
 *  each `systemPromptPath` relative to its file. Returns resolved profiles (extends merged). */
export async function loadAgentProfiles(options: ProfileLoadOptions = {}): Promise<Record<string, ResolvedAgentProfile>> {
  const byName = new Map<string, RawAgentProfile>();
  for (const dir of resolveProfileDirs(options)) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const path = join(dir, file);
      const profile = parseProfile(await readFile(path, "utf-8"), path);
      const withTemplate = await inlineSystemPromptFromDisk(profile, path);
      byName.set(withTemplate.name, withTemplate);
    }
  }
  return resolveAgentProfiles([...byName.values()]);
}

async function inlineSystemPromptFromDisk(profile: RawAgentProfile, profilePath: string): Promise<RawAgentProfile> {
  if (profile.systemPromptPath === undefined) return profile;
  const templatePath = join(dirname(profilePath), profile.systemPromptPath);
  return { ...profile, systemPromptTemplate: await readFile(templatePath, "utf-8") };
}

/** Build profiles from in-memory sources (YAML strings keyed by path); `systemPromptPath` resolves
 *  against the same map. Used for builtin profiles, which ship inline (no bundler/fs needed). */
export function loadAgentProfilesFromSources(profilePaths: readonly string[], sources: Readonly<Record<string, string>>): Record<string, ResolvedAgentProfile> {
  const raw: RawAgentProfile[] = [];
  for (const path of profilePaths) {
    const content = sources[path];
    if (content === undefined) throw new Error(`builtin profile source missing: ${path}`);
    const profile = parseProfile(content, path);
    if (profile.systemPromptPath !== undefined) {
      const templateKey = join(dirname(path), profile.systemPromptPath);
      const template = sources[templateKey];
      if (template === undefined) throw new Error(`builtin profile "${profile.name}" references missing template: ${templateKey}`);
      raw.push({ ...profile, systemPromptTemplate: template });
    } else {
      raw.push(profile);
    }
  }
  return resolveAgentProfiles(raw);
}

// ── subagent provider backed by profiles ───────────────────────────────────────────────────────

export interface SubagentInfo {
  readonly name: string;
  readonly description?: string;
}

/** A runtime source of subagents the `Agent` tool can spawn/resume by type. */
export interface SubagentProvider<TContext = unknown> {
  list(): Promise<readonly SubagentInfo[]> | readonly SubagentInfo[];
  get(type: string): Promise<Agent<TContext> | undefined> | Agent<TContext> | undefined;
}

/** A `SubagentProvider` over resolved profiles (built lazily + cached per type). Pass `only` to
 *  expose a subset (e.g. a main profile's declared subagents); omit to expose all. */
export function profileSubagentProvider<TContext = unknown>(
  profiles: Record<string, ResolvedAgentProfile>,
  options: BuildAgentOptions & { readonly only?: readonly string[] } = {},
): SubagentProvider<TContext> {
  const names = options.only ?? Object.keys(profiles);
  const built = new Map<string, Agent<TContext>>();
  return {
    list: () => names.filter((n) => profiles[n] !== undefined).map((n) => ({ name: n, description: profiles[n]!.whenToUse ?? profiles[n]!.description })),
    get: async (type) => {
      if (!names.includes(type)) return undefined;
      const cached = built.get(type);
      if (cached !== undefined) return cached;
      const profile = profiles[type];
      if (profile === undefined) return undefined;
      const agent = await buildAgentFromProfile<TContext>(profile, options);
      built.set(type, agent);
      return agent;
    },
  };
}
