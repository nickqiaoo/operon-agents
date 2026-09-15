/**
 * TUI-owned data path helpers: input history, themes, tui.toml. Session storage is the
 * harness's concern (`createLocalHarness({ homeDir })`) and deliberately not routed here.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  OPERON_CACHE_DIR_NAME,
  OPERON_DATA_DIR_NAME,
  OPERON_HOME_ENV,
  OPERON_INPUT_HISTORY_DIR_NAME,
  OPERON_LOG_DIR_NAME,
  OPERON_THEMES_DIR_NAME,
} from '../constant/app.ts';

/** Root data directory: `$OPERON_HOME`, else `~/.operon`. */
export function getDataDir(): string {
  const envDir = process.env[OPERON_HOME_ENV];
  if (envDir) return envDir;
  return join(homedir(), OPERON_DATA_DIR_NAME);
}

export function getLogDir(): string {
  return join(getDataDir(), OPERON_LOG_DIR_NAME);
}

export function getCacheDir(): string {
  return join(getDataDir(), OPERON_CACHE_DIR_NAME);
}

export function getThemesDir(): string {
  return join(getDataDir(), OPERON_THEMES_DIR_NAME);
}

/** Input history for one working directory: `<dataDir>/user-history/<md5(cwd)>.jsonl`. */
export function getInputHistoryFile(workDir: string): string {
  const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
  return join(getDataDir(), OPERON_INPUT_HISTORY_DIR_NAME, `${hash}.jsonl`);
}
