# Linear × GitHub × operon managed agents

An engineer you delegate Linear issues to. It clones the repository, asks in the issue thread
when the spec is unclear, implements, opens a pull request, and keeps working from review comments
on the PR -- one continuous session per issue, visible from both sides.

```
Linear issue ──delegate / @mention──▶ agent session ──▶ managed session ──▶ clone of the issue's repo
     ▲                                     │                 │                    │
     │  thought / action / response /      │                 │   SubmitPullRequest│
     │  elicitation / error activities ◀───┘                 │                    ▼
     │                                                       │           branch + pull request
     └──────────── "Pull request" external link ◀────────────┘                    │
                                                                                  ▼
GitHub PR comment ──@mention──▶ same managed session (found by the marker in the PR body)
     ▲                                          │
     └──── one reply per turn, with a trace ◀───┘
```

Two processes, like [`../chat-sdk`](../chat-sdk): the **engineer server** is an
`operon-managed-agents` API whose environment is a git clone -- in an **E2B sandbox** per
session when `E2B_API_KEY` is set, in a directory on the host otherwise; the **bot** is a
[Chat SDK](https://chat-sdk.dev) app with the official Linear and GitHub adapters, bridged to
that API.

- **A Linear agent session is the managed session.** The managed id is derived from Linear's
  session id; the session's event log is the transcript; the bot stores nothing.
- **The issue names the repository.** A session's environment id is `owner/name`, read once at
  creation from the issue's label in the `repo` label group (`GITHUB_REPO` when it has none);
  the server clones whatever the id names. One server, every repository its GitHub App reaches.
- **Questions pause, replies resume.** `AskUserQuestion` (and any tool the permission floor
  wants approved) suspends the session durably; the bot posts it as a Linear *elicitation*, and
  the next reply in the thread -- hours or days later, after a bot restart -- answers it.
- **The PR knows its session.** `SubmitPullRequest` pushes the branch from the server (the
  checkout never holds credentials) and writes `<!-- operon-session: … -->` into the PR body.
  An `@mention` on the PR reads it back and continues the same session; review comments arrive
  with their file and line.
- **Trust follows the platform.** A Linear workspace member in the agent's own session is the
  session's user. A GitHub commenter must have write access to the repository; anyone else is
  ignored without a reply.

## Run

```bash
pnpm install && pnpm build            # once, at the repo root
cd examples/linear-github
cp .env.example .env                  # fill in the model key, the repo, GitHub and Linear credentials

pnpm server                           # terminal 1: engineer API on :8088
pnpm dev                              # terminal 2: bot on :3000 (webhooks)
```

`pnpm test` runs the whole thing against a faux model in-process -- a delegation that branches,
commits and asks; the reply that resumes it and opens the PR (a real push, to a local bare
repository); a review comment that continues the session; the access gates -- and needs no keys.
It runs twice: sessions in host directories, then sessions in a fake E2B sandbox
(`test/fake-e2b.ts`, the SDK's shape over local processes) that also checks the sandbox is
reconnected across turns and paused when the session closes.

On a server, [`deploy/`](deploy/) is the same two processes as containers behind the host's
reverse proxy: `docker compose --env-file ../.env up -d --build`. See
[`deploy/README.md`](deploy/README.md).

### Sandboxes (E2B)

Set `E2B_API_KEY` and each session gets its own E2B sandbox: the clone, the agent's shell and
every edit happen there, never on the server's filesystem. `E2B_TEMPLATE` picks the image (the
default has git); `E2B_TIMEOUT_MS` is the inactivity timeout while a session holds the sandbox
open (default 15 minutes).

The lifecycle is the host's (this server's), as `operon-sandbox` intends:

- **open** -- the session's sandbox id is in `workspace/<session>/sandbox.json`; the server
  reconnects to it (a paused sandbox resumes on `connect`) or, if it is gone, starts a new one
  and clones again (work since the last push is lost; the log says so).
- **close** -- the worker closes a session after every turn; the session's `sandbox-lease` capability pauses
  the sandbox, so a session waiting days for a reply costs storage, not compute. Fresh sandboxes
  are created with `lifecycle.onTimeout: "pause"` as the backstop. A plan without pause support
  leaves the sandbox running until its timeout.
- **credentials** -- the same as on the host: git authenticates through the command's
  environment for the one push, so nothing lands in the sandbox's filesystem or shell history.

