/**
 * The Workflow tool description. This text IS the prompt — it teaches the model
 * when to reach for a workflow and how to author good scripts, in terms of this
 * framework's hook names and subagent model.
 * Keep it in sync with runtime.ts behaviour.
 */
export function workflowPrompt(availableAgents: readonly string[]): string {
  const agentList =
    availableAgents.length > 0 ? availableAgents.join(", ") : "(none configured)";
  return `Execute a workflow script that orchestrates multiple subagents deterministically. By default it runs to completion and returns the final value; pass run_in_background:true (recommended for long workflows) to get a task_id immediately and poll progress/result with BackgroundOutput. Live progress is reported either way. Pass tokenBudget to cap the run and enable budget.remaining()-guarded loops.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly asked for multi-agent orchestration (e.g. "run a workflow", "fan out agents", "orchestrate this with subagents"), or invoked a skill/command whose instructions tell you to. For any other task — even one that would clearly benefit from parallelism — do NOT call this tool; use a single subagent, or briefly describe what a workflow could do and ask the user whether to run it.

The right move is often hybrid: scout inline first (list the files, find the targets, scope the diff) to discover the work-list, then call this tool to pipeline over it. You don't need to know the shape before the task — only before the orchestration step.

## Authoring scripts

Pass the script inline via \`script\`; it runs immediately AND is persisted to \`.agents/runs/<name>.js\` — the tool returns that path in \`scriptPath\`, so to iterate you edit that file with Write/Edit and re-invoke with the same \`scriptPath\` instead of re-sending the whole script. Run a curated workflow from \`.agents/workflows/\` by \`name\`. Precedence: \`scriptPath\` > \`script\` > \`name\`.

Every script must begin with \`export const meta = {...}\`:
  export const meta = {
    name: 'find-flaky-tests',
    description: 'Find flaky tests and propose fixes',
    phases: [
      { title: 'Scan', detail: 'grep test logs for retries' },
      { title: 'Fix', detail: 'one agent per flaky test' },
    ],
  }
  // script body starts here
  phase('Scan')
  const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
  ...

The \`meta\` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required: \`name\`, \`description\`. Optional: \`title\`, \`whenToUse\`, \`phases\`. Use the SAME phase titles in meta.phases as in your phase() calls — titles are matched exactly.

Script body hooks:
- agent(prompt, opts?): Promise<any> — spawn one subagent and run it to completion. Without a schema, returns its final text as a string. With opts.schema (a JSON Schema), the subagent is forced to call a StructuredOutput tool whose argument matches the schema; agent() validates it and resolves the parsed object (nudging + retrying on mismatch). opts: { label?, phase?, schema?, model?, agentType? }. opts.label overrides the display label. opts.phase assigns this agent to a progress group — use it inside pipeline()/parallel() stages instead of relying on global phase() state. opts.model overrides the model for this one agent; omit it to inherit the default. opts.agentType selects which subagent type runs the agent. Available types: ${agentList}. Omit it to use the default. opts.isolation:'worktree' runs the agent in an isolated git worktree (a separate working copy, auto-removed if it makes no changes) — use it ONLY when agents mutate files in parallel and would otherwise conflict; it degrades to the shared workspace (with a logged note) when the machine can't provide one.
- parallel(thunks): Promise<any[]> — run () => agent(...) thunks concurrently. This is a BARRIER: it awaits all thunks. A thunk that throws resolves to null in the result array (the call never rejects), so .filter(Boolean) before using results. At most 4096 thunks per call.
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, with NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Each stage callback receives (prevResult, originalItem, index). A stage that throws drops that item to null and skips its remaining stages. At most 4096 items per call.
- phase(title): void — start a new phase; subsequent agent() calls are grouped under it.
- log(message): void — emit a progress line to the user.
- workflow(nameOrRef, args?): Promise<any> — run a saved workflow (by name) inline as a sub-step and return its result. Nesting is one level only.
- args: any — the value passed as this tool's \`args\` input, verbatim. Pass arrays/objects as real JSON values, not a JSON-encoded string.
- budget: { total, spent(), remaining() } — token target for the turn. budget.total is the tokenBudget you passed (or null); remaining() returns Infinity when null. spent() is output tokens spent so far this turn (main loop + this workflow). Once spent() reaches total, no further agent() calls are dispatched; agents already in flight finish, so the cap is approximate (overshoot is bounded by concurrency). Guard budget loops on budget.total so they terminate when no target is set.

Subagents are told their final text IS the return value, so they return raw data, not human-facing prose. For structured output, use the schema option — the StructuredOutput tool is injected and validated with retries.

Scripts are plain JavaScript, NOT TypeScript — type annotations (\`: string[]\`), interfaces, and generics fail to parse. The body runs in an async (strict-mode) context — use await directly; \`with\` and dynamic \`import()\` are rejected. Standard JS built-ins are available EXCEPT Date.now()/Math.random()/new Date(), which throw (they would break resume); stamp times after the workflow returns or pass them via args. No filesystem or Node API access.

## DEFAULT TO pipeline()

Only reach for a barrier (parallel between stages) when stage N genuinely needs cross-item context from ALL of stage N-1: dedup/merge across the full result set before expensive downstream work; early-exit if the total count is zero; stage N's prompt references "the other findings". A barrier is NOT justified by "I need to flatten/map/filter first" (do it inside a pipeline stage). Barrier latency is real: if the slowest item takes 3× the fastest, a barrier wastes the fast items' idle time.

Concurrent agent() calls are capped (~CPU cores); excess calls queue and run as slots free. Total agent count per workflow is capped at 1000 as a runaway backstop.

## Patterns

Canonical multi-stage — pipeline by default, each dimension verifies as soon as its review completes:
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)

Loop-until-budget — guard on budget.total, else remaining() is Infinity and it runs to the agent cap:
  const bugs = []
  while (budget.total && budget.remaining() > 50_000) {
    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
    bugs.push(...result.bugs)
  }

Quality patterns — compose freely: adversarial verify (N skeptics per finding, kill on majority-refute); perspective-diverse verify (each verifier a distinct lens); judge panel (N attempts, scored, synthesize the winner); loop-until-dry (keep finding until K empty rounds); multi-modal sweep (each agent searches a different way); completeness critic (a final agent asking "what's missing?"). Scale to what the user asked for.

## Resume

resumeFromRunId resumes a prior run. agent() calls are keyed by a chain over (previous key + prompt + opts), so resume replays the LONGEST UNCHANGED PREFIX: completed calls up to the first changed/new/interrupted one return cached results instantly, and everything from there on re-runs. Same script + same args → 100% cache hit. An agent that was interrupted mid-run (a "started" marker with no result) is detected and respawned. (This is why Date.now()/Math.random() are unavailable — they would change the cache keys.) Each run also writes a snapshot record (script, args, status, result, logs) so past runs can be listed and a runId chosen to resume.`;
}
