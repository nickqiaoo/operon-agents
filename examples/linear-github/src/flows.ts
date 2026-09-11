// The two things that happen: a Linear agent session speaks, or a GitHub PR comment mentions the
// bot. Both end in the same bridge call on the same session. Platform objects stay in src/bot.ts;
// this file takes plain data and a Surface, which is what makes it testable without either API.
//
// Session identity: a Linear agent session IS the managed session -- the managed id is derived
// from Linear's session id, so there is no mapping to store. GitHub finds the session through the
// marker SubmitPullRequest wrote into the PR body. Restart the bot, lose nothing.
//
// Which repository: the session's environment id is `owner/name`, decided once, when the session
// is created, from the issue -- a label in its `repo` label group, else GITHUB_REPO. A delegation
// carries no comment and a later reply carries no context, so the issue is the only place the
// choice can live; the server clones whatever the id names.

import { sessionOfPullRequest } from "../server/pull-request-tool.ts";
import { answersFor } from "./answers.ts";
import { AGENT_ID, client, deliver, ownedSession, resume, truncate, type Surface, type TurnOutcome } from "./bridge.ts";
import { ManagedApiClientError } from "operon-managed-agents/client";

/** The repository sessions default to when the issue names none (`owner/name`, optional). */
export const DEFAULT_REPO = process.env.GITHUB_REPO?.trim() || undefined;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The repository an issue's `repo` label picks, as `owner/name`: the label is either the full
 * `owner/name` or just a name, under the default repository's owner. Undefined when neither
 * the label nor the default says.
 */
export function resolveRepo(repoLabel: string | undefined, fallback: string | undefined): string | undefined {
  const label = repoLabel?.trim();
  if (!label) return fallback && REPO.test(fallback) ? fallback : undefined;
  if (label.includes("/")) return REPO.test(label) ? label : undefined;
  const owner = fallback?.split("/")[0];
  const repo = owner ? `${owner}/${label}` : undefined;
  return repo && REPO.test(repo) ? repo : undefined;
}

export function sessionIdForLinear(agentSessionId: string): string {
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(agentSessionId)) throw new Error(`unexpected Linear agent session id "${agentSessionId}"`);
  return `lin-${agentSessionId}`;
}

export interface LinearSessionEvent {
  /** `created`: the session just started (a mention or a delegation); `prompted`: a reply in it. */
  readonly kind: "created" | "prompted";
  /** How a created session came to be. */
  readonly trigger?: "delegated" | "mentioned";
  readonly agentSessionId: string;
  readonly issue: { readonly id: string; readonly identifier?: string; readonly title?: string; readonly url?: string };
  /** The issue's label in the `repo` label group, if it has one. `created` only. */
  readonly repoLabel?: string;
  /** The person's words: the comment that mentioned the bot, or the reply. */
  readonly text: string;
  /** Linear's brief for the session -- issue, comments, guidance. `created` only. */
  readonly promptContext?: string;
  readonly author: { readonly name: string };
}

export async function onLinearSession(surface: Surface, event: LinearSessionEvent): Promise<TurnOutcome> {
  const sessionId = sessionIdForLinear(event.agentSessionId);
  if (event.kind === "created") {
    // Linear marks a session unresponsive without a sign of life within seconds.
    await surface.ack("Reading the issue…");
    const repo = resolveRepo(event.repoLabel, DEFAULT_REPO);
    if (repo === undefined) {
      await surface.error(
        event.repoLabel
          ? `I can't tell which repository the \`repo\` label "${event.repoLabel}" means: name it as \`owner/name\`, or set GITHUB_REPO on the server for the owner.`
          : "This issue doesn't say which repository to work in. Add a label from the `repo` label group (`owner/name`, or a name under the default owner) and delegate me again.",
      );
      return { status: "refused" };
    }
    await ensureSession(sessionId, event, repo);
    return deliver(surface, sessionId, firstMessage(event, repo));
  }
  await surface.ack("Reading your reply…");
  return continueSession(surface, sessionId, `From ${event.author.name} on Linear:\n\n${event.text}`, event.text);
}

