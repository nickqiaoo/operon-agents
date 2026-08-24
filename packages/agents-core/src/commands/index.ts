import type { Session } from "../agent/session.ts";

export interface CommandContext {
  readonly session: Session;
}

export interface CommandResult<T = unknown> {
  readonly ok: boolean;
  readonly message: string;
  readonly data?: T;
}

export interface ParsedCommand {
  readonly raw: string;
  readonly name: string;
  readonly args: string;
}

export interface HeadlessCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  run(ctx: CommandContext, args: string, parsed: ParsedCommand): Promise<CommandResult> | CommandResult;
}

export class CommandRegistry {
  private readonly commands = new Map<string, HeadlessCommand>();

  register(command: HeadlessCommand): void {
    this.commands.set(normalizeCommandName(command.name), command);
    for (const alias of command.aliases ?? []) this.commands.set(normalizeCommandName(alias), command);
  }

  list(session?: Session): readonly HeadlessCommand[] {
    const out = new Set(this.commands.values());
    if (session !== undefined) for (const command of dynamicCommands(session)) out.add(command);
    return [...out].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async run(input: string, ctx: CommandContext): Promise<CommandResult> {
    const parsed = parseCommand(input);
    let command = this.commands.get(parsed.name);
    let args = parsed.args;

    if (command === undefined && parsed.name.startsWith("skill:")) {
      command = this.commands.get("skill");
      args = `${parsed.name.slice("skill:".length)} ${parsed.args}`.trim();
    }

    // Dynamic commands (capability-contributed, e.g. an extension's) resolve after the static
    // set, so a static registration always wins its name.
    if (command === undefined) {
      command = dynamicCommands(ctx.session).find(
        (candidate) =>
          normalizeCommandName(candidate.name) === parsed.name ||
          (candidate.aliases ?? []).some((alias) => normalizeCommandName(alias) === parsed.name),
      );
    }
    if (command === undefined) {
      return { ok: false, message: `Unknown command: /${parsed.name}` };
    }
    return command.run(ctx, args, parsed);
  }
}

/**
 * Commands contributed at runtime — the duck protocol: any capability whose `service` object
 * exposes `sessionCommands(): HeadlessCommand[]` adds to the session's command set (the
 * extensions runtime uses this to surface `api.registerCommand` registrations). No names, no
 * imports: the registry stays ignorant of who contributes.
 */
function dynamicCommands(session: Session): readonly HeadlessCommand[] {
  const out: HeadlessCommand[] = [];
  for (const capability of session.capabilities) {
    const service = capability.service as { sessionCommands?: () => readonly HeadlessCommand[] } | undefined;
    if (typeof service?.sessionCommands === "function") out.push(...service.sessionCommands());
  }
  return out;
}

export function parseCommand(input: string): ParsedCommand {
  const raw = input;
  const trimmed = input.trim();
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1).trimStart() : trimmed;
  const firstSpace = withoutSlash.search(/\s/);
  const name = firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace);
  const args = firstSpace === -1 ? "" : withoutSlash.slice(firstSpace + 1).trim();
  if (name.length === 0) throw new Error("Command cannot be empty.");
  return { raw, name: normalizeCommandName(name), args };
}

export function createExtensionCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerExtensionCommands(registry);
  return registry;
}

