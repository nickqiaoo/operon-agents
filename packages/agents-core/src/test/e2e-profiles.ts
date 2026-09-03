import { testRunner, openTestSession } from "./faux.ts";
import { T } from "../index.ts";
// Agent profiles: YAML defs with `extends` inheritance + a nunjucks system-prompt renderer that
// pulls live context (cwd/os/AGENTS.md). Builtin profiles (agent + coder/explore/plan) ship
// inline; a profile builds into a runnable Agent whose system prompt renders at run time.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentFromProfile,
  CompactionService,
  DEFAULT_AGENT_PROFILES,
  LocalMachine,
  readTool,
  resolveAgentProfiles,
  Session,
  writeTool,
} from "../index.ts";
import type { RawAgentProfile } from "../index.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  // ── A: extends inheritance + renderer ──
  {
    const raw: RawAgentProfile[] = [
      { name: "base", systemPromptTemplate: "os={{ os }} cwd={{ workDir }}{% if roleAdditional %} role={{ roleAdditional }}{% endif %}", tools: ["A", "B"] },
      { name: "child", extends: "base", promptVars: { roleAdditional: "sub" }, tools: ["A"] },
    ];
    const resolved = resolveAgentProfiles(raw);
    check("extends: child inherits the parent template", resolved["child"] !== undefined);
    check("extends: tools overridden by child", JSON.stringify(resolved["child"]!.tools) === JSON.stringify(["A"]));
    check("extends: parent keeps its own tools", JSON.stringify(resolved["base"]!.tools) === JSON.stringify(["A", "B"]));

    const rendered = resolved["child"]!.systemPrompt({ osKind: "linux", shell: "bash", cwd: "/x" });
    check("render: vars substituted", rendered === "os=linux cwd=/x role=sub");

    const base = resolved["base"]!.systemPrompt({ osKind: "linux", shell: "bash", cwd: "/x" });
    check("render: conditional sections omitted when empty", base === "os=linux cwd=/x");
  }

  // ── B: cycle detection ──
  {
    let threw = false;
    try {
      resolveAgentProfiles([
        { name: "a", extends: "b" },
        { name: "b", extends: "a" },
      ]);
    } catch {
      threw = true;
    }
    check("extends: cycle is rejected", threw);
  }

  // ── B2: subagent edge descriptions are per-parent, never a mutation of the shared target ──
  {
    const raw: RawAgentProfile[] = [
      { name: "shared-sub", systemPromptTemplate: "sub", subagents: { "leaf": {} } },
      { name: "leaf", systemPromptTemplate: "leaf" },
      { name: "parent-one", systemPromptTemplate: "p1", subagents: { "shared-sub": { description: "from-p1" } } },
      { name: "parent-two", systemPromptTemplate: "p2", subagents: { "shared-sub": { description: "from-p2" } } },
      { name: "parent-plain", systemPromptTemplate: "p3", subagents: { "shared-sub": {} } },
    ];
    const resolved = resolveAgentProfiles(raw);
    check("edge desc: shared target is not mutated", resolved["shared-sub"]!.description === undefined);
    check("edge desc: each parent sees its own edge description", resolved["parent-one"]!.subagents!["shared-sub"]!.description === "from-p1" && resolved["parent-two"]!.subagents!["shared-sub"]!.description === "from-p2");
    check("edge desc: a plain edge shares the target object itself", resolved["parent-plain"]!.subagents!["shared-sub"] === resolved["shared-sub"]);
    check("edge desc: a described edge copy still carries the target's own linked subagents", resolved["parent-one"]!.subagents!["shared-sub"]!.subagents?.["leaf"] === resolved["leaf"]);
  }

  // ── C: builtin profiles (agent + coder/explore/plan) ──
  {
    const agent = DEFAULT_AGENT_PROFILES["agent"];
    const coder = DEFAULT_AGENT_PROFILES["coder"];
    const explore = DEFAULT_AGENT_PROFILES["explore"];
    const plan = DEFAULT_AGENT_PROFILES["plan"];
    check("builtin: all four profiles present", [agent, coder, explore, plan].every((p) => p !== undefined));
    check("builtin: agent declares coder/explore/plan subagents", ["coder", "explore", "plan"].every((n) => agent!.subagents?.[n] !== undefined));
    check("builtin: agent has the Agent + mcp glob tools", agent!.tools.includes("Agent") && agent!.tools.includes("mcp__*"));
    check("builtin: coder can write, explore cannot (read-only)", coder!.tools.includes("Write") && !explore!.tools.includes("Write") && explore!.tools.includes("Read"));
    check("builtin: subagents inherit the agent system template", typeof coder!.systemPrompt === "function" && typeof plan!.systemPrompt === "function");
    const coderPrompt = coder!.systemPrompt({ osKind: "linux", shell: "bash", cwd: "/repo" });
    check("builtin: coder prompt carries its subagent role + inherited env section", coderPrompt.includes("subagent") && coderPrompt.includes("/repo"));
  }

  // ── D: build a runnable Agent — system prompt renders from a live machine ──
  {
    const dir = mkdtempSync(join(tmpdir(), "agent-fw-profiles-"));
    try {
      class CountingLocalMachine extends LocalMachine {
        readCount = 0;
        listCount = 0;
        override async readBytes(path: string, range?: Parameters<LocalMachine["readBytes"]>[1]) {
          this.readCount += 1;
          return super.readBytes(path, range);
        }
        override async listDir(path: string) {
          this.listCount += 1;
          return super.listDir(path);
        }
      }

      writeFileSync(join(dir, "AGENTS.md"), "initial project instruction");
      const machine = new CountingLocalMachine(dir);
      const compaction = new CompactionService();
      const session = await openTestSession({ machine, capabilities: [{ name: "compaction", provides: [{ token: T.Compaction, create: () => compaction }] }] });
      const unknown: string[] = [];
      const agent = await buildAgentFromProfile(DEFAULT_AGENT_PROFILES["coder"]!, {
        tools: { Read: readTool, Write: writeTool }, // only these resolve; the rest are skipped
        onUnknownTool: (name) => unknown.push(name),
      });
      check("build: only registry-known tools are resolved (glob/unknown skipped)", agent.tools.length === 2);
      check("build: every skipped non-glob name is surfaced to onUnknownTool", unknown.length > 0 && !unknown.includes("Read") && !unknown.includes("Write") && unknown.every((n) => !n.includes("*")));
      const runtimeContext = {
        sessionId: "t",
        address: "main",
        signal: new AbortController().signal,
        machine,
        resolveSystemPromptContext: () => session.resolveSystemPromptContext(machine),
      };
      const text = (await agent.resolveInstructions(runtimeContext)) ?? "";
      const readsAfterFirst = machine.readCount;
      const second = (await agent.resolveInstructions(runtimeContext)) ?? "";
      check("build: rendered prompt includes the live cwd", text.includes(dir));
      check("build: rendered prompt includes AGENTS.md", text.includes("initial project instruction"));
      check("build: rendered prompt includes the subagent role", text.includes("subagent"));
      check("cache: ordinary turns reuse an identical prompt without filesystem reads", second === text && machine.readCount === readsAfterFirst);
      check("cache: cwdListing was removed (listDir is never called)", machine.listCount === 0 && !text.includes("Working directory contents"));
      check("cache: Session date is calendar-only", /- Date: \d{4}-\d{2}-\d{2}(?:\n|$)/.test(text) && !/- Date: .*T/.test(text));
      check("skills: profile prompt has no duplicate skills section", !text.includes("## Available skills"));

      compaction.recordCompleted();
      const afterCompact = (await agent.resolveInstructions(runtimeContext)) ?? "";
      check("cache: full-compaction revision rereads but preserves stable output", machine.readCount > readsAfterFirst && afterCompact === text);

      const readsBeforeEdit = machine.readCount;
      writeFileSync(join(dir, "AGENTS.md"), "updated project instruction");
      const afterEdit = (await agent.resolveInstructions(runtimeContext)) ?? "";
      check("cache: later turns reuse the Session AGENTS.md snapshot after an external edit",
        machine.readCount === readsBeforeEdit && afterEdit === afterCompact && !afterEdit.includes("updated project instruction"));

      const subdir = join(dir, "worktree");
      mkdirSync(subdir);
      writeFileSync(join(subdir, "AGENTS.md"), "worktree instruction");
      const worktree = machine.withCwd(subdir);
      const worktreePrompt = (await agent.resolveInstructions({
        ...runtimeContext,
        machine: worktree,
        resolveSystemPromptContext: () => session.resolveSystemPromptContext(worktree),
      })) ?? "";
      check("runtime: shared profile Agent renders the current worktree machine+cwd", worktreePrompt.includes(subdir) && worktreePrompt.includes("worktree instruction"));

      await session.close();
      const readsBeforeResume = machine.readCount;
      const resumed = await openTestSession({ machine });
      await resumed.resolveSystemPromptContext(machine);
      check("resume: a newly opened Session rereads prompt context", machine.readCount > readsBeforeResume);
      await resumed.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ PROFILES E2E FAIL");
    process.exit(1);
  }
  console.log("✅ PROFILES E2E PASS — extends inheritance + nunjucks renderer + builtins (agent/coder/explore/plan) + live-context build");
}

main().catch((error) => {
  console.error("❌ PROFILES E2E ERROR:", error);
  process.exit(1);
});
