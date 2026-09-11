// SubmitPullRequest: push the branch and open the PR (or push to the PR already open for it).
// The only way code leaves the checkout, and the server's credentials never leave the server:
// the push authenticates through `github.gitEnv()` for this one command. Which repository is
// the workspace marker's business: the tool is built once for the server, the marker was
// written when the session's clone was made.
//
// The PR body carries `<!-- operon-session: <id> -->`. That marker is the whole GitHub → session
// mapping: when someone @-mentions the bot on the PR, the bot reads the body and knows which
// session to continue (src/flows.ts). No table, nothing to lose on a restart.

import { defineTool, ToolAccesses, type ExtensionDefinition, type Tool } from "operon-agents";
import { z } from "zod";
import { PR_TOOL } from "./agent-config.ts";
import { git, readMarker } from "./checkout.ts";
import { parseRepo, type GitHubApi } from "./github.ts";

const MARKER = /<!--\s*operon-session:\s*([A-Za-z0-9_-]+)\s*-->/;

export function sessionMarker(sessionId: string): string {
  return `<!-- operon-session: ${sessionId} -->`;
}

/** The session a PR body points at, if the PR was opened by this tool. */
export function sessionOfPullRequest(body: string | null | undefined): string | undefined {
  return body ? MARKER.exec(body)?.[1] : undefined;
}

const Input = z.object({
  title: z.string().min(1).max(200).describe("Pull request title."),
  body: z.string().describe("Pull request description in markdown: what changed and why, how it was tested, the Linear issue URL."),
  branch: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,120}$/, "a git branch name")
    .describe("The branch to push HEAD to and open the PR from, e.g. linear/ENG-123-short-slug."),
});

export function submitPullRequestTool(github: GitHubApi): Tool {
  return defineTool({
    name: PR_TOOL,
    description:
      "Push the current branch (HEAD) to GitHub and open a pull request for it, or push new commits to the pull request already open for the branch. Commit first: the working tree must be clean. Never targets the default branch.",
    params: Input,
    resolve: (args) => ({
      approvalRule: PR_TOOL,
      accesses: ToolAccesses.none(),
      display: { title: "Submit pull request", detail: `${args.branch}: ${args.title}` },
      run: async (ctx) => {
        const cwd = ctx.machine.getcwd();
        const marker = await readMarker(ctx.machine);
        const repo = parseRepo(marker.repo);
        if (args.branch === marker.base) return fail(`refusing to push to the default branch "${marker.base}"; create a feature branch first`);
        const dirty = (await git(ctx.machine, ["status", "--porcelain"], { cwd })).trim();
        if (dirty) return fail(`the working tree has uncommitted changes; commit (or discard) them first:\n${dirty}`);
        const head = (await git(ctx.machine, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).trim();
        if (head !== args.branch) return fail(`HEAD is on "${head}", not "${args.branch}"; check out the branch you want to submit`);
        await git(ctx.machine, ["push", "--quiet", "origin", `HEAD:refs/heads/${args.branch}`], { cwd, env: await github.gitEnv() });

        const existing = await github.findPullRequest(repo, args.branch);
        if (existing) {
          return ok(`Pushed ${args.branch}. Pull request already open: ${existing.url}`);
        }
        const pr = await github.createPullRequest(repo, {
          title: args.title,
          body: `${args.body.trim()}\n\n${sessionMarker(marker.sessionId)}\n`,
          head: args.branch,
          base: marker.base,
        });
        return ok(`Pushed ${args.branch} and opened pull request #${pr.number}: ${pr.url}`);
      },
    }),
  });
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** The tool, as the extension that adds it to the builtin coding profile: the profile names its
 *  tools, so a tool from outside it joins through an extension's `registerTool`. */
export function pullRequestExtension(github: GitHubApi): ExtensionDefinition {
  const tool = submitPullRequestTool(github);
  return {
    id: "linear-github-pull-request",
    session(api) {
      api.registerTool(tool);
    },
  };
}
