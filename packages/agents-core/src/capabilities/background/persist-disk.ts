import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isValidPersistedTask, type BackgroundTaskPersistence, type PersistedTask } from "./persist.ts";

const TASKS_DIR = "tasks";
const STATE_FILE = "state.json";
const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Disk-directory task store: `<sessionDir>/tasks/<id>/state.json`, one directory per
 * task. Co-located under the SessionStore's own home (next to `agents/`
 * and `blobs/`), so it inherits the session's durability and stays off the Machine
 * sandbox. Writes are atomic (temp + rename) so a crash mid-write never leaves a torn file.
 */
export class DiskBackgroundTaskPersistence implements BackgroundTaskPersistence {
  private readonly root: string;

  constructor(sessionDir: string) {
    this.root = join(sessionDir, TASKS_DIR);
  }

  async writeTask(task: PersistedTask): Promise<void> {
    const dir = this.taskDir(task.taskId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, STATE_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(task), "utf-8");
    await rename(tmp, target);
  }

  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    if (!ID_RE.test(taskId)) return undefined;
    try {
      const raw = await readFile(join(this.taskDir(taskId), STATE_FILE), "utf-8");
      const value = JSON.parse(raw) as unknown;
      return isValidPersistedTask(value) ? value : undefined;
    } catch {
      // Missing / corrupt / torn file — treat as absent.
      return undefined;
    }
  }

  async listTasks(): Promise<readonly PersistedTask[]> {
    let ids: string[];
    try {
      ids = await readdir(this.root);
    } catch {
      return []; // no tasks/ dir yet
    }
    const out: PersistedTask[] = [];
    for (const id of ids) {
      const task = await this.readTask(id);
      if (task !== undefined) out.push(task);
    }
    return out;
  }

  async deleteTask(taskId: string): Promise<void> {
    if (!ID_RE.test(taskId)) return;
    await rm(this.taskDir(taskId), { recursive: true, force: true });
  }

  private taskDir(taskId: string): string {
    if (!ID_RE.test(taskId)) throw new Error(`invalid background task id: ${taskId}`);
    return join(this.root, taskId);
  }
}
