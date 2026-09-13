---
title: Verifier service
---

# Verifier service

`@moolam/verifier` takes any copy of an image and finds the passport it belongs to. It fingerprints
the picture three ways, tries all eight rotated and mirrored versions, searches the registered
passports by Hamming distance, and reads any C2PA manifest still attached. It also writes the
fingerprint into a C2PA manifest as a soft binding, which is the part that survives a re-upload.

It is a Fastify service. It never signs anything and it is not the authority on who made a picture:
it answers which passport a file matches, and the chain answers who signed that passport.

## Running it

```bash
npm install
npm run spike:verifier   # writes test images and a dev passport file
npm run dev:verifier     # starts the service on VERIFIER_PORT, default 4000
npm run test:verifier
npm run robustness
```

```bash
curl -s -F "file=@packages/verifier/test-assets/original.jpg" http://localhost:4000/verify
```

The passport index is read into memory rather than queried per request, because a Hamming search is
a full scan by design and rebuilding it per call would put a file read in front of every
verification. It is rebuilt in the background every `INDEX_REFRESH_MS`, a minute by default, so an
image registered a minute ago verifies without a redeploy, and a refresh that fails keeps the copy
already in hand.

## What lives in this package

Three modules moved here from `@moolam/agents` when the studio route was built, so the seed, the
generator agent and the studio all pin the same shapes through one implementation.

| Module | What it does |
| --- | --- |
| `src/prepare.ts` | Turns a raw picture into the C2PA signed JPEG, the fingerprint of those signed bytes, the sha256 of the manifest store, and the thumbnail. |
| `src/ipfs/pinata.ts` | Pins bytes and JSON to public IPFS through Pinata's v3 files endpoint, and turns an `ipfs://` reference into a gateway URL. |
| `src/metadata.ts` | Builds the document a passport's `metadataURI` points at, and the readable copy of the C2PA manifest that gets pinned beside the image. |

`@moolam/agents` re-exports the first two from their old paths, so nothing that imported them had to
change, and its seed reads the metadata builder from here directly.

## Endpoints

Full request and response shapes are in the [API reference](../api/verifier-endpoints).

| Route | What it does |
| --- | --- |
| `POST /verify` | Takes a multipart `file` upload or a JSON body of `{ "url": "..." }`, returns the matching passport and any manifest |
| `POST /verify/paid` | The same answer behind an x402 payment. Multipart upload only. Mounted only when `X402_ENABLED=true`, otherwise the path answers 404 |
| `POST /prepare` | The studio's backend. Takes a signed-in creator's image with their Privy access token in an `Authorization: Bearer` header, pins the image, its thumbnail, the manifest and the metadata, and returns the passport fields their browser signs. Mounted only when the host has both `PINATA_JWT` and `PRIVY_APP_ID` |
| `POST /generate` | The studio's other way in. Draws a picture from a signed-in creator's prompt, pins it, and returns the passport fields with the generator agent's signature already on them. Mounted only with an image model key, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` and `GENERATOR_WALLET_ID` on top of what `/prepare` needs |
| `POST /edit` | Appends an edited version of a passport for the owner, sent from their own wallet through the signer they granted. Mounted only with `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`, `PRIVY_EDIT_SIGNER_ID` and `PRIVY_EDIT_POLICY_ID` on top of what `/prepare` needs |
| `GET /health` | `{ ok, records, version, routes }`, where `records` is how many passports the index holds and `routes` lists what this host actually mounted |

Both verify routes read uploads, match and render their answer through the same shared code, so the
two cannot drift apart.

## The studio's backend

`POST /prepare` is the half of the studio that cannot run in a browser. A creator signs in with
Privy, picks a photo, and the file goes from their browser straight to this service rather than
through the web app, because a Vercel function cannot take a 20 MB upload.

That direct call is cross-origin, which is why `CORS_ORIGINS` exists, and it starts in a browser,
which is why the route checks a Privy access token instead of a shared secret. A secret shipped to a
browser is not a secret. The token is checked with `jose` against the app's published JWKS at
`auth.privy.io`, and it has to carry the issuer `privy.io`, name this app id in its audience, sit
inside its expiry and be signed with ES256. Naming the algorithm stops an `alg: none` style
downgrade, and the audience check is what stops another Privy app's tokens spending Moolam's pinning
account. Anything wrong with the token, a key set that cannot be fetched included, comes back as 401
and never as 500.