export function registerExtensionCommands(registry: CommandRegistry): void {
  registerCapabilityCommands(registry);

  registry.register({
    name: "skills",
    description: "List available skills.",
    run: async ({ session }) => {
      const skills = await session.listSkills();
      return { ok: true, message: `${skills.length} skill(s) available.`, data: skills };
    },
  });

  registry.register({
    name: "skill",
    description: "Activate a skill by name.",
    run: async ({ session }, args) => {
      const { head: name, tail: skillArgs } = splitHead(args);
      if (name.length === 0) return { ok: false, message: "Usage: /skill <name> [args] or /skill:<name> [args]" };
      const activation = await session.activateSkill({ name, args: skillArgs, trigger: "user-slash" });
      return { ok: true, message: `Activated skill ${activation.skillName}.`, data: activation };
    },
  });

  registry.register({
    name: "plugins",
    description: "Manage installed plugins.",
    run: async ({ session }, rawArgs) => {
      const { head: sub, tail } = splitHead(rawArgs);
      if (sub.length === 0 || sub === "list") {
        const plugins = await session.listPlugins();
        return { ok: true, message: `${plugins.length} plugin(s) installed.`, data: plugins };
      }

      if (sub === "install") {
        if (tail.length === 0) return { ok: false, message: "Usage: /plugins install <local-path-or-zip-url>" };
        const plugin = await session.installPlugin(tail);
        return { ok: true, message: `Installed plugin ${plugin.id}.`, data: plugin };
      }

      if (sub === "enable" || sub === "disable") {
        const { head: id } = splitHead(tail);
        if (id.length === 0) return { ok: false, message: `Usage: /plugins ${sub} <id>` };
        await session.setPluginEnabled(id, sub === "enable");
        return { ok: true, message: `${sub === "enable" ? "Enabled" : "Disabled"} plugin ${id}.` };
      }

      if (sub === "remove") {
        const { head: id } = splitHead(tail);
        if (id.length === 0) return { ok: false, message: "Usage: /plugins remove <id>" };
        await session.removePlugin(id);
        return { ok: true, message: `Removed plugin ${id}.` };
      }

      if (sub === "reload") {
        const summary = await session.reloadPlugins();
        return { ok: true, message: "Reloaded plugins.", data: summary };
      }

      if (sub === "info") {
        const { head: id } = splitHead(tail);
        if (id.length === 0) return { ok: false, message: "Usage: /plugins info <id>" };
        const info = await session.getPluginInfo(id);
        return info === undefined
          ? { ok: false, message: `Plugin "${id}" is not installed.` }
          : { ok: true, message: `Plugin ${info.id}.`, data: info };
      }

      if (sub === "mcp") {
        const { head: action, tail: rest } = splitHead(tail);
        const { head: id, tail: serverTail } = splitHead(rest);
        const { head: server } = splitHead(serverTail);
        if ((action !== "enable" && action !== "disable") || id.length === 0 || server.length === 0) {
          return { ok: false, message: "Usage: /plugins mcp enable|disable <id> <server>" };
        }
        await session.setPluginMcpServerEnabled(id, server, action === "enable");
        return { ok: true, message: `${action === "enable" ? "Enabled" : "Disabled"} MCP server ${server} for ${id}.` };
      }

      const info = await session.getPluginInfo(sub);
      return info === undefined
        ? { ok: false, message: `Unknown /plugins action or plugin: ${sub}` }
        : { ok: true, message: `Plugin ${info.id}.`, data: info };
    },
  });
}

