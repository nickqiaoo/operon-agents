/**
 * The whole thing, end to end, without a model, Linear, or GitHub: the engineer server runs
 * in-process with a faux model, a local bare repository stands in for GitHub's git side and an
 * in-memory list for its pull requests, and the flows are driven with recording surfaces --
 * exactly what the Chat SDK adapters would call. Four passes:
 *
 *   1. A Linear delegation: the agent branches, commits, then asks a question -- the turn pauses
 *      and the question reaches the thread as an elicitation.
 *   2. The reply in Linear: the paused turn resumes with the answer, submits the pull request
 *      (a real push to the bare repo, a PR with the session marker), and the PR is linked.
 *   3. A GitHub review comment from a collaborator: the PR body's marker finds the session, the
 *      agent pushes a fix, and the reply lands on the review thread with its trace.
 *   4. The gates: a stranger's comment is ignored; a PR without a marker gets a clear answer.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { createModelRuntime, defineModel } from "operon-agents";
import { LANGFUSE_DEFAULT_BASE_URL, langfuseAttributes, langfuseExporter, langfuseFromEnv, otelTracing } from "../server/langfuse.ts";
import type { GitHubApi, PullRequest } from "../server/github.ts";
import { PR_TOOL } from "../server/agent-config.ts";
import { sessionMarker, sessionOfPullRequest } from "../server/pull-request-tool.ts";
import type { Surface, ToolTrace } from "../src/bridge.ts";
import { fakeE2B } from "./fake-e2b.ts";

// `SANDBOX=e2b-fake` runs every session inside a fake E2B sandbox (test/fake-e2b.ts) instead of
// a directory on this host: same checks, plus the sandbox lifecycle ones at the end.
const E2B = process.env.SANDBOX === "e2b-fake";

// A stuck turn must fail the run, not hang it.
setTimeout(() => {
  console.error("watchdog: the test did not finish in time");
  process.exit(3);
}, 180_000).unref();

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, detail?: unknown): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
  if (!ok && detail !== undefined) console.log("   ", typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
}

// ── GitHub, faked: a bare repo and a PR list ────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "linear-github-"));
const origin = join(scratch, "origin.git");
const seed = join(scratch, "seed");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
git(scratch, "clone", "--quiet", origin, seed);
writeFileSync(join(seed, "README.md"), "# demo\n");
git(seed, "-c", "user.name=seed", "-c", "user.email=seed@example.com", "add", "README.md");
git(seed, "-c", "user.name=seed", "-c", "user.email=seed@example.com", "commit", "--quiet", "-m", "init");
git(seed, "push", "--quiet", "origin", "main");

// Every repository the fake is asked for is the one bare repo; which one was asked for is
// recorded, since that is what the marker and the environment id are supposed to carry.
const pulls: PullRequest[] = [];
const reposAsked = { clone: [] as string[], pull: [] as string[] };
const DEMO = { owner: "acme", name: "demo" };
const github: GitHubApi = {
  cloneUrl: (repo) => {
    reposAsked.clone.push(`${repo.owner}/${repo.name}`);
    return origin;
  },
  gitEnv: async () => ({}),
  defaultBranch: async () => "main",
  findPullRequest: async (_repo, branch) => pulls.find((pr) => pr.head === branch),
  createPullRequest: async (repo, { title, body, head }) => {
    reposAsked.pull.push(`${repo.owner}/${repo.name}`);
    const pr = { number: pulls.length + 1, url: `https://github.com/acme/demo/pull/${pulls.length + 1}`, head, body };
    pulls.push(pr);
    void title;
    return pr;
  },
  getPullRequest: async (_repo, number) => pulls.find((pr) => pr.number === number),
  canSteer: async (_repo, login) => login === "maintainer",
};

// ── The engineer server, faux edition ───────────────────────────────────────────────────────
const faux = fauxProvider();
const runtime = createModelRuntime({ builtins: false });
runtime.models.setProvider(faux.provider);
const descriptor = faux.getModel();
if (descriptor === undefined) throw new Error("faux model unavailable");
const model = defineModel({ runtime, descriptor });

const { composeServer } = await import("../server/compose.ts");
const home = join(scratch, "home");
const work = join(scratch, "work");
const e2b = fakeE2B();
const sandboxRoot = join(scratch, "sandboxes");
// Tracing as the server wires it for Langfuse, ending in memory: the same span tree and the same
// attribute stamping, checked at the end (section 7). With Langfuse keys in the environment the
// spans ALSO go to the project -- a faux run, to see the shape in the viewer without a model.
const spans = new InMemorySpanExporter();
const langfuse = langfuseFromEnv();
const tracing = otelTracing([langfuseAttributes(), new SimpleSpanProcessor(spans), ...(langfuse !== undefined ? [langfuseExporter(langfuse)] : [])]);
if (langfuse !== undefined) console.log(`tracing: also exporting to Langfuse at ${langfuse.baseUrl ?? LANGFUSE_DEFAULT_BASE_URL}`);
const { managed } = await composeServer({
  model,
  github,
  home,
  work,
  heartbeatMs: 50,
  tracing,
  ...(E2B ? { sandbox: { sandbox: e2b.factory, workRoot: sandboxRoot } } : {}),
});
console.log(E2B ? "mode: sessions in fake E2B sandboxes" : "mode: sessions in host directories");
// Where a session's clone ends up in each mode.
const cloneDir = (sessionId: string) => (E2B ? join(sandboxRoot, sessionId, "repo") : join(work, sessionId, "repo"));
async function until(condition: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return condition();
}
await managed.listen(0, "127.0.0.1");
const address = managed.server.address();
if (address === null || typeof address === "string") throw new Error("expected a TCP address");

// The bot reads its configuration at import time, so point it at the server first. The default
// repository is what an issue without a repo label gets.
process.env.OPERON_MANAGED_URL = `http://127.0.0.1:${address.port}/v1`;
process.env.GITHUB_REPO = "acme/demo";
const { client } = await import("../src/bridge.ts");
const { onGitHubComment, onLinearSession, resolveRepo, sessionIdForLinear } = await import("../src/flows.ts");
const { answersFor, renderPending } = await import("../src/answers.ts");
const { GitHubSurface } = await import("../src/surfaces.ts");

// A surface that remembers every call, in order.
type Call = { kind: keyof Surface; text: string };
function recorder() {
  const calls: Call[] = [];
  const note = (kind: keyof Surface) => async (arg: string | ToolTrace, url?: string) => {
    const text = typeof arg === "string" ? arg : `${arg.name}[${arg.status}]${arg.hint ? ` ${arg.hint}` : ""}`;
    calls.push({ kind, text: url ? `${text} ${url}` : text });
  };
  const surface: Surface = {
    ack: note("ack"),
    thought: note("thought"),
    action: note("action"),
    respond: note("respond"),
    ask: note("ask"),
    error: note("error"),
    link: note("link"),
  };
  const of = (kind: keyof Surface) => calls.filter((c) => c.kind === kind).map((c) => c.text);
  return { surface, calls, of };
}

const AGENT_SESSION = "0f1e2d3c-4b5a-4968-8776-655443322110";
const ISSUE = { id: "issue-uuid", identifier: "ENG-7", title: "Add a hello file", url: "https://linear.app/acme/issue/ENG-7" };
const BRANCH = "linear/ENG-7-hello";

try {
  // ── 1. Delegated in Linear: branch, commit, then a question ─────────────────────────────
  faux.setResponses([
    fauxAssistantMessage(
      [fauxText("Looking at the issue."), fauxToolCall("Bash", { command: `git checkout -q -b ${BRANCH} && printf 'Hello\\n' > hello.txt && git add hello.txt && git commit -q -m 'add hello'` })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("AskUserQuestion", {
          questions: [{ question: "Should the greeting be lowercase?", header: "Style", options: [{ label: "Yes" }, { label: "No", description: "Keep Hello" }] }],
        }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  const first = recorder();
  const outcome1 = await onLinearSession(first.surface, {
    kind: "created",
    trigger: "delegated",
    agentSessionId: AGENT_SESSION,
    issue: ISSUE,
    text: "",
    promptContext: "# ENG-7 Add a hello file\nCreate hello.txt with a greeting.",
    author: { name: "Ada" },
  });
  const sessionId = sessionIdForLinear(AGENT_SESSION);
  check("created: the session is the Linear session", sessionId === `lin-${AGENT_SESSION}`);
  check("created: ack came first", first.calls[0]?.kind === "ack", first.calls);
  check("created: the session took the issue as its title", (await client.sessions.retrieve(sessionId)).title === "ENG-7 Add a hello file");
  check("created: the environment is the default repository (no repo label)", (await client.sessions.retrieve(sessionId)).environment.id === "acme/demo", await client.sessions.retrieve(sessionId));
  check("created: the clone was of that repository", reposAsked.clone[0] === "acme/demo", reposAsked.clone);
  check("created: text before tools is a thought", first.of("thought")[0] === "Looking at the issue.", first.of("thought"));
  check("created: the shell command ran and finished", first.of("action").some((a) => a.startsWith("Bash[running] git checkout")) && first.of("action").some((a) => a.startsWith("Bash[done]")), first.of("action"));
  check("created: the turn paused on the question", outcome1.status === "waiting", outcome1);
  const asked = first.of("ask")[0] ?? "";
  check("created: the question reached the thread with its options", asked.includes("**Question 1 (Style):** Should the greeting be lowercase?") && asked.includes("- **No** — Keep Hello"), asked);
  check("created: nothing was posted as a final reply", first.of("respond").length === 0 && first.of("error").length === 0, first.calls);
  check("created: the session is interrupted server-side", (await client.sessions.retrieve(sessionId)).state === "interrupted");
  const branchInClone = git(cloneDir(sessionId), "rev-parse", "--abbrev-ref", "HEAD");
  check("created: the commit landed on the feature branch in the session's clone", branchInClone === BRANCH, branchInClone);

  // ── 2. The reply in Linear resumes the paused turn ──────────────────────────────────────
  faux.setResponses([
    fauxAssistantMessage(
      [fauxText("Lowercase it is."), fauxToolCall("Bash", { command: "printf 'hello\\n' > hello.txt && git commit -qam 'lowercase'" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall(PR_TOOL, { title: "Add hello.txt", body: `Adds hello.txt.\n\nRefs ${ISSUE.url}`, branch: BRANCH })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Opened the PR: https://github.com/acme/demo/pull/1")], { stopReason: "stop" }),
  ]);
  const second = recorder();
  const outcome2 = await onLinearSession(second.surface, {
    kind: "prompted",
    agentSessionId: AGENT_SESSION,
    issue: ISSUE,
    text: "yes, lowercase please",
    author: { name: "Ada" },
  });
  check("reply: the turn completed", outcome2.status === "completed", outcome2);
  check("reply: the thought and the final reply are separate", second.of("thought")[0] === "Lowercase it is." && second.of("respond")[0] === "Opened the PR: https://github.com/acme/demo/pull/1", second.calls);
  check("reply: the PR was linked once, from the tool result", second.of("link").length === 1 && second.of("link")[0] === "Pull request https://github.com/acme/demo/pull/1", second.of("link"));
  const prResults = (await client.sessions.events.list(sessionId, { limit: 500 })).data
    .filter((e) => e.type === "message.appended" && e.message.role === "toolResult")
    .map((e) => (e.type === "message.appended" ? JSON.stringify(e.message.content).slice(0, 300) : ""));
  const pushed = (() => {
    try {
      return git(origin, "rev-parse", "--verify", `refs/heads/${BRANCH}`).length === 40;
    } catch {
      return false;
    }
  })();
  check("reply: the branch was pushed to origin", pushed, prResults);
  check("reply: origin has both commits", git(origin, "log", "--oneline", BRANCH).split("\n").length === 3);
  const pr = pulls[0];
  check("reply: the PR carries the session marker and the body", pr !== undefined && sessionOfPullRequest(pr.body) === sessionId && (pr.body ?? "").startsWith("Adds hello.txt."), pr);
  check("reply: the PR was opened on the repository the marker names", reposAsked.pull[0] === "acme/demo", reposAsked.pull);
  // The answer reached the tool: the AskUserQuestion result quotes the reply.
  const events = await client.sessions.events.list(sessionId, { limit: 500 });
  const answered = events.data.some(
    (e) => e.type === "message.appended" && e.message.role === "toolResult" && JSON.stringify(e.message.content).includes("lowercase please"),
  );
  check("reply: the answer reached the paused tool call", answered);
  check("reply: the session is idle again", (await client.sessions.retrieve(sessionId)).state === "idle");

  // ── 3. A review comment on the PR continues the same session ───────────────────────────
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("Bash", { command: "git mv hello.txt hi.txt && git commit -qm 'rename'" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall(PR_TOOL, { title: "Add hello.txt", body: "n/a", branch: BRANCH })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Renamed to hi.txt and pushed.")], { stopReason: "stop" }),
  ]);
  const posted: string[] = [];
  const review = new GitHubSurface({ post: async (markdown) => void posted.push(markdown) });
  const outcome3 = await onGitHubComment(
    review,
    { prNumber: 1, author: { login: "maintainer" }, text: "please call it hi.txt", location: { path: "hello.txt", line: 1, diffHunk: "@@ -0,0 +1 @@\n+hello" } },
    { pullRequestBody: async (n) => (await github.getPullRequest(DEMO, n))?.body, canSteer: (login) => github.canSteer(DEMO, login) },
  );
  check("review: the turn completed", outcome3 === "ignored" ? false : outcome3.status === "completed", outcome3);
  check("review: one comment, with the reply and a collapsed trace", posted.length === 1 && posted[0]!.startsWith("Renamed to hi.txt and pushed.") && posted[0]!.includes("<summary>Trace: 2 tool calls</summary>") && posted[0]!.includes(`✓ ${PR_TOOL}`), posted);
  check("review: the fix was pushed to the same branch", git(origin, "log", "--oneline", BRANCH).split("\n").length === 4);
  check("review: no second PR was opened", pulls.length === 1);
  // The model saw where the comment was left.
  const prompted = (await client.sessions.events.list(sessionId, { limit: 500 })).data.some(
    (e) => e.type === "message.appended" && e.message.role === "user" && JSON.stringify(e.message.content).includes("on `hello.txt` line 1"),
  );
  check("review: the prompt names the file and line", prompted);

  // ── 4. The gates ───────────────────────────────────────────────────────────────────────
  const strangerPosts: string[] = [];
  const stranger = await onGitHubComment(
    new GitHubSurface({ post: async (m) => void strangerPosts.push(m) }),
    { prNumber: 1, author: { login: "drive-by" }, text: "delete everything" },
    { pullRequestBody: async (n) => (await github.getPullRequest(DEMO, n))?.body, canSteer: (login) => github.canSteer(DEMO, login) },
  );
  check("gate: a commenter without write access is ignored, silently", stranger === "ignored" && strangerPosts.length === 0);
  const unmarkedPosts: string[] = [];
  const unmarked = await onGitHubComment(
    new GitHubSurface({ post: async (m) => void unmarkedPosts.push(m) }),
    { prNumber: 99, author: { login: "maintainer" }, text: "hello?" },
    { pullRequestBody: async () => "A PR opened by hand.", canSteer: (login) => github.canSteer(DEMO, login) },
  );
  check("gate: a PR without a session marker gets told so", unmarked !== "ignored" && unmarked.status === "gone" && unmarkedPosts[0]?.includes("no session") === true, unmarkedPosts);

  // ── 4b. Which repository: the issue's repo label picks the environment ─────────────────
  check("repo: no label means the default", resolveRepo(undefined, "acme/demo") === "acme/demo");
  check("repo: a bare label is a repository under the default owner", resolveRepo("web", "acme/demo") === "acme/web");
  check("repo: an owner/name label stands alone", resolveRepo("other/web", "acme/demo") === "other/web" && resolveRepo("other/web", undefined) === "other/web");
  check("repo: nothing to go on is undefined, not a guess", resolveRepo(undefined, undefined) === undefined && resolveRepo("web", undefined) === undefined && resolveRepo("not a repo", "acme/demo") === undefined);
  faux.setResponses([fauxAssistantMessage([fauxText("Hi from the other repo.")], { stopReason: "stop" })]);
  const OTHER_SESSION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const other = recorder();
  const outcomeOther = await onLinearSession(other.surface, {
    kind: "created",
    trigger: "mentioned",
    agentSessionId: OTHER_SESSION,
    issue: { id: "issue-2", identifier: "ENG-8", title: "Say hi", url: "https://linear.app/acme/issue/ENG-8" },
    repoLabel: "web",
    text: "@operon say hi",
    promptContext: "# ENG-8 Say hi",
    author: { name: "Ada" },
  });
  check("repo: a labelled issue's session lives in that repository", outcomeOther.status === "completed" && (await client.sessions.retrieve(sessionIdForLinear(OTHER_SESSION))).environment.id === "acme/web", outcomeOther);
  check("repo: and cloned it", reposAsked.clone.at(-1) === "acme/web", reposAsked.clone);
  const firstPrompt = (await client.sessions.events.list(sessionIdForLinear(OTHER_SESSION), { limit: 50 })).data.find((e) => e.type === "message.appended" && e.message.role === "user");
  check("repo: the model is told which repository it is in", JSON.stringify(firstPrompt).includes("Repository: acme/web"), firstPrompt);
  const unresolved = recorder();
  const outcomeUnresolved = await onLinearSession(unresolved.surface, {
    kind: "created",
    trigger: "delegated",
    agentSessionId: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
    issue: { id: "issue-3", identifier: "ENG-9", title: "Nowhere" },
    repoLabel: "not a repo",
    text: "",
    author: { name: "Ada" },
  });
  check("repo: a label that names no repository is refused with an explanation, and no session", outcomeUnresolved.status === "refused" && unresolved.of("error")[0]?.includes('"not a repo"') === true && (await client.sessions.retrieve(sessionIdForLinear("9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a")).catch(() => null)) === null, unresolved.calls);

  // ── 5. Answers, in isolation ───────────────────────────────────────────────────────────
  const approval = { kind: "approval", approvalId: "a1", frameId: "f", address: "main", agent: { key: "k", name: "n" }, toolCallId: "c1", toolName: "Bash", approvalRule: "Bash", display: { detail: "rm -rf build" } } as const;
  check("answers: an approval renders the command", renderPending([approval]).includes("**Approval needed:** `Bash` — rm -rf build"));
  check("answers: 'approve' approves", answersFor([approval], "approve")["a1"]?.kind === "approval" && (answersFor([approval], "approve")["a1"] as { decision: string }).decision === "approved");
  const rejected = answersFor([approval], "no, that wipes the cache")["a1"] as { decision: string; feedback?: string };
  check("answers: 'no' rejects with the rest as feedback", rejected.decision === "rejected" && rejected.feedback === "that wipes the cache", rejected);
  const unclear = answersFor([approval], "hmm, what does that do?")["a1"] as { decision: string; feedback?: string };
  check("answers: an unclear reply is a rejection carrying the words", unclear.decision === "rejected" && unclear.feedback === "hmm, what does that do?", unclear);
  check("marker: round-trips", sessionOfPullRequest(`body\n\n${sessionMarker("lin-abc")}\n`) === "lin-abc");

  // ── 6. The sandbox lifecycle (E2B mode only) ───────────────────────────────────────────
  if (E2B) {
    const state = JSON.parse(readFileSync(join(work, sessionId, "sandbox.json"), "utf8")) as { sandboxId?: string };
    const sandbox = state.sandboxId ? e2b.sandboxes.get(state.sandboxId) : undefined;
    check("e2b: the session's sandbox id is on disk next to the session", sandbox !== undefined, state);
    check("e2b: one sandbox per session", e2b.sandboxes.size === 2, [...e2b.sandboxes.keys()]);
    check("e2b: later turns reconnected instead of creating", (sandbox?.connects ?? 0) >= 2, sandbox?.connects);
    check("e2b: the clone lives inside the sandbox", sandbox?.commandLog.some((c) => c.includes("git clone")) === true);
    check("e2b: the sandbox is paused once the session closes", await until(() => sandbox?.paused === true), sandbox?.paused);
    check("e2b: the push went through the sandbox, not the host", sandbox?.commandLog.some((c) => c.includes("git push")) === true);
  }

  // ── 7. Tracing: what Langfuse would receive for the issue's session ────────────────────
  // Read before the server closes: shutting the provider down empties the in-memory exporter.
  await tracing.forceFlush();
  const attr = (span: ReadableSpan, key: string): unknown => span.attributes[key];
  const traced = spans.getFinishedSpans().filter((s) => attr(s, "gen_ai.conversation.id") === sessionId);
  check("tracing: the session's spans carry it as the Langfuse session", traced.length > 0 && traced.every((s) => attr(s, "langfuse.session.id") === sessionId), traced.length);
  const observationTypes = new Set(traced.map((s) => attr(s, "langfuse.observation.type")));
  check("tracing: agents, turns, generations and tools are typed for Langfuse", ["agent", "chain", "generation", "tool"].every((t) => observationTypes.has(t)), [...observationTypes]);
  const generation = traced.find((s) => attr(s, "langfuse.observation.type") === "generation");
  check(
    "tracing: a generation names its model and carries the messages it answered and produced",
    generation !== undefined && typeof attr(generation, "gen_ai.request.model") === "string" && typeof attr(generation, "gen_ai.input.messages") === "string" && typeof attr(generation, "gen_ai.output.messages") === "string",
    generation?.attributes,
  );
  const messages = traced.filter((s) => attr(s, "langfuse.observation.type") === "event");
  check("tracing: a message entering the transcript is the event's input", messages.length > 0 && messages.every((s) => typeof attr(s, "langfuse.observation.input") === "string" && (attr(s, "langfuse.observation.input") as string).length > 0), messages.map((s) => s.attributes));
  const bash = traced.find((s) => attr(s, "gen_ai.tool.name") === "Bash");
  check("tracing: a tool span carries its arguments and result", bash !== undefined && typeof attr(bash, "gen_ai.tool.call.arguments") === "string" && typeof attr(bash, "gen_ai.tool.call.result") === "string", bash?.attributes);
  const pausedTurn = traced.find((s) => attr(s, "operon_agents.turn.reason") === "paused");
  const question = traced.find((s) => attr(s, "gen_ai.tool.name") === "AskUserQuestion");
  check(
    "tracing: the run that paused on the question was exported, its turn ended as paused and the question not as a failure",
    pausedTurn !== undefined && question !== undefined && question.events.some((e) => e.name === "paused") && question.status.code !== SpanStatusCode.ERROR,
    traced.map((s) => s.name),
  );
  check("tracing: the session's three runs (delegation, reply, review) are three traces", new Set(traced.map((s) => s.spanContext().traceId)).size === 3, traced.map((s) => `${s.spanContext().traceId.slice(0, 6)} ${s.name}`));
} finally {
  await managed.close();
  runtime.models.deleteProvider(faux.provider.id);
  rmSync(scratch, { recursive: true, force: true });
}

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
console.log("✅ LINEAR × GITHUB BRIDGE E2E PASS");
process.exit(0);
