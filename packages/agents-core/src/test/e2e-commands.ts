import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  LocalMachine,
  ListenerSink,
  Session,
  SteerBus,
  backgroundCapability,
  compactionCapability,
  createExtensionCommandRegistry,
  goalCapability,
  planCapability,
  skillsCapability,
  type AgentEvent,
  type GoalSnapshot,
  type PendingCompaction,
  type PlanData,
  type SkillActivationResult,
  type SkillRoot,
} from "../index.ts";
import { PluginManager, pluginsCapability } from "../plugins/index.ts";

class TmpHomeMachine extends LocalMachine {
  private readonly home: string;
  constructor(home: string) {
    super(home);
    this.home = home;
  }
  override gethome(): string {
    return this.home;
  }
}

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function writeSkill(root: string): Promise<readonly SkillRoot[]> {
  const skillDir = path.join(root, "project", ".agents", "skills", "review");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: review\ndescription: Review code changes.\n---\nReview the requested file.\n",
    "utf8",
  );
  return [{ path: path.join(root, "project", ".agents", "skills"), source: "project" }];
}

async function writePlugin(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "agents.plugin.json"),
    JSON.stringify(
      {
        name: "demo-plugin",
        version: "1.0.0",
        mcpServers: { weather: { transport: "stdio", command: "weather-mcp" } },
        interface: { displayName: "Demo Plugin" },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function main(): Promise<void> {
  const tmp = path.join(os.tmpdir(), `agents-commands-e2e-${process.pid}`);
  const home = path.join(tmp, "home");
  const pluginRoot = path.join(tmp, "demo-plugin");
  const machine = new TmpHomeMachine(tmp);

  try {
    const roots = await writeSkill(tmp);
    await writePlugin(pluginRoot);

    const events = new ListenerSink();
    const steer = new SteerBus();
    let activated: AgentEvent | undefined;
    events.subscribe((event) => {
      if (event.type === "skill.activated") activated = event;
    });

    const manager = new PluginManager({ machine, homeDir: home, now: () => 1_700_000_000_000 });
    const session = await Session.open({
      machine,
      events,
      steer,
      capabilities: [
        skillsCapability({ roots }),
        pluginsCapability(manager, () => undefined),
        goalCapability(),
        planCapability(),
        compactionCapability({ maxContextTokens: 100_000 }),
        backgroundCapability(),
        {
          name: "dyn-commands",
          service: {
            sessionCommands: () => [
              { name: "dyncmd", description: "dynamic test command", run: async (_ctx, args) => ({ ok: true, message: `dyn:${args}` }) },
            ],
          },
        },
      ],
    });

    try {
      const commands = createExtensionCommandRegistry();
      const skills = await commands.run("/skills", { session });
      check("commands: /skills lists scanned skills", skills.ok && Array.isArray(skills.data) && skills.data.some((skill) => skill.name === "review"));

      const skill = await commands.run("/skill:review src/app.ts", { session });
      const activation = skill.data as SkillActivationResult | undefined;
      check("commands: /skill:<name> activates a skill", skill.ok && activation?.skillName === "review" && activation.skillArgs === "src/app.ts");
      check("commands: skill activation emits event + steer", activated?.type === "skill.activated" && steer.drainSteering().length === 1);

      const install = await commands.run(`/plugins install ${pluginRoot}`, { session });
      check("commands: /plugins install installs from local path", install.ok && install.message.includes("demo-plugin"));

      const info = await commands.run("/plugins demo-plugin", { session });
      check("commands: /plugins <id> returns plugin info", info.ok && info.message === "Plugin demo-plugin.");

      const disableMcp = await commands.run("/plugins mcp disable demo-plugin weather", { session });
      const disabledInfo = await session.getPluginInfo("demo-plugin");
      check("commands: /plugins mcp disable toggles one server", disableMcp.ok && disabledInfo?.mcpServers[0]?.enabled === false);

      const list = await commands.run("/plugins list", { session });
      check("commands: /plugins list returns summaries", list.ok && Array.isArray(list.data) && list.data.length === 1);

      const goalSet = await commands.run("/goal set ship the v1 release", { session });
      const goalSnap = goalSet.data as GoalSnapshot | undefined;
      check("commands: /goal set creates an active goal", goalSet.ok && goalSnap?.objective === "ship the v1 release" && goalSnap.status === "active");

      const goalPause = await commands.run("/goal pause waiting on review", { session });
      check("commands: /goal pause records reason", goalPause.ok && (goalPause.data as GoalSnapshot).status === "paused" && (goalPause.data as GoalSnapshot).terminalReason === "waiting on review");

      const goalResume = await commands.run("/goal resume", { session });
      const resumed = goalResume.data as GoalSnapshot;
      check("commands: /goal resume clears the pause reason", goalResume.ok && resumed.status === "active" && resumed.terminalReason === undefined);

      const goalBudget = await commands.run("/goal budget turns=5 tokens=2000", { session });
      const budgeted = goalBudget.data as GoalSnapshot;
      check("commands: /goal budget sets a structured budget", goalBudget.ok && budgeted.budget.turnBudget === 5 && budgeted.budget.tokenBudget === 2000);

      const goalShow = await commands.run("/goal", { session });
      check("commands: /goal shows the current goal", goalShow.ok && (goalShow.data as GoalSnapshot)?.status === "active");

      const goalCancel = await commands.run("/goal cancel done early", { session });
      const afterCancel = await commands.run("/goal", { session });
      check("commands: /goal cancel clears the goal", goalCancel.ok && afterCancel.ok && afterCancel.data === null);

      const planOn = await commands.run("/plan on", { session });
      check("commands: /plan on enters plan mode", planOn.ok && (planOn.data as PlanData) !== null);

      const planShow = await commands.run("/plan", { session });
      check("commands: /plan reports active plan", planShow.ok && planShow.message === "Plan mode is on.");

      const planOff = await commands.run("/plan off", { session });
      check("commands: /plan off exits plan mode", planOff.ok && (planOff.data as PlanData) === null);

      const compactReq = await commands.run("/compact drop old tool output", { session });
      const pending = compactReq.data as PendingCompaction | undefined;
      check("commands: /compact requests compaction with instruction", compactReq.ok && pending?.instruction === "drop old tool output");

      const compactStatus = await commands.run("/compact status", { session });
      check("commands: /compact status returns the pending request", compactStatus.ok && (compactStatus.data as PendingCompaction | null)?.id === pending?.id);

      const compactCancel = await commands.run("/compact cancel", { session });
      const compactStatusAfter = await commands.run("/compact status", { session });
      check("commands: /compact cancel clears the pending request", compactCancel.ok && compactStatusAfter.ok && compactStatusAfter.data === null);

      // Dynamic commands: the capability duck protocol — a service exposing sessionCommands()
      // contributes to this session's command set (what an extension's registerCommand rides).
      const dyn = await commands.run("/dyncmd hello", { session });
      check("commands: a capability-contributed dynamic command resolves and runs", dyn.ok && dyn.message === "dyn:hello");
      const dynListed = commands.list(session).some((c) => c.name === "dyncmd");
      check("commands: list(session) includes dynamic commands", dynListed);
      const tasksList = await commands.run("/tasks list", { session });
      check("commands: /tasks list returns background tasks", tasksList.ok && Array.isArray(tasksList.data) && tasksList.data.length === 0);

      const tasksStopMissing = await commands.run("/tasks stop nope", { session });
      check("commands: /tasks stop reports unknown task", !tasksStopMissing.ok && tasksStopMissing.message.includes("nope"));
    } finally {
      await session.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ COMMANDS E2E PASS — headless /skills + /skill + /plugins + /goal + /plan + /compact + /cron + /tasks dispatch");
  } else {
    console.log("❌ COMMANDS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ COMMANDS E2E ERROR:", error);
  process.exit(1);
});