export function registerCapabilityCommands(registry: CommandRegistry): void {
  registry.register({
    name: "tasks",
    aliases: ["task"],
    description: "Inspect background tasks (list [active] | output <id> | stop <id> [reason]).",
    run: async ({ session }, rawArgs) => {
      const { head: sub, tail } = splitHead(rawArgs);
      if (sub.length === 0 || sub === "list" || sub === "active") {
        const activeOnly = sub === "active" || tail.trim() === "active";
        const tasks = await session.listBackgroundTasks(activeOnly ? { activeOnly: true } : {});
        return { ok: true, message: `${tasks.length} background task(s).`, data: tasks };
      }

      if (sub === "output") {
        const { head: id } = splitHead(tail);
        if (id.length === 0) return { ok: false, message: "Usage: /tasks output <id>" };
        const snapshot = await session.readBackgroundTaskOutput(id);
        return { ok: true, message: `Output for task ${id}.`, data: snapshot };
      }

      if (sub === "stop") {
        const { head: id, tail: reason } = splitHead(tail);
        if (id.length === 0) return { ok: false, message: "Usage: /tasks stop <id> [reason]" };
        const info = await session.stopBackgroundTask(id, reason.length > 0 ? reason : undefined);
        return info === undefined
          ? { ok: false, message: `No background task "${id}".` }
          : { ok: true, message: `Stopped task ${id}.`, data: info };
      }

      return { ok: false, message: `Unknown /tasks action: ${sub}` };
    },
  });

  registry.register({
    name: "goal",
    description: "Manage the session goal (show | set <objective> | pause/resume/cancel [reason] | budget <turns=N tokens=N wallClockMs=N>).",
    run: async ({ session }, rawArgs) => {
      const { head: sub, tail } = splitHead(rawArgs);
      if (sub.length === 0 || sub === "show" || sub === "status") {
        const goal = await session.getGoal();
        return goal === null
          ? { ok: true, message: "No active goal.", data: null }
          : { ok: true, message: `Goal is ${goal.status}.`, data: goal };
      }

      if (sub === "set" || sub === "new") {
        const objective = tail.trim();
        if (objective.length === 0) return { ok: false, message: "Usage: /goal set <objective>" };
        const goal = await session.createGoal({ objective });
        return { ok: true, message: "Goal set.", data: goal };
      }

      if (sub === "pause" || sub === "resume" || sub === "cancel") {
        const reason = tail.trim().length > 0 ? tail.trim() : undefined;
        const goal =
          sub === "pause"
            ? await session.pauseGoal({ reason })
            : sub === "resume"
              ? await session.resumeGoal({ reason })
              : await session.cancelGoal({ reason });
        if (goal === null) return { ok: false, message: "No active goal." };
        const verb = sub === "pause" ? "Paused" : sub === "resume" ? "Resumed" : "Cancelled";
        return { ok: true, message: `${verb} goal.`, data: goal };
      }

      if (sub === "budget") {
        const budget = parseGoalBudget(tail);
        if (budget === undefined) return { ok: false, message: "Usage: /goal budget <turns=N tokens=N wallClockMs=N>" };
        const goal = await session.setGoalBudget(budget);
        if (goal === null) return { ok: false, message: "No active goal." };
        return { ok: true, message: "Goal budget updated.", data: goal };
      }

      return { ok: false, message: `Unknown /goal action: ${sub}` };
    },
  });

  registry.register({
    name: "workflows",
    aliases: ["workflow"],
    description: "Inspect workflow runs (list | info <runId>).",
    run: async ({ session }, rawArgs) => {
      const { head: sub, tail } = splitHead(rawArgs);
      if (sub.length === 0 || sub === "list") {
        const runs = await session.listWorkflows();
        return { ok: true, message: `${runs.length} workflow run(s).`, data: runs };
      }

      if (sub === "info" || sub === "show" || sub === "get") {
        const { head: runId } = splitHead(tail);
        if (runId.length === 0) return { ok: false, message: "Usage: /workflows info <runId>" };
        const run = await session.getWorkflow(runId);
        return run === undefined
          ? { ok: false, message: `No workflow run "${runId}".` }
          : { ok: true, message: `Workflow ${run.workflowName} is ${run.status}.`, data: run };
      }

      return { ok: false, message: `Unknown /workflows action: ${sub}` };
    },
  });

  registry.register({
    name: "plan",
    description: "Toggle plan mode (show | on | off).",
    run: async ({ session }, rawArgs) => {
      const { head: sub } = splitHead(rawArgs);
      if (sub.length === 0 || sub === "show" || sub === "status") {
        const plan = await session.getPlan();
        return { ok: true, message: plan === null ? "Plan mode is off." : "Plan mode is on.", data: plan };
      }

      if (sub === "on" || sub === "enter") {
        const plan = await session.setPlanMode(true);
        return { ok: true, message: "Plan mode on.", data: plan };
      }

      if (sub === "off" || sub === "exit" || sub === "clear") {
        const plan = await session.setPlanMode(false);
        return { ok: true, message: "Plan mode off.", data: plan };
      }

      return { ok: false, message: `Unknown /plan action: ${sub}` };
    },
  });

  registry.register({
    name: "compact",
    description: "Request conversation compaction ([instruction] | status | cancel).",
    run: async ({ session }, rawArgs) => {
      const lower = rawArgs.trim().toLowerCase();
      if (lower === "status" || lower === "pending") {
        const pending = await session.pendingCompaction();
        return { ok: true, message: pending === null ? "No pending compaction." : "Compaction pending.", data: pending };
      }

      if (lower === "cancel") {
        const cancelled = await session.cancelCompaction();
        return cancelled === null
          ? { ok: false, message: "No pending compaction to cancel." }
          : { ok: true, message: "Cancelled pending compaction.", data: cancelled };
      }

      const instruction = rawArgs.trim();
      const pending = await session.compact(instruction.length > 0 ? { instruction } : {});
      return { ok: true, message: "Compaction requested.", data: pending };
    },
  });
}

function parseGoalBudget(input: string): { turns?: number; tokens?: number; wallClockMs?: number } | undefined {
  const budget: { turns?: number; tokens?: number; wallClockMs?: number } = {};
  let matched = false;
  for (const token of input.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = Number(token.slice(eq + 1));
    if (key === "turns") {
      budget.turns = value;
      matched = true;
    } else if (key === "tokens") {
      budget.tokens = value;
      matched = true;
    } else if (key === "wallClockMs" || key === "wall" || key === "ms") {
      budget.wallClockMs = value;
      matched = true;
    }
  }
  return matched ? budget : undefined;
}

function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase();
}

function splitHead(input: string): { head: string; tail: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { head: "", tail: "" };
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return { head: trimmed, tail: "" };
  return { head: trimmed.slice(0, firstSpace), tail: trimmed.slice(firstSpace + 1).trim() };
}
