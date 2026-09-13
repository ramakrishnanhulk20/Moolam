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
| Health | `GET /health` returns `{"ok":true,"records":N,"version":"0.2.0","routes":["verify","prepare","generate","edit","health"]}`, where `routes` is what this host actually mounted. The image also declares a Docker `HEALTHCHECK` on the same path |

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
| `X402_ENABLED` | no | `true` turns on the paid verify route. Defaults to `false`, and the route answers 404 until it is set |
| `X402_FACILITATOR_URL` | no | Defaults to the facilitator Monad runs, `https://x402-facilitator.molandak.org` |
| `X402_PAY_TO_ADDRESS` | only when x402 is on | The wallet the USDC goes to. Set it together with `X402_ENABLED`, or the container refuses to boot |
| `X402_PRICE` | no | Price per paid verification in dollars of USDC, written as `$0.05`, which is the default. A bare `0.05` fails the boot |
| `PINATA_JWT` | yes for the studio | An API key made at app.pinata.cloud, the JWT it shows once. This is what `/prepare` pins with, so treat it as a spending secret |
| `PINATA_GATEWAY_URL` | no | This Pinata account's dedicated gateway, ending in `/ipfs/`. Defaults to the public gateway, which rate-limits a busy address |
| `PRIVY_APP_ID` | yes for the studio | The app id from dashboard.privy.io, the same one the web app signs users in with. `/prepare` accepts that app's access tokens and no other's |
| `CORS_ORIGINS` | yes for the studio | Comma separated exact origins of the web app, such as `https://moolam.app,http://localhost:3000`. No wildcard, no trailing slash |
| `OPENAI_API_KEY` | yes for `/generate` | A key from platform.openai.com. Every call spends money, so scope it to this project and watch the usage page |
| `OPENROUTER_API_KEY` | no | Used only when there is no OpenAI key. Then set `AGENT_IMAGE_MODEL` to the vendor-prefixed name, `openai/gpt-image-1-mini` |
| `AGENT_IMAGE_MODEL` | no | Defaults to `gpt-image-1-mini`, the cheapest image model on the account |
| `AGENT_IMAGE_BASE_URL` | no | Another endpoint for the same API. Leave unset |
| `PRIVY_APP_SECRET` | yes for `/generate` | The app secret from the same Privy dashboard page as the app id |
| `PRIVY_AUTHORIZATION_KEY` | yes for `/generate` | The authorization key that owns the agent's server wallet. Privy's SDK signs each request with it locally and never sends it |
| `GENERATOR_WALLET_ID` | yes for `/generate` | The `generator.id` in `packages/agents/.moolam/wallets.json`, written by `npm run prove:privy`. It is a handle, not a secret, but the wallet only signs for the holder of the authorization key |
| `GENERATOR_WALLET_ADDRESS` | no | The `generator.address` from the same file. Left unset the service asks Privy for it once at the first signature |
| `GENERATOR_AGENT_ID` | no | Defaults to `10249`, the `generator.agentId` in that file: the ERC-8004 identity the wallet owns |
| `MOOLAM_REGISTRY_ADDRESS` | no | Defaults to the deployed registry in `packages/contracts/deployments/monad-mainnet.json`. The container ships only this package's source, so the address cannot be read from that file at runtime |
| `GENERATE_PER_DAY` | no | Defaults to 3 pictures per creator per rolling 24 hours |
| `PRIVY_EDIT_SIGNER_ID` | yes for `/edit` | The key quorum whose one member is the public half of `PRIVY_AUTHORIZATION_KEY`. `npm run edit:quorum` in `packages/agents` creates it under the name `moolam-edit-signer`, prints the id and writes it into the root `.env`; copy that id here. The browser passes the same id to `addSigners`, so the value here and the value the web app uses must match |
| `PRIVY_EDIT_POLICY_ID` | yes for `/edit` | The policy id that quorum is held to, built by `sessionSignerPolicy` in `packages/agents/src/privy/policies.ts` and recorded in `packages/agents/.moolam/wallets.json`. A wallet whose grant does not carry it is answered 409 `no-signer` |
| `EDITS_PER_DAY` | no | Defaults to 5 edits per creator per rolling 24 hours |
| `TRUST_PROXY` | yes behind a proxy | Which hops may set the caller's address: a comma separated list of addresses, CIDR ranges, or the words `loopback`, `linklocal`, `uniquelocal`. Empty, the default, believes nothing and reads the socket, which behind a proxy puts every caller in one rate-limit bucket |
| `INDEX_REFRESH_MS` | no | How often the passport index is rebuilt from the source, in milliseconds. Defaults to 60000. `0` turns the refresh off and the index is then whatever was loaded at boot |
| `EXPECT_ROUTES` | no | Routes this host must be able to mount or it refuses to boot, comma separated from `prepare`, `generate`, `edit`, `verify/paid`. Empty, the default, mounts whatever the keys allow and logs the rest as off |
| `MATCH_WAIT_MS` | no | How long a verification waits for a free matching slot before the caller is answered 503 `busy`, in milliseconds. Defaults to 30000 |