`server/sandbox.ts` is the whole of it; `server/checkout.ts` is environment-agnostic and prepares
the clone through whichever `Environment` it is handed.

### Tracing (Langfuse)

Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (and `LANGFUSE_BASE_URL` for the US cloud or
a self-hosted instance) and the engineer server traces every session to
[Langfuse](https://langfuse.com): one trace per run -- the delegation, each reply, each review
comment -- with the model calls, tool calls and sub-steps as observations under it, and the
Linear session as the Langfuse session, so an issue's whole conversation lists together.

The spans are the framework's own (`operon-agents/tracing`, OpenTelemetry with the GenAI
semantic conventions); `server/langfuse.ts` adds the transport and stamps each span's Langfuse
observation type and session id. By default they carry the conversation -- system prompt, the
messages each call answered, its output, tool arguments and results -- with tokens, keys and
email addresses masked before export; `LANGFUSE_TRACE_CONTENT=none` keeps names, timings and
usage only. A run that pauses on a question ends its trace at the pause, and the reply that
resumes it starts the next one. With the keys in `.env`, `pnpm test` also sends its faux run
there -- the shape of a session in the viewer, without a model.

### GitHub setup

One GitHub App does both jobs: it is the identity that clones, pushes and opens PRs (server), and
the webhook receiver that hears mentions (bot).