What the route does with the image: turns it the right way up, embeds the Moolam C2PA manifest,
fingerprints the signed bytes, builds the thumbnail the Chainlink verifier can fetch, pins the
image, the thumbnail, the manifest and the metadata to IPFS, and answers with the passport fields
and the four content ids. When the C2PA signer refuses the file, the upload is not lost: the
fingerprint and the on-chain record work without a manifest, so the answer comes back with
`manifest.embedded` false and the reason. The image bytes never come back, because the caller
already has them and the answer has to sit in a browser's memory next to the upload.

**Twenty prepares an hour per creator.** Every prepare spends four pins on Moolam's Pinata account
and about a second of CPU, so the cap is what stops one account draining the plan. It is counted on
the verified Privy user id, which a caller cannot choose, and falls back to the caller's address for
a caller with no valid token. This route's own limit replaces the global 60 a minute on this path.

**The same gate as matching.** The decode, the manifest and the thumbnail run behind the two-slot
concurrency gate `/verify` uses, so a burst of uploads queues instead of decoding all at once.

**No key that can write to the chain.** The browser adds its own wallet address and a deadline,
reads `hashPassport` from the registry, signs that with the creator's passkey and sends the
transaction itself. This service holds a Pinata token and nothing else.

The route is mounted only when the host has both `PINATA_JWT` and `PRIVY_APP_ID`. Without them the
service still verifies images, says once at boot that the studio side is off, and answers 404 on
that path. Full request and response shapes are in the
[API reference](../api/verifier-endpoints).

## Drawing a picture for a creator

`POST /generate` is the studio's second way in. A signed-in creator sends a prompt and a title, the
generator agent draws the picture, and the answer comes back with the agent's EIP-712 signature
already on the passport. The creator's browser adds their passkey signature over the same struct and
sends the transaction, so this route never holds a key that can write to the chain either.

The agent's key lives in a Privy enclave under a policy that allows one signature on one domain, the
Moolam registry's, so this service can ask for that and can do nothing else with the agent's wallet.

The order of work is what makes the answer safe to act on:

1. The token is checked and the day's allowance is taken, before a cent is spent.
2. The picture is drawn, with sixty seconds and no retry.
3. It is signed into a C2PA manifest carrying the soft binding, fingerprinted and pinned, four files
   the same as an upload.
4. Only then, over the final pinned bytes, does the agent sign.

The prompt is the only text that reaches the model. There is no wrapper around it, so nothing this
service says about itself can end up inside the manifest of a picture a creator then registers in
their own name.

**Three pictures a day per creator.** `GENERATE_PER_DAY`, counted on the verified Privy user id over
a rolling 24 hours, which is about nine cents of image model spend per account. A refused prompt and
a request that never got a drawing slot give the slot back. A model that failed part way keeps it,
because it may have drawn and been billed first, and so do a failed pin and a failed signature. The
count is held in this process's memory: a redeploy hands everyone a fresh day, and two copies of the
service would count separately. That is deliberate, and the alternative is a Redis this service does
not otherwise need.

**Two drawings at once.** The model call and the C2PA signing run behind the same shape of gate
`/verify` uses. Pinning and signing happen outside it, because they are network waits holding nothing
heavy in memory. A caller who would queue longer than 90 seconds is told the agent is busy rather
than having a connection held open on nothing.

## Appending an edit for an owner

`POST /edit` is the one route here that sends a transaction, and it sends it from somebody else's
wallet on purpose.

The owner grants this app a signer on their own Privy wallet, scoped by a policy that allows
`appendEdit` on the Moolam registry and nothing else. The browser then uploads the edited picture and
this service does the rest: prepare and pin the way `/prepare` does, build the child passport that
points at the parent, and send `appendEdit` from the owner's wallet with the app's authorization key,
gas sponsored by Privy. The owner stays the sender on chain, which is what the registry requires, and
this service never holds a key that could move their money.

Two things a caller cannot assert. The wallet comes from the Privy user record rather than from the
request, and the ownership of the parent is read from the chain before anything is spent.

The signer is checked against both ids, not one. The service looks for its own
`PRIVY_EDIT_SIGNER_ID` among the signers on that wallet, and refuses the edit unless that signer
carries `PRIVY_EDIT_POLICY_ID`. A grant made without the policy is turned down with the same answer
as no grant at all, because a signer with no policy on it could do more than append an edit, and this
route promises it cannot.

The call is estimated against current state before anything is broadcast, so a registry that would
refuse the edit refuses it while nothing has been signed or spent, and the revert name comes back
with the answer. `EDITS_PER_DAY`, five by default, caps how many one creator may append in a rolling
24 hours, on the same counter shape as the drawing allowance.

## The limits, and why each one exists

**20 MB per upload.** Big enough for a camera original, small enough that a flood cannot exhaust
memory. Enforced on the multipart part and again chunk by chunk while a remote body streams in,
because a `Content-Length` header is a claim by the remote server and not a fact.

