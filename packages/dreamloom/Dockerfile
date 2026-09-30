# Build context is the repo root, not this folder:
#   docker build -f packages/dreamloom/Dockerfile -t dreamloom .
# On Railway: RAILWAY_DOCKERFILE_PATH=packages/dreamloom/Dockerfile, uploaded with `railway up`
# from the repo root. npm ci checks the root lockfile against every workspace package.json, so each
# one is copied even though only the kit and Dreamloom are installed and built.

FROM node:26-bookworm-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agents/package.json packages/agents/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/dreamloom/package.json packages/dreamloom/package.json
COPY packages/indexer/package.json packages/indexer/package.json
COPY packages/recheck-runner/package.json packages/recheck-runner/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/verifier/package.json packages/verifier/package.json
COPY packages/web/package.json packages/web/package.json

FROM manifests AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm ci --workspace packages/sdk --workspace packages/dreamloom --include-workspace-root=false
COPY packages/sdk/tsconfig.json packages/sdk/tsconfig.build.json packages/sdk/
COPY packages/sdk/src packages/sdk/src
# Named one by one rather than the whole folder: packages/dreamloom/.env.local holds Dreamloom's
# keys on the machine that builds, the root .dockerignore only drops .env files at the root, and
# next build would read that file. A new top-level file the app needs must be added here.
COPY packages/dreamloom/app packages/dreamloom/app
COPY packages/dreamloom/components packages/dreamloom/components
COPY packages/dreamloom/lib packages/dreamloom/lib
COPY packages/dreamloom/public packages/dreamloom/public
# next-env.d.ts is not copied: git ignores it, and next build writes it when it is missing.
COPY packages/dreamloom/instrumentation.ts packages/dreamloom/next.config.ts packages/dreamloom/postcss.config.mjs packages/dreamloom/tsconfig.json packages/dreamloom/
# The build script's prebuild step builds the kit first, so the app bundles the kit's dist.
RUN npm run build --workspace packages/dreamloom

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# The standalone folder mirrors the repo from its root (next.config.ts sets the tracing root there),
# so the server lands at packages/dreamloom/server.js with only the modules it traced beside it.
# Next serves the static chunks and public files from beside the server, and copies neither itself.
COPY --from=build --chown=node:node /app/packages/dreamloom/.next/standalone ./
COPY --from=build --chown=node:node /app/packages/dreamloom/.next/static ./packages/dreamloom/.next/static
COPY --from=build --chown=node:node /app/packages/dreamloom/public ./packages/dreamloom/public
COPY packages/dreamloom/container-start.sh ./packages/dreamloom/container-start.sh
# No USER line on purpose. A Railway volume is mounted owned by root when the container starts, so
# the start script runs as root just long enough to hand the data folder to node, then runs the
# server as node through setpriv, which util-linux ships in this base image. The host sets PORT.
CMD ["sh", "packages/dreamloom/container-start.sh"]
