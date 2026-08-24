/**
 * cron as an EXTENSION — the first capability migrated out of the engine. It rides the four
 * generic seams (registerCommand / emitEvent / expose / state, plus steer metadata), so a host
 * gets `/cron`, cron events and a programmatic handle by ATTACHING it — no wiring. The local
 * deployment profile attaches it; a server host simply doesn't, which makes Invariant 7
 * ("cron is local-only") structural instead of an option someone must remember to pass.
 */
import type { ExtensionCommand, ExtensionDefinition } from "../extensions/types.ts";
import { CronManager, type CronManagerOptions } from "./manager.ts";
import { isValidCronTask } from "./persist.ts";
import { MAX_CRON_JOBS_PER_SESSION, cronCreateTool, cronDeleteTool, cronListTool } from "./tools.ts";
import { hasFireWithinYears, parseCronExpression } from "./cron-expr.ts";
import type { SessionCronTaskInit } from "./session-store.ts";
import type { CronTask } from "./types.ts";

const MAX_CRON_PROMPT_BYTES = 8 * 1024;
const STATE_KEY = "registry";

/** The host-facing control surface (`session.extensionHandle<CronHandle>("cron")`) — what the
 *  old `session.createCronTask/…` facade became. */
export interface CronHandle {
  addTask(input: SessionCronTaskInit): CronTask;
  listTasks(): readonly CronTask[];
  removeTask(id: string): boolean;
  tick(): void;
  getNextFireTime(taskId?: string): number | null;
}

/** Host-path validation (the tools carry their own): trims/caps the input, refuses expressions
 *  that never fire within 5 years, enforces the per-session job cap. */
export function normalizeCronTaskInput(manager: CronManager, input: SessionCronTaskInit): SessionCronTaskInit {
  const cron = input.cron.trim().split(/\s+/).join(" ");
  const prompt = input.prompt;
  if (cron.length === 0) throw new Error("Cron expression cannot be empty.");
  if (prompt.trim().length === 0) throw new Error("Cron prompt cannot be empty.");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > MAX_CRON_PROMPT_BYTES) {
    throw new Error(`Cron prompt exceeds ${MAX_CRON_PROMPT_BYTES} bytes (got ${promptBytes}).`);
  }
  if (manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
    throw new Error(`Cron job cap reached (max ${MAX_CRON_JOBS_PER_SESSION} per session).`);
  }
  const parsed = parseCronExpression(cron);
  if (!hasFireWithinYears(parsed, 5, manager.clocks.wallNow())) {
    throw new Error(`Cron expression ${JSON.stringify(cron)} has no fire within 5 years; refusing to schedule.`);
  }
  return { ...input, cron };
}

export function cronExtension(options: CronManagerOptions = {}): ExtensionDefinition {
  return {
    id: "cron",
    async setup(api) {
      // One manager per session: setup runs per session open, so scheduling state is
      // session-scoped exactly as the capability's openSession was.
      const manager = new CronManager(options);
      manager.attach({
        steer: (prompt, metadata) => {
          const receipt = api.actions.steer(prompt, { metadata });
          return receipt === undefined ? undefined : { buffered: receipt.wakeTurnId === null };
        },
        emit: (name, data) => api.emitEvent(name, data),
        isIdle: () => api.actions.isIdle(),
        persistence: {
          load: async () => {
            const raw = await api.state.get<unknown>(STATE_KEY);
            return Array.isArray(raw) ? raw.filter(isValidCronTask) : [];
          },
          save: (tasks) => api.state.set(STATE_KEY, tasks),
        },
      });
      api.registerTool(cronCreateTool(manager));
      api.registerTool(cronDeleteTool(manager));
      api.registerTool(cronListTool(manager));
      const handle: CronHandle = {
        addTask: (input) => manager.addTask(normalizeCronTaskInput(manager, input)),
        listTasks: () => manager.store.list(),
        removeTask: (id) => manager.removeTasks([id]).length > 0,
        tick: () => manager.tick(),
        getNextFireTime: (taskId) => (taskId === undefined ? manager.getNextFireTime() : manager.getNextFireForTask(taskId)),
      };
      api.expose(handle);
      api.registerCommand(cronCommand(handle));
      await manager.loadPersisted();
      manager.start();
      return async () => {
        await manager.stop();
      };
    },
  };
}

/** `/cron` — behaviorally the command the core registry used to carry, now carried by the
 *  extension itself: attached ⇒ the command exists, detached ⇒ it doesn't. */
function cronCommand(handle: CronHandle): ExtensionCommand {
  return {
    name: "cron",
    description: "Manage cron jobs (list | add <m h dom mon dow> <prompt> [--once] | remove <id> | tick | next [id]).",
    run: (rawArgs) => {
      const { head: sub, tail } = splitHead(rawArgs);
      if (sub.length === 0 || sub === "list") {
        const tasks = handle.listTasks();
        return { ok: true, message: `${tasks.length} cron job(s).`, data: tasks };
      }
      if (sub === "add") {
        const init = parseCronAdd(tail);
        if (init === undefined) return { ok: false, message: "Usage: /cron add <m h dom mon dow> <prompt> [--once]" };
        try {
          const task = handle.addTask(init);
          return { ok: true, message: `Scheduled cron job ${task.id} (${task.cron}).`, data: task };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      }
      if (sub === "remove" || sub === "delete" || sub === "rm") {
        const { head: id } = splitHead(tail);
        if (id.length === 0) return { ok: false, message: `Usage: /cron ${sub} <id>` };
        return handle.removeTask(id)
          ? { ok: true, message: `Removed cron job ${id}.` }
          : { ok: false, message: `No cron job "${id}".` };
      }
      if (sub === "tick") {
        handle.tick();
        return { ok: true, message: "Cron ticked.", data: { nextFireAt: handle.getNextFireTime() } };
      }
      if (sub === "next") {
        const { head: id } = splitHead(tail);
        const taskId = id.length > 0 ? id : undefined;
        const nextFireAt = handle.getNextFireTime(taskId);
        return {
          ok: true,
          message: nextFireAt === null ? "No upcoming cron fire." : `Next fire at ${nextFireAt}.`,
          data: { taskId: taskId ?? null, nextFireAt },
        };
      }
      return { ok: false, message: `Unknown /cron action: ${sub}` };
    },
  };
}

function splitHead(input: string): { head: string; tail: string } {
  const trimmed = input.trim();
  const space = trimmed.search(/\s/);
  return space === -1 ? { head: trimmed, tail: "" } : { head: trimmed.slice(0, space), tail: trimmed.slice(space + 1).trim() };
}

function parseCronAdd(input: string): { cron: string; prompt: string; recurring: boolean } | undefined {
  let recurring = true;
  const tokens: string[] = [];
  for (const token of input.trim().split(/\s+/)) {
    if (token.length === 0) continue;
    if (token === "--once") recurring = false;
    else tokens.push(token);
  }
  if (tokens.length < 6) return undefined; // 5 cron fields + at least one prompt token
  return { cron: tokens.slice(0, 5).join(" "), prompt: tokens.slice(5).join(" "), recurring };
}