**40 megapixels.** Refused with 413 before a single pixel is decoded, because a 572 KB JPEG can
unpack to 100 megapixels.

**Two concurrent matches.** Matching decodes the picture nine times over, so the rate limit alone
does not bound memory: sixty large uploads inside one minute would all decode at once. A third
caller parks on a promise and is woken by whichever match finishes next.

**60 requests a minute.** Counted per caller. The service sits behind Railway's proxy, so the
address comes from the forwarded header: read off the socket, every caller would share one bucket
and the sixty-first request from anyone would refuse everyone. `TRUST_PROXY` names the hops that may
be believed, as addresses or CIDR ranges. It is never `true` and never a hop count, because Fastify
reads `true` as the leftmost forwarded entry and that entry is written by the caller, who would then
pick their own bucket. Every rejection is logged with its reason. `/prepare` is the one path this
does not cover, because its own per-creator limit takes its place.

**10 second fetch timeout** on the URL form.

An upload whose bytes are already registered is answered from the sha256 alone, without building
the eight rotated copies.

## The fetch guard

A URL is checked before every connection and again after every redirect. The address is normalised
first, so `127.0.0.1`, `0x7f000001`, `2130706433` and `[::ffff:127.0.0.1]` are all recognised as
loopback. Private, link-local, unique-local, carrier-grade NAT, multicast, reserved and cloud
metadata addresses are all refused with 403. The connection is then pinned to the addresses that
were checked, so a name that answers differently the second time fails the connection instead of
reaching an internal service.

The paid route does not accept a URL at all. The free route carries those checks, and rather than
copy them and risk two copies drifting apart, the paid route takes bytes only.

## Selling a verification over x402

`POST /verify/paid` is the same answer as `/verify`, sold for 5 cents of USDC on Monad mainnet and
settled by the facilitator Monad runs at `https://x402-facilitator.molandak.org`. It exists for the
caller with no account and no invoice: an agent that needs one answer, pays for it in the same round
trip, and moves on.

Turning it on takes two variables on the host and nothing else:

```bash
X402_ENABLED=true
X402_PAY_TO_ADDRESS=0x...   # the wallet the USDC goes to
```

Both have to be set together. The service refuses to boot with `X402_ENABLED=true` and no address to
pay, checked once in the environment schema and again when the payment server is built, because a
payment route with no recipient must never mount. Until then the path answers 404 and the free route
is unaffected. `X402_PRICE` defaults to `$0.05` and `X402_FACILITATOR_URL` to Monad's facilitator.

The paying side is `npm run pay:verify` in `packages/agents`: it reads the terms out of the 402, signs
an EIP-3009 `transferWithAuthorization` for USDC, sends the image with the payment, and prints the
settlement transaction next to the verification. It reads `X402_PAYER_PRIVATE_KEY` and
`X402_VERIFIER_URL` from the repo root `.env`. That wallet needs USDC and no MON: the facilitator
pays the settlement gas itself. The exact command and what it prints are in the
[API reference](../api/verifier-endpoints).

Nobody is charged for an answer they did not get. The payment is settled only after the match
succeeds, and a failure after the payment was checked cancels the authorisation. The one case that
is not black and white is a settlement the facilitator has broadcast but not yet seen confirmed: the
service asks a second time, then answers with the verification and a receipt that says pending,
because that transfer cannot be replayed for a different amount and the facilitator will finish it.

## Configuration

Every variable is checked at boot and a bad value names itself, so `VERIFIER_PORT=abc` stops the
service before it listens rather than after.