Without `PINATA_JWT` and `PRIVY_APP_ID` the container still boots and still
verifies images. It logs one line saying the prepare route is off and answers 404
on that path. `/generate` needs all of those plus an image model key, the two
Privy secrets and the wallet id, and it says the same kind of line and answers 404
when one is missing. `/edit` needs what `/prepare` needs plus the two Privy
secrets and the two ids above, and no image model key at all, since nothing is
drawn. It says the same kind of line and answers 404 when one is missing.

Turning the paid route on is those two variables and nothing else: `X402_ENABLED=true` and
`X402_PAY_TO_ADDRESS` set to the wallet that collects. Setting one without the other stops the boot
and names the missing variable, because a payment route with no recipient must never mount. Nothing
else about the service changes: the free `/verify` keeps answering, and the paid path simply exists.
The service holds no key for this, signs nothing and pays no gas. The payer signs a USDC transfer
authorisation and Monad's facilitator submits it and pays the gas for it.

`/edit` is the only route that sends a transaction, and it never pays for one:
Privy sponsors the gas and the creator's own wallet is the sender. The one
`appendEdit` measured on the live proof run, in `proofs/privy.txt`, was sent with
a limit of 482,480 and cost 0.0492 MON at 102 gwei, and Monad charges the limit
rather than the gas used. That edit also carried a generator signature; the one
this route sends does not, so it skips a signature recovery and one external call
and lands a little under that figure. Plus four IPFS pins. `EDITS_PER_DAY` is the
cap on both, counted in memory against the verified Privy user id, with the same
restart hole as the generate allowance.

## What the generate route costs

One picture is a medium 1024 by 1024 image from `gpt-image-1-mini`. That model's
published price is 8 dollars per million image output tokens and a medium square
is around a thousand of them, so on the order of a cent or two a picture, plus
four IPFS pins on the Pinata plan and no gas at all: this service never sends a
transaction. At the default `GENERATE_PER_DAY` of 3 that is a few cents per
creator per day, and a hundred creators spending their whole allowance every day
would be a few dollars a day. Lower the number before a public launch if that is
not a bill you want.

Do not take those cents from this page. Every success writes one log line,
`generate: picture drawn`, with the model and the tokens it billed, so the real
figure comes from the running service. The one live check against the real model
and the real Pinata took 35 seconds end to end for a 1024 square, so budget the
client for a minute per request rather than a second.

The count lives in the service's memory, so a restart gives everyone their
allowance back and two copies of the container count separately. That is the
known hole, and it is cents wide.

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
   Two of them matter only on a host like this one. Set `TRUST_PROXY` to
   `loopback,uniquelocal,100.64.0.0/10`, which covers Railway's own edge, and then
   validate it: log `request.ip` once on the real host and check it is the
   caller's address and not the proxy's, because a list that is too short puts
   every caller in one rate-limit bucket and a list that is too long lets a caller
   choose their own. Set `EXPECT_ROUTES=prepare,generate,edit` so a deploy that is
   missing a key stops at boot instead of serving a service with routes quietly
   switched off.
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

Whichever host wins, the web app needs the deployed service URL once on Vercel,
as `NEXT_PUBLIC_VERIFIER_URL`: the browser calls `/verify` and `/prepare` on this
service directly, with no route of the app in between. A Vercel function cannot
take a 20 MB upload, so every image goes straight from the browser to this service.

That direct call is a cross-origin request, so the host must also carry
`CORS_ORIGINS` with the web app's exact origin in it, production and preview
domains included. Miss it and the studio fails in the browser with a CORS error
while curl against the same URL works perfectly.
