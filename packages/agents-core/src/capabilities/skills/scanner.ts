import { homedir } from "node:os";
import path from "pathe";
import type { DirEntry, Machine } from "../../tool/machine.ts";
import { SkillParseError, UnsupportedSkillTypeError, parseSkillFromMachine } from "./parser.ts";
import type { SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from "./types.ts";
import { normalizeSkillName } from "./types.ts";

const PROJECT_SKILL_DIR = ".agents/skills";
const USER_SKILL_DIR = ".agents/skills";

const MAX_SKILL_SCAN_DEPTH = 8;

export interface ResolveSkillRootsOptions {
  readonly projectDir?: string;
  readonly userHomeDir?: string;
  readonly builtinDir?: string;
  readonly extraDirs?: readonly string[];
  readonly explicitRoots?: readonly SkillRoot[];
  /**
   * Keep the default project/user `.agents/skills` roots even when `explicitRoots` is given.
   * Off by default: explicit roots REPLACE the defaults, which is what a fully-controlled host
   * (and every test) wants — otherwise a scan would pick up the developer's real `~/.agents/skills`.
   * Callers whose explicit roots only ADD to the defaults (plugin skill dirs, say) pass true; the
   * defaults are pushed first, so a project/user skill still shadows a same-named plugin one.
   */
  readonly includeDefaults?: boolean;
}

export interface DiscoverSkillsOptions {
  readonly roots: readonly SkillRoot[];
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly onSkippedByPolicy?: (skill: SkippedSkill) => void;
  readonly onDiscoveredSkill?: (skill: SkillDefinition) => void;
}

type EntryKind = "file" | "dir" | "none";

async function statKind(machine: Machine, p: string): Promise<EntryKind> {
  try {
    const kind = (await machine.fileInfo(p)).kind;
    if (kind === "dir") return "dir";
    if (kind === "file") return "file";
    return "none";
  } catch {
    return "none";
  }
}

async function listDir(machine: Machine, p: string): Promise<readonly DirEntry[]> {
  // Sorted so first-wins collision resolution across siblings is deterministic.
  return (await machine.listDir(p)).toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * The listing's kind, with symlinks resolved to what they point AT — a skills root full of
 * symlinked bundles is normal, and treating those as neither file nor dir would silently
 * hide them. Only `"symlink"` entries cost a stat; everything else is already decided.
 */
async function resolveEntryKind(machine: Machine, dirPath: string, entry: DirEntry): Promise<EntryKind> {
  if (entry.kind === "dir") return "dir";
  if (entry.kind === "file") return "file";
  if (entry.kind !== "symlink") return "none";
  return statKind(machine, path.join(dirPath, entry.name));
}

export async function resolveSkillRoots(
  machine: Machine,
  options: ResolveSkillRootsOptions,
): Promise<readonly SkillRoot[]> {
  const roots: SkillRoot[] = [];
  const push = async (dir: string, source: SkillSource, plugin?: SkillRoot["plugin"]): Promise<void> => {
    const resolved = path.resolve(dir);
    if ((await statKind(machine, resolved)) !== "dir") return;
    if (roots.some((root) => root.path === resolved)) return;
    roots.push(plugin ? { path: resolved, source, plugin } : { path: resolved, source });
  };

  const explicitRoots = options.explicitRoots ?? [];
  if (explicitRoots.length === 0 || options.includeDefaults === true) {
    if (options.projectDir !== undefined) await push(path.join(options.projectDir, PROJECT_SKILL_DIR), "project");
    // User-level skills default to `~/.agents/skills` (the cross-tool `.agents`
    // convention Codex also uses) when the caller doesn't override the home dir.
    await push(path.join(options.userHomeDir ?? homedir(), USER_SKILL_DIR), "user");
  }
  for (const root of explicitRoots) await push(root.path, root.source, root.plugin);

  for (const dir of options.extraDirs ?? []) await push(dir, "extra");
  if (options.builtinDir !== undefined) await push(options.builtinDir, "builtin");

  return roots;
}

export async function discoverSkills(
  machine: Machine,
  options: DiscoverSkillsOptions,
): Promise<readonly SkillDefinition[]> {
  const warn = options.onWarning ?? (() => {});
  const skip = options.onSkippedByPolicy ?? (() => {});
  const byName = new Map<string, SkillDefinition>();

  /**
   * Parse one skill. Deliberately does NOT register: the walk runs its reads concurrently,
   * so registration is replayed afterwards in listing order — otherwise which of two
   * same-named skills wins would depend on which read finished first.
   */
  const parseSkill = async (skillMdPath: string, skillDirName: string, root: SkillRoot): Promise<SkillDefinition | undefined> => {
    try {
      const parsed = await parseSkillFromMachine(machine, { skillMdPath, skillDirName, source: root.source });
      return root.plugin === undefined ? parsed : { ...parsed, plugin: root.plugin };
    } catch (error) {
      if (error instanceof UnsupportedSkillTypeError) {
        skip({ path: skillMdPath, type: error.skillType, reason: `unsupported skill type "${error.skillType}"` });
      } else if (error instanceof SkillParseError) {
        warn(`Skipping invalid skill at ${skillMdPath}: ${error.message}`, error);
      } else {
        warn(`Skipping skill at ${skillMdPath} due to unexpected error`, error);
      }
      return undefined;
    }
  };

  /**
   * Returns this subtree's skills in deterministic order (bundles, then top-level flat
   * files, then subdirectories — each alphabetical), independent of completion order.
   *
   * Every read at a given level is issued concurrently. The listing already carries each
   * entry's kind, so the only stats left are the ones that carry real information: a
   * symlink's target kind, and whether a directory holds a SKILL.md.
   */
  const walk = async (dirPath: string, root: SkillRoot, isTopLevel: boolean, depth: number): Promise<readonly SkillDefinition[]> => {
    if (depth > MAX_SKILL_SCAN_DEPTH) return [];

    let entries: readonly DirEntry[];
    try {
      entries = await listDir(machine, dirPath);
    } catch (error) {
      warn(`Failed to read skill directory ${dirPath}`, error);
      return [];
    }

    const kinds = await Promise.all(entries.map((entry) => resolveEntryKind(machine, dirPath, entry)));
    const dirNames: string[] = [];
    const fileNames: string[] = [];
    for (const [i, entry] of entries.entries()) {
      if (kinds[i] === "dir") dirNames.push(entry.name);
      else if (kinds[i] === "file") fileNames.push(entry.name);
    }

    // A directory is a bundle iff it holds a SKILL.md. Probed for directories only — the old
    // scan asked this of every entry, including plain files, which can never answer yes.
    const bundleFlags = await Promise.all(
      dirNames.map(async (name) => (await statKind(machine, path.join(dirPath, name, "SKILL.md"))) === "file"),
    );
    const bundles = new Set(dirNames.filter((_, i) => bundleFlags[i]));

    const bundleSkills = await Promise.all(
      [...bundles].map((name) => parseSkill(path.join(dirPath, name, "SKILL.md"), name, root)),
    );

    // Flat `.md` skills count only at a root's top level; deeper `.md` files are payload.
    const flatSkills = isTopLevel
      ? await Promise.all(
          fileNames
            .filter((name) => name.endsWith(".md") && name !== "SKILL.md")
            .map((name) => {
              const skillName = name.slice(0, -".md".length);
              if (bundles.has(skillName)) {
                warn(`Ignoring flat skill ${path.join(dirPath, name)} (a ${skillName}/SKILL.md bundle shadows it)`);
                return undefined;
              }
              return parseSkill(path.join(dirPath, name), skillName, root);
            }),
        )
      : [];

    const descend = dirNames.filter(
      // A bundle dir is a leaf — its contents are payload, not more skills.
      (name) => !bundles.has(name) && name !== "node_modules" && !name.startsWith("."),
    );
    const nested = await Promise.all(descend.map((name) => walk(path.join(dirPath, name), root, false, depth + 1)));

    return [...bundleSkills, ...flatSkills, ...nested.flat()].filter((skill) => skill !== undefined);
  };

  // Roots are walked concurrently, then folded in root order so earlier roots still win.
  const perRoot = await Promise.all(options.roots.map((root) => walk(root.path, root, true, 0)));
  for (const skill of perRoot.flat()) {
    options.onDiscoveredSkill?.(skill);
    const key = normalizeSkillName(skill.name);
    if (!byName.has(key)) byName.set(key, skill);
  }

  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}
