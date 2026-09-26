# Build context is the repo root, not this folder:
#   docker build -f packages/verifier/Dockerfile -t moolam-verifier .
# The workspace layout has to survive into the image because npm ci checks the
# root lockfile against every workspace package.json before it installs.

FROM node:26-bookworm-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agents/package.json packages/agents/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/indexer/package.json packages/indexer/package.json
COPY packages/verifier/package.json packages/verifier/package.json
COPY packages/web/package.json packages/web/package.json

FROM manifests AS deps
RUN npm ci --workspace packages/verifier --include-workspace-root=false

FROM deps AS build
COPY packages/verifier/tsconfig.json packages/verifier/tsconfig.build.json packages/verifier/
COPY packages/verifier/src packages/verifier/src
RUN npm run build --workspace packages/verifier

# Installed from the manifests again rather than pruned from `deps`, so the
# runtime tree is exactly what a clean production install produces. sharp and
# @contentauth/c2pa-node fetch their native binaries during this step.
FROM manifests AS prod-deps
RUN npm ci --workspace packages/verifier --include-workspace-root=false --omit=dev \
 && mkdir -p /app/packages/verifier/node_modules

FROM node:26-bookworm-slim AS runtime
# sharp decodes every picture on libuv's thread pool, which holds four threads by
# default and is shared with file writes. Eight gives the decodes a margin.
ENV NODE_ENV=production \
    VERIFIER_PORT=4010 \
    UV_THREADPOOL_SIZE=8
WORKDIR /app
# The C2PA signer makes its development certificate with openssl at first use,
# and a host without it now refuses to mount /prepare rather than answering
# with unsigned files.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/packages/verifier/node_modules ./packages/verifier/node_modules
# src/server.ts reads this file for the version it reports on /health.
COPY --chown=node:node packages/verifier/package.json ./packages/verifier/package.json
COPY --from=build --chown=node:node /app/packages/verifier/dist ./packages/verifier/dist
USER node
EXPOSE 4010
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.VERIFIER_PORT}/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "packages/verifier/dist/server.js"]
