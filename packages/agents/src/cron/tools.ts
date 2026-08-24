import { z } from "zod";
import { ToolAccesses, defineTool, globApproval, type Tool, type ToolPlan, type ToolResult } from "operon-agents-core";
import {
  computeNextCronRun,
  cronToHuman,
  hasFireWithinYears,
  parseCronExpression,
  type ParsedCronExpression,
} from "./cron-expr.ts";
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from "./jitter.ts";
import { formatLocalIsoWithOffset } from "./time-format.ts";
import type { CronManager } from "./manager.ts";
import type { CronTask } from "./types.ts";

export const MAX_CRON_JOBS_PER_SESSION = 50;
const MAX_PROMPT_BYTES = 8 * 1024;
const ONE_SHOT_MAX_FUTURE_MS = 350 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[0-9a-f]{8}$/;
const PROMPT_PREVIEW_BYTES = 200;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function text(s: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: s }], isError };
}

export function cronCreateTool(manager: CronManager): Tool {
  return defineTool({
    name: "CronCreate",
    description:
      'Schedule a prompt to be re-injected into this session at a future time. `cron` is a 5-field local-time expression ("M H DoM Mon DoW"). recurring=true (default) fires on every match until deleted or auto-expired after 7 days; recurring=false fires once then auto-deletes.',
    params: z.object({
      cron: z.string().describe('5-field cron expression in local time, e.g. "*/5 * * * *" (every 5 min) or "30 14 28 2 *".'),
      prompt: z.string().min(1).max(MAX_PROMPT_BYTES).describe("The prompt to enqueue at each fire time."),
      recurring: z.boolean().optional().default(true).describe("true = repeat until deleted/expired; false = fire once."),
    }),
    resolve: (args) => {
      const normalizedCron = args.cron.trim().split(/\s+/).join(" ");
      let parsed: ParsedCronExpression;
      try {
        parsed = parseCronExpression(normalizedCron);
      } catch (err) {
        return errorPlan("CronCreate", `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`);
      }

      const nowAtPrepare = manager.clocks.wallNow();
      if (!hasFireWithinYears(parsed, 5, nowAtPrepare)) {
        return errorPlan("CronCreate", `Cron expression ${JSON.stringify(normalizedCron)} has no fire within 5 years; refusing to schedule.`);
      }
      if (manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
        return errorPlan("CronCreate", `Cron job cap reached (max ${MAX_CRON_JOBS_PER_SESSION} per session).`);
      }
      const byteLen = Buffer.byteLength(args.prompt, "utf8");
      if (byteLen > MAX_PROMPT_BYTES) {
        return errorPlan("CronCreate", `Prompt exceeds ${MAX_PROMPT_BYTES} bytes (got ${byteLen}).`);
      }

      const recurring = args.recurring !== false;
      if (!recurring) {
        const firstFire = computeNextCronRun(parsed, nowAtPrepare);
        if (firstFire !== null && firstFire - nowAtPrepare > ONE_SHOT_MAX_FUTURE_MS) {
          return errorPlan(
            "CronCreate",
            `One-shot cron ${JSON.stringify(normalizedCron)} would not fire until ${formatLocalIsoWithOffset(firstFire)} (more than a year out). The pinned day/month has already passed this year — pick a future date or use wildcards.`,
          );
        }
      }

      return {
        ...globApproval("CronCreate", JSON.stringify({ cron: normalizedCron, prompt: args.prompt, recurring })),
        accesses: ToolAccesses.none(),
        display: { title: recurring ? `Schedule cron ${normalizedCron}` : `Schedule one-shot ${normalizedCron}` },
        run: async (): Promise<ToolResult> => {
          const nowMs = manager.clocks.wallNow();
          if (manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
            return text(`Cron job cap reached (max ${MAX_CRON_JOBS_PER_SESSION} per session).`, true);
          }
          const task = manager.addTask({ cron: normalizedCron, prompt: args.prompt, recurring });
          const ideal = computeNextCronRun(parsed, nowMs);
          const nextFireAt = ideal === null ? null : recurring ? jitteredNextCronRunMs(task, parsed, ideal) : oneShotJitteredNextCronRunMs(task, ideal);
          return text(
            [
              `id: ${task.id}`,
              `cron: ${normalizedCron}`,
              `humanSchedule: ${cronToHuman(parsed)}`,
              `recurring: ${String(recurring)}`,
              `nextFireAt: ${nextFireAt === null ? "null" : formatLocalIsoWithOffset(nextFireAt)}`,
            ].join("\n"),
          );
        },
      };
    },
  });
}

