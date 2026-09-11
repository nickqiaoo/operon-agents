# Deploying to a server

Two containers on one host: the **engineer** server (private, on the compose network) and the
**bot**, published on loopback for the reverse proxy already running there. Sessions run in E2B
sandboxes, so the host holds session logs and sandbox ids -- not clones, not the model's shell.

```
Linear / GitHub ──https──▶ reverse proxy :443 ──▶ bot 127.0.0.1:3000 ──▶ engineer :8088 ──▶ E2B sandbox
                            (already on the host)                    │              (one per session)
                                                      agent-home + workspace volumes
```

## 1. Credentials, before anything is deployed

| What | Where it comes from |
| ---- | ------------------- |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `E2B_API_KEY` | e2b.dev dashboard |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_USERNAME` | the GitHub App (README "GitHub setup") |
| `LINEAR_CLIENT_CREDENTIALS_CLIENT_ID` / `_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_BOT_USERNAME` | the Linear OAuth application (README "Linear setup") |
| `GITHUB_REPO` | the repository for issues without a `repo` label (optional; README "Linear setup") |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | a Langfuse project, to trace sessions (optional; README "Tracing") |

Both webhook URLs need the public hostname, so pick the domain first, point its A record at the
server, and register the webhooks with `https://<domain>/api/webhooks/linear` and
`.../api/webhooks/github`.

## 2. Build off the server

The image is built on a workstation and loaded onto the host: compiling the workspace needs
more memory than a small server has, and the server's job is to run two node processes, not
a TypeScript build. Match the server's architecture -- an Apple Silicon machine must cross
build, which QEMU makes slow but reliable.

```bash
docker buildx build --platform linux/amd64 \
  -f examples/linear-github/deploy/Dockerfile -t operon-linear-github:amd64 --load .
docker save operon-linear-github:amd64 | gzip -1 | \
  ssh <host> 'gunzip | docker load && docker tag operon-linear-github:amd64 operon-linear-github:latest'
```

The tag matters: compose names the image without one, so it looks for `:latest`. Keeping the
`:amd64` tag as well lets a workstation hold both architectures without one clobbering the other.

A registry works too, and is better once this is redeployed often.

## 3. The server

Docker and the compose plugin. Nothing else -- git, node and pnpm live in the image. TLS and
port 443 belong to the reverse proxy already on the host; `nginx.conf.example` is the server
block to add beside its own, in whatever directory its http block includes from.

Only `deploy/` and a filled-in `.env` need to be on the host:

```bash
mkdir -p ~/linear-github/deploy && cd ~/linear-github
# copy deploy/docker-compose.yml here, and .env one level up from it
$EDITOR .env
```

Beyond `.env.example`, production needs two more lines:

```bash
MANAGED_API_KEY=$(openssl rand -hex 32)   # the bot authenticates to the engineer with this
E2B_API_KEY=e2b_...                       # sessions run in sandboxes rather than on this host
```

`MANAGED_API_KEY` is not optional here: the engineer server stays on loopback until it has one,
and the bot reaches it across the compose network.

## 4. Up

```bash
cd deploy
docker compose --env-file ../.env up -d
docker compose logs -f
```

`curl localhost:3000/healthz` answers when the bot is live; install the server block, reload the
proxy, and the same path answers over the domain. Then delegate a Linear issue to the agent,
or `@mention` it in an issue comment.

## Operating it

- **Volumes.** `agent-home` holds session logs and managed metadata; `workspace` holds each
  session's `sandbox.json`. Losing `workspace` orphans the sandboxes: a session reopened after
  that clones again and loses work since its last push.
- **Redeploy.** Build and load a new image, then `docker compose up -d`. Sessions are on disk,
  so a paused session survives it; a turn in flight does not.
- **Memory.** The two processes are capped at 256m and 224m. On a host that is already running
  something else, watch `docker stats` after the first real session: a turn holds the model's
  streamed response and the session's event log.
- **Sandbox cost.** A session pauses its sandbox after every turn, so a thread waiting days for
  a reply costs storage. `E2B_TIMEOUT_MS` bounds an idle sandbox that is still held open.
- **Tracing.** With the Langfuse keys in `.env`, the engineer container exports spans in
  batches; a `docker compose down` or restart flushes what is buffered before the process
  exits. Nothing else runs on the host for it.
- **Secrets.** `.env` is read by compose and by both containers. It holds the App's private key;
  keep it 0600 and out of git.