async function ensureSession(sessionId: string, event: LinearSessionEvent, repo: string): Promise<void> {
  const issue = event.issue;
  const title = truncate([issue.identifier, issue.title].filter(Boolean).join(" ") || `Linear issue ${issue.id}`, 80);
  try {
    await client.sessions.create({
      id: sessionId,
      agent: AGENT_ID,
      // The environment is the repository: the server clones it on the first open.
      environment: repo,
      title,
      metadata: { quickstart: "linear-github", linear: { issueId: issue.id, agentSessionId: event.agentSessionId } },
    });
    console.log(`[flows] new session ${sessionId} for ${title} in ${repo}`);
  } catch (err) {
    // A redelivered webhook: the session is already there.
    if (!(err instanceof ManagedApiClientError && err.status === 409)) throw err;
  }
}

function firstMessage(event: LinearSessionEvent, repo: string): string {
  const issue = event.issue;
  const heading = [issue.identifier, issue.title].filter(Boolean).join(": ");
  const how = event.trigger === "delegated" ? "You were **delegated** this Linear issue: implement it." : "You were **mentioned** on this Linear issue: read it and answer; do not change code until asked.";
  const parts = [`${how}${heading ? ` ${heading}` : ""}${issue.url ? `\n${issue.url}` : ""}\nRepository: ${repo} (checked out in your working directory)`];
  if (event.promptContext) parts.push(event.promptContext.trim());
  // The mention's own words, unless Linear's brief is all there is (a delegation has no comment).
  if (event.text.trim() && event.text.trim() !== event.promptContext?.trim()) {
    parts.push(`The comment that brought you in, from ${event.author.name}:\n\n${event.text.trim()}`);
  }
  return parts.join("\n\n---\n\n");
}

export interface GitHubCommentEvent {
  readonly prNumber: number;
  readonly author: { readonly login: string };
  /** The comment, with the bot's own mention removed. */
  readonly text: string;
  /** Review comments: where in the diff it was left. */
  readonly location?: { readonly path: string; readonly line?: number; readonly diffHunk?: string };
}

/** What the GitHub flow asks of GitHub; the bot answers with Octokit, the tests with stubs. */
export interface GitHubLookup {
  pullRequestBody(number: number): Promise<string | null | undefined>;
  /** Whether this login may steer the agent: write access to the repository. */
  canSteer(login: string): Promise<boolean>;
}

export async function onGitHubComment(surface: Surface, event: GitHubCommentEvent, github: GitHubLookup): Promise<TurnOutcome | "ignored"> {
  // Anyone can comment on a public PR; only people who could push to the repo get to drive the
  // agent that pushes to it. Silence, not a reply: answering strangers invites more.
  if (!(await github.canSteer(event.author.login))) {
    console.log(`[flows] ignoring PR #${event.prNumber} comment from @${event.author.login} (no write access)`);
    return "ignored";
  }
  const sessionId = sessionOfPullRequest(await github.pullRequestBody(event.prNumber));
  if (sessionId === undefined) {
    await surface.error("This pull request wasn't opened by me from a Linear issue, so I have no session to continue. Delegate the issue to me in Linear instead.");
    return { status: "gone" };
  }
  const where = event.location ? ` on \`${event.location.path}\`${event.location.line !== undefined ? ` line ${event.location.line}` : ""}` : "";
  const hunk = event.location?.diffHunk ? `\n\n\`\`\`diff\n${lastLines(event.location.diffHunk, 12)}\n\`\`\`` : "";
  const text = `From @${event.author.login} on GitHub pull request #${event.prNumber}${where}:${hunk}\n\n${event.text.trim()}`;
  return continueSession(surface, sessionId, text, event.text);
}

// A message into an existing session: an answer if the session is paused on a question, a
// follow-up otherwise. `reply` is the bare words for the answer; `text` is the attributed
// message the model sees as a prompt.
async function continueSession(surface: Surface, sessionId: string, text: string, reply: string): Promise<TurnOutcome> {
  const session = await ownedSession(sessionId);
  if (!session) {
    await surface.error("This session has ended on the server. Delegate the issue again to start over.");
    return { status: "gone" };
  }
  if (session.state === "interrupted") {
    const { data: pending } = await client.sessions.interruptions(sessionId);
    if (pending.length > 0) return resume(surface, sessionId, answersFor(pending, reply));
  }
  return deliver(surface, sessionId, text);
}

function lastLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}