export function cronDeleteTool(manager: CronManager): Tool {
  return defineTool({
    name: "CronDelete",
    description: "Cancel a scheduled cron job by its 8-hex id (from CronCreate / CronList).",
    params: z.object({ id: z.string().describe("The 8-hex cron job id.") }),
    resolve: (args) => {
      if (!ID_PATTERN.test(args.id)) {
        return errorPlan("CronDelete", `Invalid cron job id ${JSON.stringify(args.id)} — must be 8 lowercase hex characters.`);
      }
      return {
        ...globApproval("CronDelete", args.id),
        accesses: ToolAccesses.none(),
        display: { title: `Delete cron ${args.id}` },
        run: async (): Promise<ToolResult> => {
          const removed = manager.removeTasks([args.id]);
          if (removed.length === 0) return text(`No cron job with id ${args.id}.`, true);
          return text(`Deleted cron job ${args.id}.`);
        },
      };
    },
  });
}

function previewPrompt(prompt: string): string {
  const buf = Buffer.from(prompt, "utf8");
  if (buf.byteLength <= PROMPT_PREVIEW_BYTES) return prompt;
  let end = PROMPT_PREVIEW_BYTES;
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return `${buf.subarray(0, end).toString("utf8")}…(truncated)`;
}

export function cronListTool(manager: CronManager): Tool {
  return defineTool({
    name: "CronList",
    description: "List the cron jobs scheduled in this session (id, expression, human schedule, next fire, recurring, age, stale).",
    params: z.object({}),
    resolve: () => ({
      ...globApproval("CronList", "list"),
      accesses: ToolAccesses.none(),
      display: { title: "List cron jobs" },
      run: async (): Promise<ToolResult> => {
        const tasks = manager.store.list();
        const nowMs = manager.clocks.wallNow();
        const header = `cron_jobs: ${tasks.length}`;
        if (tasks.length === 0) return text(`${header}\nNo cron jobs scheduled.`);
        return text(`${header}\n${tasks.map((t) => renderRecord(manager, t, nowMs)).join("\n---\n")}`);
      },
    }),
  });
}

function renderRecord(manager: CronManager, task: CronTask, nowMs: number): string {
  const recurring = task.recurring !== false;
  const ageMs = nowMs - task.createdAt;
  const ageDays = Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0;
  const stale = manager.isStale(task);

  let humanSchedule = task.cron;
  let nextFireAtIso = "null";
  try {
    humanSchedule = cronToHuman(parseCronExpression(task.cron));
    const nextFireMs = manager.getNextFireForTask(task.id);
    if (nextFireMs !== null) nextFireAtIso = formatLocalIsoWithOffset(nextFireMs);
  } catch {
    /* malformed cron — leave raw + null */
  }

  return [
    `id: ${task.id}`,
    `cron: ${task.cron}`,
    `humanSchedule: ${humanSchedule}`,
    `prompt: ${JSON.stringify(previewPrompt(task.prompt))}`,
    `nextFireAt: ${nextFireAtIso}`,
    `recurring: ${String(recurring)}`,
    `ageDays: ${ageDays.toFixed(2)}`,
    `stale: ${String(stale)}`,
  ].join("\n");
}

function errorPlan(tool: string, message: string): ToolPlan {
  return {
    approvalRule: tool,
    accesses: ToolAccesses.none(),
    run: async (): Promise<ToolResult> => text(message, true),
  };
}
