# Deploying the Moolam verify service

The verify service is a single container with one data folder. It loads the
passport index from Envio at boot, holds it in memory, and answers `/verify` from
that index. What it has to remember between requests (the re-check queue, the
daily ceilings, the per-creator allowances, the private-copy keep times and the
sweep's place) is kept as small JSON files in the data folder, described under
"What it keeps" below. No database. Run one copy: two would count every ceiling
and allowance separately, and a Railway volume cannot be shared by replicas.

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
| Memory | 240 MB on average and 290 MB at peak on Railway, from `railway metrics` on 2026-09-26. One 40 megapixel blockhash decode adds about 383 MB while it runs (review pass 8) |
| Memory to allocate | At least 2 GB. Three 40 megapixel decodes may be in flight at once, about 1.15 GB, and a full 200 MiB upload ceiling costs about 420 MB with the copies each body gets, which with the 290 MB peak comes to about 1.9 GB. Railway gives this service up to 8 GB |
| CPU | 1 shared vCPU. A match is CPU bound for well under a second |
| Port | 4010, and the server binds `0.0.0.0` |
| User | the service runs as the non-root `node` user. The container starts as root only to run `container-start.sh`, which hands the data folder to `node` and then starts the service through `setpriv` as `node`. `RAILWAY_RUN_UID=0` is never set, because that would run the whole service as root |
| Health | `GET /health` returns `{"ok":true,"records":N,"version":"0.2.0","routes":["verify","prepare","generate","edit","health"],"off":[],...}`, where `routes` is what this host has on right now and `off` names each route it left off, as `{"route":"POST /prepare","reason":"..."}`, with a plain reason that carries no path, address or key. The image also declares a Docker `HEALTHCHECK` on the same path |

## Environment

Names and defaults come from `src/env.ts`. A missing or malformed value fails
the boot loudly and names the variable.

| Variable | Required | Where the value comes from |
| --- | --- | --- |
| `PASSPORT_SOURCE` | yes, set `envio` | Defaults to `json`, which reads a local file. Production reads the chain through Envio: with `NODE_ENV=production` any other value refuses to boot and names this variable, because the image holds no local file and an empty register would call every picture unregistered |
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
| `DATA_DIR` | no on Railway, yes on any other host that should remember | The folder every state file lives in, an absolute path such as `/data`. Unset, it is `RAILWAY_VOLUME_MOUNT_PATH`, which Railway sets itself when a volume is attached, and without either it is `test-assets/state` inside the package, which in the container is the image's own disk and is emptied by every deploy |
| `RECHECK_QUEUE_PATH` | no | The re-check queue's file. Defaults to `recheck-queue.json` in the data folder. Set it only to keep the queue somewhere else; the other state files stay in the data folder |

Without `PINATA_JWT` and `PRIVY_APP_ID` the container still boots and still
verifies images. It logs one line saying the prepare route is off and answers 404
on that path. `/generate` needs all of those plus an image model key, the two
Privy secrets and the wallet id, and it says the same kind of line and answers 404
when one is missing. `/edit` needs what `/prepare` needs plus the two Privy
secrets and the two ids above, and no image model key at all, since nothing is
drawn. It says the same kind of line and answers 404 when one is missing.

A signing certificate or key that does not load, such as a path with no file
behind it or only one of the two set, no longer stops the boot. `/prepare`, `/generate` and `/edit` sign every picture,
so the host leaves those three off, logs why once, and lists each under `off` in
`/health`. `/verify`, the re-check queue and the unseal and sealed routes keep
serving. Only an `EXPECT_ROUTES` that names one of the three still stops the boot,
and it names the signer as the reason. In the same way, a registry check that
cannot read the chain at boot leaves `/generate` answering 503
`generator-unchecked`, listed under `off`, and tries again every 5 minutes.

With neither `MOOLAM_C2PA_CERT_PATH` nor `MOOLAM_C2PA_KEY_PATH` set, the service
makes a development signing identity with openssl at boot, in
`test-assets/certs` inside the container, which is why the image installs
openssl. Its signing certificate lasts 365 days from the moment it was made, and
nothing renews it. The window is checked at boot and again on every signing, so
when it runs out, signing turns off with a plain reason rather than producing
files no reader can verify: a host that boots with it expired leaves
`/prepare`, `/generate` and `/edit` off and names the reason under `off` in
`/health`, and a host that was already running answers each of those three
`502 sign-failed`, with "the signing certificate expired at" and the date in the
log. A redeploy starts a fresh container with no identity on disk, so it makes a
new one that lasts another 365 days. Pictures signed under the old one stay
valid: the verify answer calls them signed and adds `credential: "expired"`.

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
cap on both, counted against the verified Privy user id and saved in the data
folder, so on a volume a deploy does not hand it back.

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

The count is saved in the data folder, so on a volume a deploy or a restart does
not give anyone their allowance back. Two copies of the container would count
separately, which is one reason the host runs one.

## What it keeps

Every file below lives in the data folder (`DATA_DIR`, else the Railway volume)
and is written to a temp name and renamed into place, so a process killed
mid-write leaves the previous file whole. They survive a deploy and a restart
only when the data folder is a mounted volume.

| File | What it remembers | If it is missing | If it is there and cannot be believed |
| --- | --- | --- | --- |
| `recheck-queue.json` | who asked for a Chainlink re-check and which runner holds it (or `RECHECK_QUEUE_PATH`) | starts empty | starts empty, and logs why |
| `global-day.json` | today's count for each daily ceiling in `GLOBAL_*_PER_DAY` | counts today from zero | refused and logged: today's ceiling for every action reads as already reached until midnight UTC |
| `quota-generate.json`, `quota-edit.json`, `quota-unseal.json` | each creator's spends in the last 24 hours | counts from zero | refused and logged: every creator reads as having spent that allowance for 24 hours from the boot |
| `private-copy-kept.json` | when this service last kept each private copy, which the sweep ages copies by | no keeps, so the sweep uses Pinata's upload time | the same |
| `private-sweep-cursor.json` | where the hourly sweep stopped in the private listing | the sweep starts at the first page | the same |

A refused ceiling or allowance file writes that verdict back, so a second restart
the same day reaches the same answer and the next day starts clean. To reopen
early, delete the file and restart: that is an operator's choice, and it hands
out a second budget for the day.

At boot in production a data folder that cannot be written stops the service
with one line naming the folder. In development the service warns once and holds
everything in memory. A production host with neither `DATA_DIR` nor a volume
boots, and says once that its state will not outlive a deploy.

Still lost on every deploy, by design: the per-address rate-limit counts (one
minute long), the private-copy status and unseal miss memory (short caches), and
the development signing identity described above.

## The platform routes

`POST /platform/prepare`, `GET /platform/record/:handle`,
`POST /platform/sign/:handle` and `GET /platform/status/:handle` mount on a host
that has `PINATA_JWT`, `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, a signer that loads,
and a platform list in `src/platforms/platforms.json` whose every signature checks
out. A refused list turns all four off and logs why; it is never half loaded.

What they let through, set in `src/platform/stores.ts` and not yet in the
environment:

| Limit | Value | Kept in |
| --- | --- | --- |
| Prepares per platform key | 100 in a rolling 24 hours | `platform-quota.json` |
| Prepares for every platform together | 500 per UTC day | `platform-day.json` |
| PlatformPrepare nonces and pictures remembered | ten minutes after each `issuedAt`, at most 20,000 | `platform-nonces.json` |
| Frozen co-sign files per platform | 100 MiB in records still waiting | `platform-pending/` |

Each file is refused and fails closed the way the ceilings above are: a quota or
ceiling file that cannot be believed reads as spent, and a nonce file that cannot
be believed refuses every platform prepare for ten minutes.

`platform-pending/` holds one JSON record per co-sign, named by the sha256 of its
handle and never by the handle, with the four frozen files beside it. Nothing of a
co-sign picture is pinned until the person has opened the link and the agent has
signed. A record that fails its schema, or whose recomputed digest differs from the
one stored, is dropped and never repaired. Records and their files are removed a
day after their deadline. The folder is trusted as far as this process is: someone
who can write the volume and recomputes every digest could rewrite a waiting record.

Every window is read against the latest block's time: a PlatformPrepare is good for
ten minutes after its `issuedAt`, a co-sign link for 30 minutes before its person
opens it, and the fields for 30 minutes after that. A deploy while a co-sign is in
flight keeps it on the volume, but the person meets the short gap the one replica
has.

The three handle routes are mounted at log level `silent`, so no request line
carries a handle; their refusals are logged without the URL. A platform key is
never logged, stored or answered: the service keeps only its sha256, in the list.

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
   `loopback,uniquelocal,100.64.0.0/10,152.233.0.0/16`. The last range is where
   Railway's edge proxy connected from on 2026-09-13 (peers 152.233.15.x and
   152.233.68.x in the request log); the private ranges are there for a host
   that fronts the container itself. Validate it after every change: the
   request log's `remoteAddress` must be the caller's own address and not the
   proxy's, because a list that is too short puts every caller in one rate-limit
   bucket and a list that is too long lets a caller choose their own. Set `EXPECT_ROUTES=prepare,generate,edit` so a deploy that is
   missing a key stops at boot instead of serving a service with routes quietly
   switched off.
5. Port and health check path: neither guide covers how Railway picks the port or
   where the health check path is set. Check the dashboard. The container listens
   on 4010 and answers `GET /health`. If Railway injects its own port variable,
   set `VERIFIER_PORT` to the same number.
6. State: attach a volume to the service with its mount path at `/data`
   (Railway allows one per service). Railway then sets
   `RAILWAY_VOLUME_MOUNT_PATH=/data` itself, and the start script hands that
   folder to the `node` user at each start, so no other variable is needed. Do
   not set `RAILWAY_RUN_UID`. Keep the service at one replica: Railway refuses
   replicas on a service with a volume, and each deploy has a short gap while
   the old container lets go of the volume. The first boot on a new volume logs
   "no ceiling file at /data/global-day.json yet"; from then on a redeploy keeps
   the counts.
7. Watch paths are optional. Setting them to `packages/verifier/**` stops a web or
   docs commit from rebuilding this service.
8. Custom domain: not covered by those two guides. Check the dashboard.

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
7. State: Fly volumes were not part of the reading behind this page. Whatever
   folder a volume is mounted at, set `DATA_DIR` to it; the start script hands it
   to the `node` user. Without one, state lasts until the next deploy.

## The last step

Whichever host wins, the web app needs the deployed service URL once on Vercel,
as `NEXT_PUBLIC_VERIFIER_URL`: the browser calls `/verify` and `/prepare` on this
service directly, with no route of the app in between. A Vercel function cannot
take a 20 MB upload, so every image goes straight from the browser to this service.

That direct call is a cross-origin request, so the host must also carry
`CORS_ORIGINS` with the web app's exact origin in it, production and preview
domains included. Miss it and the studio fails in the browser with a CORS error
while curl against the same URL works perfectly.