| Variable | Meaning |
| --- | --- |
| `VERIFIER_PORT` | Port to listen on, default 4000 |
| `PASSPORT_SOURCE` | `json` for a local file, `envio` to read the indexer. Default `json` |
| `PASSPORT_SOURCE_PATH` | The JSON passport file, default `test-assets/passports.json` |
| `ENVIO_GRAPHQL_URL` | The Envio GraphQL endpoint, required when `PASSPORT_SOURCE=envio` |
| `MOOLAM_C2PA_CERT_PATH` | Signing certificate chain, optional, set with the key |
| `MOOLAM_C2PA_KEY_PATH` | Signing key, optional, set with the certificate |
| `MONAD_MAINNET_RPC_URL` | Where the reputation writer reads and sends, default `https://rpc.monad.xyz` |
| `VERIFIER_PRIVATE_KEY` | The wallet that signs reputation feedback, never the agent owner's |
| `VERIFIER_ADDRESS` | That wallet's address, the client a summary is read for |
| `VERIFIER_BASE_URL` | The public URL of this service, used as the feedback endpoint |
| `X402_ENABLED` | `true` mounts the paid route, `false` (the default) leaves it off. Set this and the address together |
| `X402_PAY_TO_ADDRESS` | Who the USDC goes to, required when `X402_ENABLED` is true |
| `X402_PRICE` | Price per paid verification, default `$0.05` |
| `X402_FACILITATOR_URL` | Default `https://x402-facilitator.molandak.org`, Monad's facilitator |
| `PINATA_JWT` | The token `/prepare` pins with. An API key made at app.pinata.cloud, the JWT it shows once. It spends a plan, so treat it as a spending secret |
| `PINATA_GATEWAY_URL` | This Pinata account's dedicated gateway, ending in `/ipfs/`. Defaults to the public one, which rate-limits a busy address |
| `PRIVY_APP_ID` | The app id from dashboard.privy.io, the same app the web app signs users in with. `/prepare`, `/generate` and `/edit` accept that app's access tokens and no other's |
| `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` | The server side credentials `/generate` and `/edit` act with. Spending secrets, both |
| `OPENAI_API_KEY` or `OPENROUTER_API_KEY` | What `/generate` draws with. Either one turns the route on |
| `AGENT_IMAGE_MODEL`, `AGENT_IMAGE_BASE_URL` | Which image model, and where it lives. Both optional |
| `GENERATOR_WALLET_ID`, `GENERATOR_WALLET_ADDRESS` | The agent's Privy server wallet, created by the agent scripts and recorded in `packages/agents/.moolam/wallets.json` |
| `GENERATOR_AGENT_ID` | The ERC-8004 id that wallet owns, default `10249`. It goes inside every passport `/generate` signs |
| `GENERATE_PER_DAY` | Pictures per creator in a rolling 24 hours, default 3 |
| `PRIVY_EDIT_SIGNER_ID` | The key quorum `/edit` signs with, whose one member is the public half of `PRIVY_AUTHORIZATION_KEY`. The browser names the same id when it asks for the grant |
| `PRIVY_EDIT_POLICY_ID` | The policy that quorum is held to: `appendEdit` on the Moolam registry, no MON, nothing else. A signer without it is refused |
| `EDITS_PER_DAY` | Edits per creator in a rolling 24 hours, default 5 |
| `MOOLAM_REGISTRY_ADDRESS` | The registry the agent's signature is bound to and `/edit` sends to. Defaults to the mainnet deployment |
| `CORS_ORIGINS` | Comma separated exact origins allowed to call this service from a browser, such as `https://moolam.app,http://localhost:3000`. No wildcard, no path, no trailing slash |
| `PRIVY_JWKS_OVERRIDE_PATH` | A local JWKS file for tests that sign their own tokens. Refused when `NODE_ENV` is production, because anyone holding that key could then mint tokens this service accepts |

The certificate and the key are one identity, so the two paths are set together or not at all.
Setting one alone stops the service at boot rather than pairing a real certificate with the
development key, which would produce manifests no reader can verify.

On first run the C2PA package generates its own throwaway ES256 chain into `test-assets/certs/`
with openssl, because the npm package of `@contentauth/c2pa-node` ships only `dist`, `scripts` and
`src` and the test certificates in its GitHub repository are not installed with it. Manifests
signed with it read back as `signingCredential.untrusted`, which is correct: it is not on the
public C2PA trust list.

## Writing the result back as reputation

A verification is worth something to the next person only if it is recorded where they will look.
Moolam writes each outcome to the ERC-8004 Reputation Registry on Monad mainnet at
`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, as feedback about the agent that generated the image.

```bash
npm run reputation:post -- --passport 0x59bd...4440 --matched --distance 1
```

The script reads the passport from the Moolam registry to find the generator agent and the metadata
URI, and prints the registry's summary before and after. The score is
`round(100 * (1 - distance / 11))`, so an exact fingerprint scores 100, 1 bit scores 91, and 10
bits, the widest distance that still counts as a match, scores 9. A mismatch is 0. The two tags are
`moolam` and `verification`, `feedbackURI` points at the passport's metadata, and `feedbackHash` is
the keccak256 of the small JSON summary the script prints, so anyone can recompute it.

Two facts about the deployed registry decided that design, both checked against the live contract
rather than the specification. It has no feedback authorisation: `giveFeedback` takes eight plain
arguments and no signature. And it refuses feedback from the agent's owner, which is what makes the
record worth reading, so the verifier signs with its own wallet and never the deployer's. One post
costs about 313,000 gas, and Monad charges the gas limit, so roughly 0.032 MON at the price paid.
