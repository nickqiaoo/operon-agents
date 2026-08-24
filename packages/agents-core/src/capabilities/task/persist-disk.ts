import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isValidTask, type Task, type TaskListPersistence } from "./persist.ts";

const LIST_DIR = "tasklist";
const HWM_FILE = ".hwm";
const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Disk-directory task list: one JSON file per task under `<sessionDir>/tasklist/<id>.json`,
 * co-located under the SessionStore's home (next
 * to `agents/`, `blobs/`, `tasks/`), off the Machine sandbox. Atomic writes (temp + rename)
 * so a crash mid-write never leaves a torn file. Single live loop per session ⇒ no file locking.
 */
export class DiskTaskListPersistence implements TaskListPersistence {
  private readonly root: string;

  constructor(sessionDir: string) {
    this.root = join(sessionDir, LIST_DIR);
  }

  async writeTask(task: Task): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.taskPath(task.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(task, null, 2), "utf-8");
    await rename(tmp, target);
  }

  async readTask(id: string): Promise<Task | undefined> {
    if (!ID_RE.test(id)) return undefined;
    try {
      const value = JSON.parse(await readFile(this.taskPath(id), "utf-8")) as unknown;
      return isValidTask(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async listTasks(): Promise<Task[]> {
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch {
      return [];
    }
    const ids = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
    const out: Task[] = [];
    for (const id of ids) {
      const task = await this.readTask(id);
      if (task !== undefined) out.push(task);
    }
    // Numeric-id order so the list reads in creation order (ids are sequential integers).
    out.sort((a, b) => Number(a.id) - Number(b.id));
    return out;
  }

  async deleteTask(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    try {
      await unlink(this.taskPath(id));
    } catch {
      /* already gone */
    }
  }

  async readHighWaterMark(): Promise<number> {
    try {
      const value = parseInt((await readFile(join(this.root, HWM_FILE), "utf-8")).trim(), 10);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  async writeHighWaterMark(value: number): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(join(this.root, HWM_FILE), String(value), "utf-8");
  }

  private taskPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid task id: ${id}`);
    return join(this.root, `${id}.json`);
  }
}
