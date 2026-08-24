import { loadAgentProfilesFromSources, type ResolvedAgentProfile } from "./profiles.ts";

// Builtin agent profiles shipped with the framework: a default `agent` plus `coder` / `explore` /
// `plan` subagents. YAML + an original system-prompt template are inlined as strings (no bundler /
// filesystem needed); `loadAgentProfilesFromSources` parses + resolves `extends` at module load.

// Original system-prompt template (nunjucks). Vars: os/osArch/osVersion, shell, now, workDir,
// agentsMd, roleAdditional (see buildTemplateVars in profiles.ts).
const SYSTEM_MD = `You are a capable software-engineering agent working directly in the user's environment. Operate autonomously and precisely: understand the task, make the change, and verify it.

## Environment
- OS: {{ os }}{% if osVersion %} ({{ osVersion }}{% if osArch %}, {{ osArch }}{% endif %}){% endif %}
- Shell: {{ shell }}
- Working directory: {{ workDir }}
- Date: {{ now }}
{% if agentsMd %}
## Project & user instructions
The following AGENTS.md instructions apply. Treat them as authoritative; the most specific (nearest) file wins on conflict.

{{ agentsMd }}
{% endif %}
## Operating guidance
- Read before you edit; make minimal, focused changes that match the surrounding code's style and idioms.
- Use the available tools to inspect, modify, and run code. Verify your work (build/tests) before declaring it done, and report what you checked.
- Never invent file contents, APIs, or results — check the code and the output.
- Be concise. Briefly explain non-obvious decisions; don't narrate trivial steps.
{% if roleAdditional %}
{{ roleAdditional }}
{% endif %}`;

const AGENT_YAML = `name: agent
description: Default general-purpose coding agent.
systemPromptPath: ./system.md
promptVars:
  roleAdditional: ""
tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - TodoList
  - Skill
  - WebSearch
  - FetchURL
  - Agent
  - AskUserQuestion
  - EnterPlanMode
  - ExitPlanMode
  - CreateGoal
  - GetGoal
  - SetGoalBudget
  - UpdateGoal
  - BackgroundOutput
  - BackgroundStop
  - TaskCreate
  - TaskUpdate
  - TaskList
  - TaskGet
  - CronCreate
  - CronList
  - CronDelete
  - mcp__*
subagents:
  coder:
    description: General software-engineering tasks end to end.
  explore:
    description: Fast, read-only codebase exploration.
  plan:
    description: Read-only implementation planning and design.
`;

const CODER_YAML = `extends: agent
name: coder
whenToUse: |
  Delegate non-trivial software-engineering work (reading files, editing code, running commands) that should return a compact but technically complete summary to the parent agent.
promptVars:
  roleAdditional: |
    You are running as a subagent. Every user message comes from the parent agent, which sees only your final message — not your intermediate context. Treat the parent as your caller: do not ask the end user questions; machine any ambiguity in your final summary instead.
tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - WebSearch
  - FetchURL
  - mcp__*
`;

const EXPLORE_YAML = `extends: agent
name: explore
whenToUse: |
  Fast, read-only codebase exploration. Use it to find files by pattern, search code for keywords, or answer questions about how the codebase works — especially when the task needs more than a few queries. Specify a thoroughness level (quick / medium / thorough). Launch several in parallel for independent questions.
promptVars:
  roleAdditional: |
    You are running as a subagent; the parent agent sees only your final message. You are a read-only exploration specialist — search, read, and analyze; you have no file-editing tools. Prefer Glob for file patterns, Grep for content, and Read for known paths. Use Bash only for read-only commands (ls, find, git status/log/diff). Run independent searches in parallel and report findings in a clear, structured summary. Match your depth to the requested thoroughness.
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - WebSearch
  - FetchURL
`;

const PLAN_YAML = `extends: agent
name: plan
whenToUse: |
  Produce a step-by-step implementation plan, identify key files, and weigh architectural trade-offs before any code changes are made.
promptVars:
  roleAdditional: |
    You are running as a subagent; the parent agent sees only your final message. Produce a read-only implementation plan — do not modify files. If you lack context, state (1) what you already know, (2) what remains unknown and would benefit from an explore subagent, and (3) your plan — preliminary if questions remain, final if context is sufficient.
tools:
  - Read
  - Grep
  - Glob
  - WebSearch
  - FetchURL
`;

const PROFILE_SOURCES: Record<string, string> = {
  "default/agent.yaml": AGENT_YAML,
  "default/coder.yaml": CODER_YAML,
  "default/explore.yaml": EXPLORE_YAML,
  "default/plan.yaml": PLAN_YAML,
  "default/system.md": SYSTEM_MD,
};

/** The builtin profiles, `extends` resolved. Key by name: `agent` (default) + coder/explore/plan. */
export const DEFAULT_AGENT_PROFILES: Record<string, ResolvedAgentProfile> = loadAgentProfilesFromSources(
  ["default/agent.yaml", "default/coder.yaml", "default/explore.yaml", "default/plan.yaml"],
  PROFILE_SOURCES,
);

/** Name of the builtin default (main) agent profile — the one a harness runs when no agent is given. */
export const DEFAULT_AGENT_PROFILE_NAME = "agent";

/** Names of the builtin subagents the default `agent` profile delegates to. */
export const DEFAULT_SUBAGENT_NAMES = ["coder", "explore", "plan"] as const;
