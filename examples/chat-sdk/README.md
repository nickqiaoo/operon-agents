# Chat SDK × operon managed agents

A research-analyst chat bot: [Vercel's Chat SDK](https://chat-sdk.dev) as the chat surface,
an `operon-managed-agents` server as the agent. A port of Anthropic's
[`managed-agents/chat-sdk` quickstart](https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/chat-sdk)
with the agent platform swapped: the Chat SDK wiring, the page, and the shape of the bridge
are the same; what changed is the one file that talks to the agent
(`src/managed-agents.ts`) and the server that runs it (`server/`).

- Each conversation is a managed session: the conversation ID *is* the session ID, the
  session's event log is the transcript, and the chat server stores nothing.
- Token streaming (`assistant.delta`) types the reply out; tool calls stream to a live
  activity feed and stay in the transcript as a collapsible trace; each research turn ends
  with a "brief ready" card.
- No third-party credentials: the Chat SDK **web adapter** talks to the page in this repo.
  Slack, Teams, Discord, Telegram, WhatsApp are one more adapter in `src/bot.ts`.

## Run

Two processes. The analyst server is the agent platform; the chat app is its client, exactly
as a Slack bot would be.

```bash
pnpm install && pnpm build            # once, at the repo root
cd examples/chat-sdk
cp .env.example .env                  # ANTHROPIC_API_KEY, and a TAVILY_API_KEY or FIRECRAWL_API_KEY for search

pnpm server                           # terminal 1: managed-agents API on :8088
pnpm dev                              # terminal 2: chat page on http://127.0.0.1:3000
```

Without a search key the analyst can still fetch URLs you paste, but cannot search.

`pnpm test` runs the whole thing against a faux model in-process -- bridge, replay, and the
HTTP surface as the page drives it -- and needs no keys.

## Layout

| Path | What it is |
| ---- | ---------- |
| `server/agent-config.ts` | The analyst: id, model, system prompt. |
| `server/main.ts` | The managed-agents server: one agent (web search + fetch, **no shell, no files, no subagents**), one environment, disk-backed sessions. Same composition as [`../managed-agents`](../managed-agents). |
| `src/bot.ts` | Chat SDK instance and the web adapter; `getUser` is the auth boundary. |
| `src/managed-agents.ts` | The bridge: open the session stream, send the message, fold events into `thread.post()` calls. |
| `src/sessions.ts` | Sidebar: list, create, and replay a session's transcript from its event log. |
| `src/app.ts` | The `/api` routes as one fetch-native Hono app. |
| `web/` | React + `useChat` page, bundled by esbuild on request. |
| `test/bridge.ts` | The faux-model end-to-end test. |

## How a turn flows

```
useChat POST /api/chat ─► Chat SDK web adapter ─► bot.onDirectMessage ─► runTurn
                                                                            │
   events.list(limit 1, desc) ──► events.stream({ after })  ◄───────────────┤  1. open the stream past the history
   messages.create({ mode: "follow_up" }) ──► deliveryId    ◄───────────────┤  2. send
                                                                            │
   turn.started / message.appended(origin.deliveryId)  ── anchor ───────────┤  3. find OUR turn (older leftovers are skipped)
   assistant.delta ─────────────────────────── streamed bubble ─────────────┤
   message.appended(assistant) ─────────────── authoritative text ──────────┤
   tool.call.started / tool.result ─────────── activity feed + kept trace ──┤
   turn.ended(completed) + interruptions() ─── done, or "stuck on approval" ┘
```

The live bridge and the replay (`historyOf`) apply the same rules -- same text joining, same
tool labels, same "only a cleanly ended turn gets its trace and card" gate -- so a reopened
chat looks exactly like it did live. The replay folds the log through `SessionProjection`,
the engine's own reducer, so compaction is handled the way a reopened session handles it.

## What is different from the Anthropic quickstart

| | Claude Managed Agents | operon managed agents |
| - | - | - |
| Provisioning | `npm run setup` creates an agent + environment, IDs go in `.env` | The agent and environment are registered in `server/main.ts`; nothing to provision |
| Send | `events.send({ events: [user.message] })` | `messages.create({ input, mode: "follow_up" })` |
| Stream | live only, `event_deltas[]` opt-in for previews | replays history then follows live; deltas always on; resumable with `after` |
| Turn events | `agent.message`, `agent.tool_use`, `session.status_idle` | `message.appended`, `tool.call.started`, `turn.ended` |
| Approval dead end | `stop_reason: requires_action` | `interruptions()` non-empty after `turn.ended` / 409 on send |
| Rename | `sessions.update({ title })` | `sessions.update({ title })` (added for this example: `PATCH /v1/sessions/{id}`) |

## What the model is told

A chat message is the colleague's own words, and that is how it reaches the model:
`messages.create` delivers it as the session's user (the default, `origin: "user"`), journaled
bare, exactly as a prompt typed into a local session would be. The envelope the engine puts
around *relayed* input -- `<external-message>` stamped "NOT a message from the user", for a peer
or a webhook passing on someone else's words -- is what `origin: "external"` asks for; the chat
never does. Transcripts recorded before the managed API could deliver the user's own words still
hold that envelope, so the display strips it (`userTextOf`) and old and new sessions read the
same.

## Tool permissions

The analyst's tools (`WebSearch`, `FetchURL`) are always allowed by policy, and the harness
runs in `workspace` permission mode. If you add a tool that asks (a shell, an editor), the
chat has no approval surface: the session parks on the question, the server refuses further
input (409), and the bridge tells the user to start a new chat. Answer such interruptions
with `client.sessions.resume()` from somewhere that can -- or don't add those tools to a
bot that reads untrusted web pages.

## Going to a chat platform

Add the platform's adapter next to `web` in `src/bot.ts` and mount its webhook in
`src/app.ts`; `runTurn` only depends on `BotThread { id, post() }`. The Chat SDK handles
streaming fallbacks (post-then-edit where a platform can't stream) and renders the brief card
natively where it can (Slack Block Kit, Teams Adaptive Cards). Set `PUBLIC_URL` so the card's
"Open session events" link is absolute.
