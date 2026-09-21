# operon-agents-tui

A terminal client for `operon-agents`. It talks to the engine only through the public Harness API
— `HarnessSession.prompt` / `steer`, `onEvent`, the approval and question handlers, and the
session's own control methods — so it is also the reference for what that API has to support.

The interface is ported from [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (MIT), whose
TUI is built on the same `@earendil-works/pi-tui` baseline. The rendering layer lives in
`operon-pi-tui` (a vendored fork, see `packages/pi-tui/AGENTS.md` for the divergences that must be
preserved); everything that touches the engine was rewritten against our types.

```bash
ANTHROPIC_API_KEY=... pnpm --filter operon-agents-tui build
ANTHROPIC_API_KEY=... pnpm --filter operon-agents-tui start -- \
  --model anthropic/claude-opus-4-8 --work-dir /path/to/project
```

## Starting up

| Flag | What it does |
| --- | --- |
| `-m, --model <provider/model>` | The model to start on. Falls back to `OPERON_MODEL`, then `default_model` in `tui.toml`. |
| `-C, --work-dir <path>` | The agent's workspace. Defaults to the current directory. |
| `--home-dir <path>` | Where sessions are stored. Defaults to `OPERON_AGENT_HOME` or `~/.operon`. |
| `-s, --session [id]` | Resume a session by id. With no id, the session picker is the startup screen. |
| `-c, --continue` | Resume the most recent session in this workspace. |
| `--permission <mode>` | `manual`, `workspace`, `yolo` or `auto`. Defaults to `manual`. |
| `--thinking <level>` | `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `--plan` | Start in plan mode. |

Model credentials come from the provider's own environment variables (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, …), exactly as for any other `operon-agents` host. An endpoint the engine does
not ship with — a local server, a gateway, a proxy — is configured in `providers.toml`; see
[Your own endpoints](#your-own-endpoints).

## Interaction

Enter submits. While a turn is running a submission queues behind it, and `Ctrl-S` steers the
queue into the live turn instead. `!` at the start of an empty line switches the editor to shell
mode: the command runs on the session's own environment, so `!` and the agent's Bash tool share one
shell and one working directory.

| Key | What it does |
| --- | --- |
| `Shift-Tab` | Toggle plan mode |
| `Ctrl-O` | Expand or collapse tool output |
| `Ctrl-T` | Expand or collapse the todo panel |
| `Ctrl-S` | Steer the queue into the running turn |
| `Ctrl-B` | Move a detachable tool call to the background |
| `Ctrl-G` | Open the draft in `$VISUAL` / `$EDITOR` (or `/editor`'s command) |
| `Ctrl-V` | Paste an image from the clipboard (`Alt-V` on Windows) |
| `Esc` | Close a dialog, cancel a pending compaction, then interrupt the run |
| `Ctrl-C` / `Ctrl-D` | Two-step exit; `Ctrl-C` first clears a non-empty editor |

`@` completes file paths (through `fd` when it is installed, a filesystem walk otherwise) and `/`
completes commands — the builtins below, every activatable skill, and every command the session's
own registry answers to, extensions included.

## Commands

`/model` offers the models whose provider has credentials on this machine, not the engine's whole
registry; `/model <provider/model>` switches to anything the engine can name, configured or not.
The engine knows over a thousand models across every vendor it speaks to, which is a catalog rather
than a choice, so the picker asks it which of those are actually reachable from here — with one
`ANTHROPIC_API_KEY` that is Anthropic's models, plus every endpoint `providers.toml` adds.

`/help` lists them in the app. Session: `/new`, `/sessions`, `/continue`, `/fork`, `/title`,
`/export-md`, `/copy`, `/exit`. Runtime: `/model`, `/thinking`, `/permission`, `/plan`, `/compact`,
`/settings`, `/theme`, `/editor`, `/reload-tui`. Inspection: `/status`, `/usage`, `/context`,
`/mcp`, `/plugins`, `/tasks`. Work: `/goal`, `/init`.

`/continue` is the one to reach for on a session that reopens as interrupted: a run that paused for
an approval or a question with nobody attached is resumed by answering it here.

## Preferences

Client preferences live in `~/.operon/tui.toml` (theme, LaTeX rendering, paste-burst fallback, the
external editor, terminal notifications, the footer status line, and the default model). Custom
themes are JSON files in `~/.operon/themes/`. Session storage and model configuration are the
harness's, not this file's.

## Your own endpoints

The built-in catalog covers every major vendor, but each is a fixed list at a fixed address. A
self-hosted server, a gateway or a proxy is neither: its address is local knowledge, and only that
endpoint knows which models it serves. So `~/.operon/providers.toml` says where it is, and its
model list is fetched from it (`GET {base_url}/models`, the OpenAI-compatible shape they all
speak) rather than declared.

```toml
# A local server. /model offers whatever http://localhost:8000/v1/models reports.
[providers.local]
base_url = "http://localhost:8000/v1"
context_window = 128000          # the default applied to every model it reports

# Facts the endpoint does not report about one of its models.
[providers.local.models."qwen3-coder"]
name = "Qwen3 Coder"
context_window = 262144
reasoning = true

# A gateway that wants a key, read from the environment rather than written here.
[providers.gateway]
base_url = "https://llm.corp.internal/v1"
api_key_env = "CORP_API_KEY"
api = "anthropic-messages"       # or openai-completions (default), openai-responses
fetch_models = false             # ask nothing; serve only the models declared below
[providers.gateway.models."claude-sonnet-4-5"]
context_window = 200000
```

The models then behave like any others: `--model local/qwen3-coder` starts on one, `/model` lists
them, and a switch mid-session works. An endpoint that is unreachable at startup costs a warning
and five seconds, not a failed start, and anything the file declared about it stays selectable.

This is the harness's file, not the client's: `createLocalHarness` reads it, so the app server and
any script that builds a harness see the same providers. There is no command to edit it — a
provider is a piece of machine configuration, and the file is the place for it.

## Layout

```
src/
  operon-tui.ts      the coordinator: layout, app state, session lifecycle
  cli.ts main.ts     argument parsing and the process entrypoint
  commands/          slash-command declaration, resolution and handlers
  components/        chrome · dialogs · editor · media · messages · panes
  controllers/       event routing · streaming · replay · keyboard · tasks
  reverse-rpc/       approval and question panels behind the engine's handlers
  theme/ utils/      palette and pure helpers
  app/               process-level helpers (clipboard, git, paths, history)
```

The coordinator holds no rendering or routing logic of its own: events go to
`controllers/session-event-handler.ts`, live rendering to `controllers/streaming-ui.ts`, and a
resumed transcript is rebuilt by `controllers/session-replay.ts` from the session journal through
the same live hooks, so a replayed turn looks like it did while it streamed. Each controller
reaches back through an explicit `*Host` interface, which is what makes them testable alone.
