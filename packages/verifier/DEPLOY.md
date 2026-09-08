# Deploying the Moolam verify service

The verify service is a single stateless container. It loads the passport index
from Envio at boot, holds it in memory, and answers `/verify` from that index.
No database, no volume, no shared state, so a host can restart it or run two
copies without any coordination.

## Build

The build context is the repo root, not this folder, because `npm ci` checks the
root lockfile against every workspace manifest before it installs.

```
docker build -f packages/verifier/Dockerfile -t moolam-verifier .
```

The install step inside the image is
`npm ci --workspace packages/verifier --include-workspace-root=false`.
`sharp` and `@contentauth/c2pa-node` fetch their Linux binaries during that step,
so the builder needs outbound network access. The root `.dockerignore` keeps the
Windows `node_modules` and the web app out of the context.

## What it needs to run

| Resource | Value |
| --- | --- |
| Image size | 716 MB (base `node:26-bookworm-slim`) |
| Memory | 72 MiB resident with 22 passports loaded, measured with `docker stats` after one verification |
| Memory to allocate | 512 MB. Matching decodes the image nine times and two matches may run at once, so headroom above the idle figure is the point |
| CPU | 1 shared vCPU. A match is CPU bound for well under a second |
| Port | 4010, and the server binds `0.0.0.0` |
| User | runs as the non-root `node` user |
| Health | `GET /health` returns `{"ok":true,"records":N,"version":"0.1.0"}`. The image also declares a Docker `HEALTHCHECK` on the same path |

## Environment

Names and defaults come from `src/env.ts`. A missing or malformed value fails
the boot loudly and names the variable.

| Variable | Required | Where the value comes from |
| --- | --- | --- |
| `PASSPORT_SOURCE` | yes, set `envio` | Defaults to `json`, which reads a local file. Production reads the chain through Envio |
| `ENVIO_GRAPHQL_URL` | yes when source is `envio` | The GraphQL endpoint of the Envio Cloud deployment for the Moolam indexer |
| `VERIFIER_PORT` | no | The image sets 4010. Override only if the host insists on its own port |
| `PASSPORT_SOURCE_PATH` | no | Only read when `PASSPORT_SOURCE` is `json`. Leave unset in production |
| `MONAD_MAINNET_RPC_URL` | no | Defaults to `https://rpc.monad.xyz`. Set a provider endpoint if you want your own rate limit |
| `VERIFIER_PRIVATE_KEY` | no | A fresh wallet, funded with a little MON, used only to post reputation feedback. 0x and 64 hex characters. Never commit it |
| `VERIFIER_ADDRESS` | no | The address of that wallet, 0x and 40 hex characters |
| `VERIFIER_BASE_URL` | no | The public URL of this service, used when it needs to name itself |
| `MOOLAM_C2PA_CERT_PATH` | no | Path to your own signing certificate. Set both this and the key, or neither |
| `MOOLAM_C2PA_KEY_PATH` | no | Path to the matching private key |
| `X402_ENABLED` | no | `true` turns on the paid verify route. Defaults to `false` |
| `X402_FACILITATOR_URL` | no | Defaults to the facilitator Monad runs, `https://x402-facilitator.molandak.org` |
| `X402_PAY_TO_ADDRESS` | only when x402 is on | The address that collects the per-call fee |
| `X402_PRICE` | no | Defaults to `$0.05` |

`src/env.ts` reads no Pinata variables, so none are needed here.

## Railway

Sourced from the Railway Dockerfiles guide and the monorepo guide. Anything those
two pages do not state is marked as a dashboard check rather than guessed.

1. New project, deploy from the GitHub repo.
2. Leave the service Root Directory at the repo root. Railway calls this a shared
   monorepo: the components need the common root, and this build does too,
   because the lockfile lives there.
3. Set the service variable `RAILWAY_DOCKERFILE_PATH` to
   `packages/verifier/Dockerfile`. That is the documented way to point Railway at
   a Dockerfile that is not at the root of the source directory. The filename must
   stay exactly `Dockerfile`.
4. Add the environment variables from the table above as service variables.
5. Port and health check path: neither guide covers how Railway picks the port or
   where the health check path is set. Check the dashboard. The container listens
   on 4010 and answers `GET /health`. If Railway injects its own port variable,
   set `VERIFIER_PORT` to the same number.
6. Watch paths are optional. Setting them to `packages/verifier/**` stops a web or
   docs commit from rebuilding this service.
7. Custom domain: not covered by those two guides. Check the dashboard.

## Fly.io

Sourced from the Fly Dockerfile guide. Same rule about what is not on the page.

1. Run `fly launch` from the repo root. The guide says the command detects your
   Dockerfile, builds it, and deploys.
2. App name `moolam-verifier`. The Dockerfile here is not at the repo root, and
   that page does not document a flag for a custom Dockerfile path, so confirm
   the flag with `fly launch --help` before relying on
   `--dockerfile packages/verifier/Dockerfile`.
3. Region: `fly launch` picks the fastest region and writes it as
   `primary_region` in `fly.toml`. Keep it or choose another.
4. Port: `internal_port` in `fly.toml` follows the `EXPOSE` instruction, which is
   4010 here. Fly falls back to 8080 only when it finds no port in the Dockerfile.
5. Secrets: `fly secrets set ENVIO_GRAPHQL_URL=... PASSPORT_SOURCE=envio` and the
   rest of the table. The guide shows `flyctl secrets set MY_SECRET=romance`.
6. Health check: not covered by that page. Check the `fly.toml` reference or the
   dashboard. The path is `/health` and a 200 means ready.

## The last step

Whichever host wins, set `VERIFIER_BASE_URL` on Vercel to the deployed service
URL so the web app's `/api/verify` route calls the hosted verifier instead of a
laptop.
