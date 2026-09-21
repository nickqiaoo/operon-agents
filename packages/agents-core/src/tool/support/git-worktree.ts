import * as pathe from "pathe";
import type { Environment } from "../environment.ts";
import { isWithinDirectory, type PathClass } from "../policies/path-access.ts";
import { readTextFile } from "./environment-ops.ts";

const MAX_WALK_DEPTH = 256;

export type GitWorkTreeEnvironment = Pick<Environment, "fileInfo" | "readBytes">;

export interface GitWorkTreeMarker {
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

export async function findGitWorkTreeMarker(environment: GitWorkTreeEnvironment, cwd: string): Promise<GitWorkTreeMarker | null> {
  if (cwd.length === 0 || !pathe.isAbsolute(cwd)) return null;
  let current = pathe.normalize(cwd);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const dotGitPath = pathe.join(current, ".git");
    const hit = await probeGitMarker(environment, dotGitPath, current);
    if (hit !== null) return hit;
    const parent = pathe.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function probeGitMarker(
  environment: GitWorkTreeEnvironment,
  dotGitPath: string,
  markerParent: string,
): Promise<GitWorkTreeMarker | null> {
  let kind: string;
  try {
    kind = (await environment.fileInfo(dotGitPath)).kind;
  } catch {
    return null;
  }
  if (kind === "dir") return { dotGitPath, controlDirPath: dotGitPath };
  if (kind !== "file") return null;

  let content: string;
  try {
    content = await readTextFile(environment, dotGitPath);
  } catch {
    return null;
  }
  const controlDirPath = parseGitDir(content, markerParent);
  return controlDirPath === undefined ? null : { dotGitPath, controlDirPath };
}

export function isGitControlPath(targetPath: string, marker: GitWorkTreeMarker, pathClass: PathClass): boolean {
  return (
    isWithinDirectory(targetPath, marker.dotGitPath, pathClass) ||
    isWithinDirectory(targetPath, marker.controlDirPath, pathClass)
  );
}

function stripLeadingNoise(content: string): string {
  let s = content;
  if (s.codePointAt(0) === 0xfeff) s = s.slice(1);
  return s.trimStart();
}

function parseGitDir(content: string, markerParent: string): string | undefined {
  const line = stripLeadingNoise(content).split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith("gitdir:")) return undefined;
  const rawPath = line.slice("gitdir:".length).trim();
  if (rawPath.length === 0) return undefined;
  const absolute = pathe.isAbsolute(rawPath) ? rawPath : pathe.join(markerParent, rawPath);
  return pathe.normalize(absolute);
}
