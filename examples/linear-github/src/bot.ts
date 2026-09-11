// Chat SDK wiring: two adapters, one bot. Linear in agent-sessions mode (an OAuth app installed
// as an actor, so it can be @-mentioned and delegated issues); GitHub as a GitHub App that hears
// @-mentions in PR comments. Both webhooks land in src/app.ts; this file turns their messages
// into the plain events src/flows.ts handles.
//
// Trust: a Linear workspace member speaking in the agent's own session is the session's user.
// A GitHub commenter is anyone on the internet -- the flow checks write access before listening.

import { Chat } from "chat";
import { createGitHubAdapter, type GitHubRawMessage } from "@chat-adapter/github";
import { createLinearAdapter, type LinearRawMessage } from "@chat-adapter/linear";
import { createMemoryState } from "@chat-adapter/state-memory";
import { onGitHubComment, onLinearSession, type GitHubLookup } from "./flows.ts";
import { GitHubSurface, LinearSurface } from "./surfaces.ts";

export const BOT_NAME = process.env.BOT_NAME ?? "operon";

const adapters = {
  linear: createLinearAdapter({ mode: "agent-sessions" }),
  github: createGitHubAdapter(),
};

export const bot = new Chat<typeof adapters>({
  userName: BOT_NAME,
  adapters,
  // The Chat SDK needs a state adapter for locks and dedup; the managed session is the state,
  // so memory is fine. Thread subscriptions live here too -- see route() for why that's OK.
  state: createMemoryState(),
  // The SDK's per-thread lock (30s TTL) is far shorter than an implementation turn; the bridge
  // serializes per session instead.
  concurrency: "concurrent",
});

// A Linear session's replies arrive as subscribed-thread messages once we subscribe; before
// that (or after a restart that emptied the memory state) they arrive as mentions, since every
// message in an agent session targets the agent. Both handlers therefore route the same way.
bot.onNewMention(route);
bot.onSubscribedMessage(route);

type Thread = Parameters<Parameters<typeof bot.onNewMention>[0]>[0];
type Message = Parameters<Parameters<typeof bot.onNewMention>[0]>[1];

async function route(thread: Thread, message: Message): Promise<void> {
  if (message.author.isMe || message.author.isBot === true) return;
  if (thread.id.startsWith("linear:")) return linearMessage(thread, message);
  if (thread.id.startsWith("github:") && message.isMention) return githubMessage(thread, message);
}

async function linearMessage(thread: Thread, message: Message): Promise<void> {
  const raw = message.raw as LinearRawMessage;
  if (raw.kind !== "agent_session_comment") return;
  await thread.subscribe();
  const { agentSessionId, issueId } = adapters.linear.decodeThreadId(thread.id);
  if (!agentSessionId) return;
  const linear = adapters.linear.linearClient;
  const surface = new LinearSurface(thread, linear, agentSessionId);
  // Linear's brief travels only with the session-created event; a delegation has no comment,
  // and the adapter synthesizes one whose id says so.
  const created = raw.agentSessionPromptContext !== undefined;
  const delegated = raw.comment.id.startsWith("agent-session-");
  const { issue, repoLabel } = await describeIssue(linear, issueId);
  // Await the whole turn: the adapter has already answered the webhook, and this handler is the
  // only thing holding the session's event stream.
  await onLinearSession(surface, {
    kind: created ? "created" : "prompted",
    ...(created ? { trigger: delegated ? "delegated" : "mentioned" } : {}),
    agentSessionId,
    issue,
    ...(created && repoLabel !== undefined ? { repoLabel } : {}),
    text: message.text ?? "",
    ...(created && raw.agentSessionPromptContext ? { promptContext: raw.agentSessionPromptContext } : {}),
    author: { name: message.author.fullName || message.author.userName },
  });
}

/** The label group whose member names the issue's repository (src/flows.ts `resolveRepo`). */
const REPO_LABEL_GROUP = process.env.LINEAR_REPO_LABEL_GROUP ?? "repo";

interface IssueDescription {
  readonly issue: { readonly id: string; readonly identifier?: string; readonly title?: string; readonly url?: string };
  readonly repoLabel?: string;
}

// One query for what the session needs of the issue: its name for the title, and its label in
// the repo group. The SDK's object graph would fetch each label's parent separately.
async function describeIssue(linear: typeof adapters.linear.linearClient, issueId: string): Promise<IssueDescription> {
  try {
    const { data } = await linear.client.rawRequest<
      { issue: { identifier: string; title: string; url: string; labels: { nodes: Array<{ name: string; parent: { name: string } | null }> } } },
      { id: string }
    >(
      `query IssueForSession($id: String!) {
        issue(id: $id) { identifier title url labels { nodes { name parent { name } } } }
      }`,
      { id: issueId },
    );
    if (!data) return { issue: { id: issueId } };
    const { identifier, title, url, labels } = data.issue;
    const inGroup = labels.nodes.filter((l) => l.parent?.name.toLowerCase() === REPO_LABEL_GROUP.toLowerCase());
    if (inGroup.length > 1) console.warn(`[bot] issue ${identifier} has ${inGroup.length} "${REPO_LABEL_GROUP}" labels; using "${inGroup[0]!.name}"`);
    return { issue: { id: issueId, identifier, title, url }, ...(inGroup[0] ? { repoLabel: inGroup[0].name } : {}) };
  } catch (err) {
    console.warn(`[bot] could not read issue ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return { issue: { id: issueId } };
  }
}

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

async function githubMessage(thread: Thread, message: Message): Promise<void> {
  const raw = message.raw as GitHubRawMessage;
  const { owner, repo, prNumber, type } = adapters.github.decodeThreadId(thread.id);
  if (type === "issue") {
    await thread.post("I work from Linear issues: delegate one to me there, and mention me on the pull request I open.");
    return;
  }
  const octokit = adapters.github.octokit;
  const github: GitHubLookup = {
    pullRequestBody: async (number) => (await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data.body,
    canSteer: async (login) => {
      try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login });
        return WRITE_PERMISSIONS.has(data.permission);
      } catch (err) {
        if ((err as { status?: number }).status === 404) return false;
        throw err;
      }
    },
  };
  const comment = raw.comment as { path?: string; line?: number | null; diff_hunk?: string };
  const location =
    raw.type === "review_comment" && comment.path
      ? { path: comment.path, ...(typeof comment.line === "number" ? { line: comment.line } : {}), ...(comment.diff_hunk ? { diffHunk: comment.diff_hunk } : {}) }
      : undefined;
  await onGitHubComment(
    new GitHubSurface(thread),
    {
      prNumber,
      author: { login: message.author.userName },
      text: stripMention(message.text ?? "", adapters.github.userName),
      ...(location ? { location } : {}),
    },
    github,
  );
}

function stripMention(text: string, userName: string): string {
  const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`@${escaped}\\b`, "gi"), "").trim();
}

export { adapters };
