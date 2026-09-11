# Build context is the repository root: the example depends on the workspace packages.
#   docker build -f examples/linear-github/deploy/Dockerfile -t operon-linear-github .
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ── build: install the example's dependency closure, compile the packages it imports ──
# The whole workspace is copied because pnpm resolves the lockfile against every member.
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY examples/ examples/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter operon-example-linear-github...
# Serially: each package's build script builds its own dependencies, so a parallel
# run compiles against half-written declaration files.
RUN pnpm --workspace-concurrency=1 --filter operon-example-linear-github^... build

# ── runtime: one image, two commands (engineer server / bot) ────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/examples/linear-github
# Written to by the engineer server; mount both as volumes so sessions survive a redeploy.
RUN mkdir -p .agent-home workspace
EXPOSE 3000 8088
CMD ["node", "--import", "tsx", "src/main.ts"]