1. [New GitHub App](https://github.com/settings/apps/new): webhook URL
   `https://<public-host>/api/webhooks/github`, a webhook secret, content type `application/json`.
2. Repository permissions: **Contents** read & write, **Pull requests** read & write,
   **Issues** read & write, **Metadata** read. Subscribe to **Issue comment** and
   **Pull request review comment**.
3. Generate a private key; install the App on the repository; note the installation id from
   the URL. Set `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`,
   `GITHUB_WEBHOOK_SECRET`, and `GITHUB_BOT_USERNAME` (`<app-slug>[bot]`). Install it on every
   repository the engineer may work in.

A personal access token (`GITHUB_TOKEN`, `repo` scope) works for a quick start; the PRs are then
yours rather than the App's.

### Linear setup

1. [Create an OAuth application](https://linear.app/settings/api/applications/new). Enable
   **Agent session events** under webhooks, set the webhook URL to
   `https://<public-host>/api/webhooks/linear`, and copy the signing secret to
   `LINEAR_WEBHOOK_SECRET`.
2. Have a workspace admin install it as an agent -- `actor=app` with the `app:mentionable` and
   `app:assignable` scopes:
   ```
   https://linear.app/oauth/authorize?client_id=…&redirect_uri=…&response_type=code
     &scope=read,write,comments:create,issues:create,app:mentionable,app:assignable&actor=app
   ```
   For a single workspace, client credentials (`LINEAR_CLIENT_CREDENTIALS_CLIENT_ID` / `_SECRET`)
   are the simplest way to hold the token. Multi-tenant installs land on
   `/api/linear/install/callback` when `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` /
   `LINEAR_REDIRECT_URI` are set; see [`@chat-adapter/linear`](https://www.npmjs.com/package/@chat-adapter/linear).
3. Set `LINEAR_BOT_USERNAME` to the app's name.
4. Create a label group named `repo` (Settings → Labels) with one label per repository, named
   `owner/name` -- or just `name`, for repositories under `GITHUB_REPO`'s owner. An issue's
   label picks where its session works; an issue without one works in `GITHUB_REPO`, and if that
   is unset too the bot says so in the thread instead of guessing. `LINEAR_REPO_LABEL_GROUP`
   renames the group.

Linear's agents are a developer preview; the activity vocabulary this example maps onto is
documented at [linear.app/developers/agents](https://linear.app/developers/agents).

## Layout

| Path | What it is |
| ---- | ---------- |
| `server/agent-config.ts` | The engineer: id, model, and the guidance appended to the builtin coding profile. |
| `server/compose.ts` | The managed-agents server: builtin coding tools + `SubmitPullRequest` (as an extension), disk-backed sessions, and environments that are repositories (`owner/name` → a clone). Same composition as [`../managed-agents`](../managed-agents). |
| `server/checkout.ts` | The clone: one per session, stamped with its session id and repository; prepared through any `Environment`. |
| `server/sandbox.ts` | E2B mode: a sandbox per session, reconnected on open, paused on close, id kept on disk. |
| `server/langfuse.ts` | Tracing: the framework's OTel span tree, typed for Langfuse and exported with the project's keys. |
| `server/github.ts` | The server's GitHub access: git auth through the environment, the PR API, the write-access check. |
| `server/pull-request-tool.ts` | `SubmitPullRequest`: clean tree, right branch, push, open or update the PR on the repository the workspace marker names, session marker. |
| `src/bridge.ts` | Deliver a message or answer a question, then follow the turn on the event stream into a `Surface`. |
| `src/answers.ts` | A paused turn rendered as a message; a reply parsed back into answers. |
| `src/flows.ts` | The two flows -- a Linear session speaks, a PR comment mentions the bot -- on plain data. |
| `src/surfaces.ts` | Linear activities; GitHub comments with a collapsed trace. |
| `src/bot.ts` | Chat SDK wiring: adapters, routing, the GitHub write-access gate. |
| `src/app.ts` | The routes as one Hono app: two webhooks, the OAuth callback, `/healthz`. |
| `test/bridge.ts`, `test/fake-e2b.ts` | The faux-model end-to-end test, in both modes, and the SDK-shaped fake it uses for the E2B one. |

## How a turn flows

```
Linear webhook (AgentSessionEvent created/prompted) ─▶ @chat-adapter/linear ─▶ bot.onNewMention / onSubscribedMessage
                                                                                        │
  surface.ack ──────────── ephemeral thought (within Linear's 10s deadline) ◀───────────┤
  sessions.create({ id: "lin-<agentSessionId>", environment: "owner/name" }) ── 409 ok ──┤  created only
  events.stream({ after }) then messages.create / resume ──────────────────────────────┤
                                                                                        │
  message.appended(assistant, with tool calls) ── thought activity ─────────────────────┤
  tool.call.started / tool.result ─────────────── action activity (ephemeral → result) ─┤
  message.appended(assistant, text only) ──────── response activity ────────────────────┤
  SubmitPullRequest result ────────────────────── "Pull request" external URL ──────────┤
  turn.paused(pending) ────────────────────────── elicitation; outcome = waiting ───────┤
  turn.ended ──────────────────────────────────── outcome = completed / failed ─────────┘
```

A reply while the session is paused becomes `resume(answers)`: an approval is read off the first
word (`approve` / `reject`, the rest is feedback; anything unclear is a rejection carrying the
words), a question gets the whole reply as free text. The continuation keeps the paused turn's id
and emits no `turn.started`, so the bridge follows everything until the next `turn.ended`.

The same bridge serves GitHub: `@mention` → `pulls.get` → marker → session; thoughts and tool
calls accumulate and ride inside the reply as a `<details>` trace, so a review thread gets one
comment per turn.

## What the model is told

The builtin coding profile's prompt, plus `server/agent-config.ts`: how it was brought in
(mentioned = discuss, delegated = implement), branch naming (`linear/<KEY>-<slug>`), commit then
`SubmitPullRequest`, never `git push` (no credentials in the checkout), and that questions are
answered in prose. The first message carries Linear's `promptContext` (issue, comments, workspace
guidance) and the mentioning comment; later messages are attributed (`From Ada on Linear:`,
`From @login on GitHub pull request #12 on src/x.ts line 40:` with the diff hunk).

## Permissions

The server runs in `workspace` mode: everything inside the clone is approved, and the safety
floor still asks -- a sensitive file, `.git` internals, a write outside the checkout. An ask is a
durable interruption and reaches the thread like a question. `SubmitPullRequest` refuses a dirty
tree, a branch other than `HEAD`, and the default branch.

## Not here

- **A repository per team or project.** The choice is the issue's `repo` label (or the one
  default); a mapping from Linear team or project is a few lines in `src/bot.ts`'s `describeIssue`.
- **Other sandboxes.** E2B is wired; Cloudflare (`operon-sandbox` has the adapter) or
  `operon-os-sandbox` are the same seam in `server/sandbox.ts`.
- **Issues assigned on GitHub, whole reviews submitted at once.** The GitHub adapter handles
  `issue_comment` and `pull_request_review_comment`; other events are one more route in `src/app.ts`.
- **GitHub Agent HQ.** When GitHub opens third-party agent apps, this bot becomes one; until then
  it is a GitHub App that answers mentions.
