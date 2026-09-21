# @moolam/verifier

Takes any copy of an image and finds the passport it belongs to. It fingerprints
the picture three ways (the exact sha256 of the bytes, a 64-bit pHash, a 256-bit
blockhash), tries all eight rotated and mirrored versions of it, searches the
registered passports by Hamming distance, and reads any C2PA manifest still
attached. It also writes the fingerprint into a C2PA manifest as a soft binding,
which is the part that survives a re-upload.

## Why the fingerprint has to be in the manifest

A C2PA hard binding is a hash of the exact bytes, so it breaks the first time a
platform recompresses the file. The C2PA 2.1 spec has an answer for that in
section 18.9: a soft binding, computed from the picture rather than the bits.
`embedManifest` requires one and writes it as a `c2pa.soft-binding` assertion
under the algorithm name `com.moolam.phash-blockhash.v1`: eight bytes of
big-endian pHash then 32 bytes of blockhash, in one CBOR byte string. Strip the
manifest and the fingerprint still matches against the on-chain registry, which
is exactly the case the spec describes when it says a manifest held in a
provenance store elsewhere can be reunited with its asset through a soft binding.

## Running it

```sh
npm install
npm run spike:verifier   # writes test images and a dev passport file
npm run dev:verifier     # starts the service on VERIFIER_PORT, default 4000
npm run test:verifier
npm run robustness
```

## Endpoints

`POST /verify` takes either a multipart upload in a field named `file` or a JSON
body of `{ "url": "https://..." }`. Both are capped at 20 MB, and a URL is
fetched server-side with a 10 second timeout and the same cap enforced while the
body streams in. It answers with `{ result, manifest }`. The 64-bit pHash goes
out as a decimal string, never a JSON number, because a double cannot hold it.

Every match in that answer carries `consent`: what the picture's holder has
stated about AI use, read live from the MoolamConsent contract on Monad mainnet
at `CONSENT_ADDRESS`. That is the whole lookup an AI company needs, from a copy
of the pixels with the metadata stripped to the creator's own words and the day
they wrote them.

```ts
{ source: "chain", stated: true, standard: "cawg.training-mining/1.1",
  aiTraining, aiGenerativeTraining, aiInference, dataMining,   // each one of
  //   "unspecified" | "allowed" | "notAllowed" | "constrained"
  constraintInfo?, at, writer }                // unix seconds, and who wrote it
{ source: "chain", stated: false }             // the holder has never spoken
{ source: "unavailable" }                      // we could not find out
```

The three sources say three different things. `chain` with `stated: true` is the
holder's own word from the register; `chain` with `stated: false` is the contract
saying they have never spoken for that passport; `unavailable` is this service
saying the read failed or ran past its five second limit, and it is never
permission. Per the CAWG 1.1 standard these words come from, a reader with no way
to reach the creator treats `constrained` the same as `notAllowed`, and a field
left `unspecified` is not permission either.

A failed read never fails a verification: the match is what the caller came for.
At most two passports are read per verification, the exact match and the best
match when they differ, and each answer is held for 60 seconds against a cap of
2,000 passports, so a flood of unknown pictures cannot grow this process without
limit. `constraintInfo` comes back exactly as the chain holds it and is dropped
if it is not within the 256 printable ASCII bytes the contract promises, because
this answer is input to other people's parsers.

The same matches carry `dispute`, read from the registry's own dispute view at
`MOOLAM_REGISTRY_ADDRESS`, under the same limits and the same memory.

```ts
{ source: "chain", status: "none" }        // nobody has challenged this passport
{ source: "chain", status: "open" }        // a challenge is open and unsettled
{ source: "chain", status: "upheld" }      // the challenge stood: the record is marked disputed
{ source: "chain", status: "rejected" }    // the challenge was settled against the challenger
{ source: "unavailable" }                  // we could not find out
```

The two fields are read together. A statement on a passport whose dispute is
`open` or `upheld` should not be relied on: the registry's own design says the
record behind it is in question, so the holder's word about AI use is in question
with it. `unavailable` is never a clean record, and the chain is read rather than
the passport index because a dispute opened a minute ago is exactly the one a
reader must not miss.

The same matches carry `recheck`: what has independently re-checked this picture
since it was registered. A Chainlink CRE workflow fetches the picture from the
address pinned in its passport, recomputes the fingerprint in the sandbox and
writes the verdict to the receiver contract on Monad. The verdicts on chain today
come from that workflow run through the CRE simulator, which proves the workflow
and the receiver's checks but not a run on Chainlink's live network with node
consensus; `proofs/rechecks.txt` records every one of them with its transaction.

```ts
{ source: "index", attestations: 2, matched: 2, mismatched: 0,
  latest: { matched: true, distance: 1, at: 1789700000, receiver: "0x0d69..." } }
{ source: "index", attestations: 0 }   // nothing has re-checked this picture yet
{ source: "unavailable" }              // we cannot tell you
```

`attestations` is how many verdicts the index holds for the passport, `matched`
and `mismatched` how they fell, and `latest` is the newest one: whether the
recomputed fingerprint matched, how many bits apart it was, the unix second it
was written and the receiver contract it was written to. `unavailable` means the
re-check data did not reach this service or did not survive its checks, and it is
never the same answer as `attestations: 0`.

This fact comes from the passport records the match itself ran against, so it
costs no chain read and no extra request per verification, and it is exactly as
fresh as the last index rebuild (`INDEX_REFRESH_MS`, 60 seconds by default).
A count and a verdict that disagree are never reconciled into a half answer: the
whole fact goes out `unavailable` instead.

Three limits protect the service from a file that is small on disk and huge once
decoded. Anything over 40 megapixels is refused with 413 before a single pixel
is decoded, because a 572 KB JPEG can unpack to 100 megapixels. Only two matches
run at a time; a third caller waits, so a burst cannot hold nine decodes each in
memory at once. And an upload whose bytes are already registered is answered
from the sha256 alone, without building the eight rotated copies.

A URL is checked before every connection and again after every redirect. The
address is normalised first, so `127.0.0.1`, `0x7f000001`, `2130706433` and
`[::ffff:127.0.0.1]` are all recognised as loopback, and private, link-local,
unique-local, carrier-grade NAT, multicast, reserved and cloud metadata
addresses are all refused with 403. The connection is then pinned to the
addresses that were checked, so a name that answers differently the second time
fails the connection instead of reaching an internal service.

```sh
curl -s -F "file=@packages/verifier/test-assets/original.jpg" http://localhost:4000/verify
```

`GET /health` answers `{ ok, records, version }`, where `records` is how many
passports the index is holding.

`POST /prepare` is the studio's backend. A signed-in creator's browser sends the
image straight here, with their Privy access token in an `Authorization: Bearer`
header, two text fields, `title` and `kind` (`human` for now), and an optional
`training` field. The service
turns the picture the right way up, embeds the Moolam C2PA manifest, fingerprints
the signed bytes, builds the thumbnail, pins the image, the thumbnail, the
manifest and the metadata to IPFS, and answers with the passport fields plus the
four content ids. The browser adds its own wallet address and deadline, reads
`hashPassport` from the registry, signs that with the creator's passkey and sends
the transaction itself, so this service never holds a key that can write to the
chain, and it never sends the image bytes back.

```sh
curl -s -X POST http://localhost:4000/prepare \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -F "file=@photo.jpg" -F "title=Monsoon fishing nets" -F "kind=human" \
  -F 'training={"aiGenerativeTraining":"notAllowed"}'
```

`training` is how the creator says whether AI may use the picture: a JSON object
with any of `aiTraining`, `aiGenerativeTraining`, `aiInference` and `dataMining`,
each `allowed`, `notAllowed` or `constrained`, plus `constraintInfo` (at most 256
bytes of printable ASCII) saying how to ask when a choice is constrained. What
the creator says is written into the signed manifest as one `cawg.training-mining`
assertion and into the pinned metadata, so it travels inside the file and sits
under the passkey signature that covers the metadata address. A choice left out
says nothing at all, which is not the same as allowing it.

It answers 401 for a missing, expired or foreign token, 400 for a bad title, kind
or training statement, 413 over the 20 MB or 40 megapixel limits, 415 for a file
that is not an image, 429 past 20 prepares an hour for one creator, and 502 with
`pin-failed` when Pinata refuses. The route is mounted only when the host has both
`PINATA_JWT` and `PRIVY_APP_ID`; without them the service still verifies images
and says once at boot that the studio side is off.

`POST /generate` is the same thing for a picture the creator did not take. A
signed-in creator sends a prompt, a title, their wallet address, a deadline and
the same optional `training` statement as JSON, with their Privy access token in
the same `Authorization: Bearer` header.
The generator agent draws the picture with the image model, the service prepares
and pins it exactly as `/prepare` does, and then the agent signs the generator
half of the passport with its own wallet. That key lives in a Privy enclave under
a policy that allows one thing, an EIP-712 `Passport` signature on the Moolam
registry's domain, so a break-in here still cannot move the agent's money or sign
for another app. The browser adds the creator's passkey signature over the same
struct and sends one sponsored transaction.

```sh
curl -s -X POST http://localhost:4010/generate \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A lighthouse in a monsoon storm, thick oils","title":"Lighthouse","creator":"0xYourEmbeddedWallet","deadline":1788878000,"training":{"aiGenerativeTraining":"notAllowed"}}'
```

`training` follows the same rules as on `/prepare`, and it is written into the
manifest and the pinned metadata before the agent signs, so the statement is
inside both signatures rather than beside them.

`creator` is your own embedded wallet address, the one Privy shows in the studio.
The service reads the caller's wallets from their Privy user record and refuses
any other address with 403 `creator-mismatch`, so nobody can have the agent
co-sign a passport that credits someone else.

It answers with the passport fields, `generatorSig`, the four content ids, the
model that drew it, the agent's id and wallet, and what is left of the caller's
daily allowance. The prompt is the only text that reaches the model, so nothing
this service says about itself can end up inside a manifest. The agent signs last,
over the bytes that were actually pinned, so a mismatch reverts on chain instead
of binding a signature to a different picture.

Order of refusals: 401 for a missing, expired or foreign token, 400 for a prompt
outside 8 to 600 characters, a title outside 1 to 120, a creator that is not an
address, a deadline that is not between 10 minutes and 2 hours ahead, or a
training statement the standard has no room for, 400
`prompt-refused` with the provider's own words when the model's safety system
turns the prompt down, 400 `deadline-passed` when drawing and pinning ate so much
of the window that under two minutes are left to answer a passkey prompt, 403
`creator-mismatch` when the creator is not one of the caller's own wallets, 429
`quota` past `GENERATE_PER_DAY` pictures in a rolling 24 hours, 502
`model-failed`, `pin-failed` or `sign-failed` for the three outside services, and
503 `busy` when both drawing slots have been full for 90 seconds. The token is
checked, the creator is matched and the allowance is taken before a cent is
spent, and a picture the provider never drew gives its allowance back.

The allowance is counted in this process's memory against the verified Privy user
id, which a caller cannot choose. It is gone on a restart and two copies of the
service count separately, which is a deliberate trade: the worst case is a few
extra cents of image spend, and the alternative is a Redis this service does not
otherwise need.

`POST /edit` appends an edited version of a passport the caller already owns, and
it is the one route here that writes to the chain. The creator's browser sends
the edited picture with their Privy access token and three fields, `title`,
`parentId` (the parent passport id) and `note` (up to 280 characters saying what
changed). The service prepares and pins the picture exactly as `/prepare` does,
with `c2pa.edited` as the action, builds the child passport that points at the
parent, and sends `appendEdit` from the creator's own wallet.

It can do that because the creator granted this app a signer on their wallet in
the browser, scoped by a Privy policy that allows one function on one contract.
The wallet is read from the Privy user record and never from the request, the
ownership check is read from the chain, and Privy sponsors the gas, so the
creator signs nothing and pays nothing. Revoking the signer in the app ends it.

```sh
curl -s -X POST http://localhost:4010/edit \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -F "file=@edited.jpg" -F "title=Monsoon nets, brightened" \
  -F "parentId=0x59bd...4440" -F "note=brightened the sky"
```

It answers with the child passport, its token id, the transaction hash, whether
Privy sponsored it, the four content ids and what is left of the daily
allowance. Order of refusals: 401 for a missing, expired or foreign token, 400
for the fields, 413 and 415 for the image, 404 `no-parent` when the registry
does not hold that parent, 409 `no-signer` when the creator has granted nothing
this app can use under the edit policy, 403 `not-owner` when the parent belongs
to another address, 429 `quota` past `EDITS_PER_DAY` in a rolling 24 hours, 502
`pin-failed`, `sign-failed` or `send-failed`, and 503 `busy` when both slots have
been full for 90 seconds. A `send-failed` carries the registry's own error name
in `reason`, because the call is run against current state before Privy is asked
to sign: a refused edit costs nothing and says which rule refused it.

Browsers are only allowed to call any of this from an origin named in
`CORS_ORIGINS`. Anything else gets no allow header back, which the browser turns
into a refusal.

`POST /verify/paid` is the same answer behind an x402 payment: 5 cents in USDC
on Monad mainnet, settled by Monad's facilitator, and the same `consent` and
`dispute` fields beside every match. It only exists when
`X402_ENABLED=true`, and otherwise the path returns 404. Without a payment it
answers 402, the terms ride in the base64 `PAYMENT-REQUIRED` header, and the JSON
body says in words what to do next. It takes a multipart `file` upload only,
because a paid caller already has the bytes; the free route is the one that also
accepts a remote URL. Both routes read uploads, match and render their answer
through the same shared code, so the two cannot drift apart.

Two variables turn it on, and they are set together: `X402_ENABLED=true` and
`X402_PAY_TO_ADDRESS`, the wallet that collects. One without the other stops the
boot and names the missing one, because a payment route with no recipient must
never mount. The price is `X402_PRICE`, written as a dollar amount, default
`$0.05`. This service never holds a key for any of it: the payer signs a USDC
transfer authorisation and the facilitator submits it and pays the gas.

Payment is settled only after the match succeeds, so a failed verification never
charges. If the facilitator answers that a settlement is broadcast but not yet
confirmed, the route asks once more five seconds later and then answers with the
verification and a receipt that says pending, because that authorisation cannot
be replayed for a different amount and the facilitator will finish it.

`npm run pay:verify` in `packages/agents` is the paying side, one command a judge
can run: it reads the terms, signs the transfer, sends the image and prints the
settlement transaction next to the verification. It reads
`X402_PAYER_PRIVATE_KEY` and `X402_VERIFIER_URL` from the repo root `.env`, and
that wallet needs USDC and no MON, because the facilitator pays the settlement
gas.

Every caller gets 60 requests a minute, counted on the socket address so nobody
can pick their own bucket by sending a header. `GET /health` is the one route
outside the count: a probe that could be refused would read as an outage to the
status footer and to uptime monitors, and it costs microseconds to answer. Every
rejection is logged with its reason. Unknown routes answer with JSON, not HTML.

## Registering a picture without publishing it

A creator can register a picture and keep it. Send `sealed=true` as a field on
`/prepare`, or `"sealed": true` in the `/generate` body, and the service does
everything it normally does up to and including signing the C2PA manifest into
the file, and then stops. It pins no image, no thumbnail and no manifest
document, and writes nothing to disk. One small metadata file goes to IPFS, and
the signed picture comes back inside the answer, base64, under `signedFile`.
That is the only copy of it there will be.

```sh
curl -s -X POST http://localhost:4000/prepare \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -F "file=@photo.jpg" -F "title=Monsoon fishing nets" -F "kind=human" \
  -F "sealed=true"
```

The chain still commits to the exact bytes, because the passport id is the
sha256 of the signed file. `signedFile.sha256` is that hash, and the browser
checks it against `passport.exactHash` before it opens the passkey prompt: a
creator who does not hold the file could never unseal the passport.

What becomes public is what the pinned document says and nothing else: the
title, the two fingerprints, the date, the AI use statement, the generator agent
for a drawn picture, and the fact that it is sealed. A strict schema builds that
document and refuses it if it carries an `image`, a `thumbnail`, a `manifest` or
any key nobody described, so a later convenience cannot quietly add a pin. The
prompt of a generated picture is left out unless the request says
`"includePrompt": true`, because a prompt describes the picture in words.

Every answer to a sealed request carries `Cache-Control: no-store`, refusals
included, and no log line or error body carries the file or its base64. The
answer also says whether the manifest went into the file, in the same
`manifest: { embedded }` words the public path uses, because the copy the creator
receives is the only one they will get. If this service ever builds a record that
does not fit the sealed shape it answers 500 `sealed-metadata-refused`, pins
nothing and keeps the detail in its log, rather than publishing a document nobody
described. At the 20 MB upload limit the answer is about 26.7 MB of JSON, which
Fastify serialises in roughly 90 ms.

Two things this does not do. It does not hide a generated picture from the model
provider that drew it, because that provider made the picture. It does not stop
someone who already holds a copy from publishing it; what it gives you there is
a hash that makes every copy checkable. Unsealing, which publishes the picture
later, is a separate route and is not built yet.

## Which way up

A photo taken sideways stores its pixels rotated and leaves an EXIF tag saying
which way up it goes. Moolam applies that tag once and both perceptual hashes
read the same upright picture, so the same photo cannot get two fingerprints
depending on who honoured the tag. Hashing the stored bytes instead put the
blockhash of a tagged photo 112 of 256 bits away from its turned copy, far past
the matching threshold of 40. The agent side does the same thing earlier: the
rotation is baked into the pixels before the C2PA manifest is signed, so the
registered file, its fingerprint, the thumbnail and the hash the Chainlink
workflow recomputes all describe one picture the same way up.

## Confidence, in one sentence

An exact sha256 hit scores 1, and everything else scores
`0.99 * (0.6 * (1 - phashDistance / 11) + 0.4 * (1 - blockhashDistance / 41))`,
so each hash is measured against its own threshold, the steadier pHash counts for
more, a perceptual match never claims to be as certain as identical bytes, and
anything past either threshold is not a match at all and scores 0.

## What survives and what does not

Measured over 24 images and 15 transforms, 360 copies in all. Full table in
`proofs/robustness.txt`, regenerate it with `npm run robustness`.

| holds up | breaks |
| --- | --- |
| resize to 50, 25 and 10 percent | crop 10 percent: 0 of 24 |
| re-encode at quality 60 and 30 | crop 25 percent: 0 of 24 |
| rotation by 90 and 180, and mirroring | watermark bar across the image: 7 of 24 |
| screenshot, two rounds of social resizing | any C2PA manifest, through every transform |
| metadata stripped entirely | |

Rotation and mirroring only match because the verifier fingerprints all eight
symmetries of the query. A single direct lookup catches none of them: it scores 0
percent on all three.

Three honest notes on the numbers:

- **Cropping is the real hole.** Cutting 10 percent off each edge moves the pHash
  about 22 bits of 64. That is not a threshold we can widen; at that distance
  genuinely different pictures start colliding. Catching crops needs a different
  technique, such as keypoint matching, and we have not built it.
- **The blockhash is what fails first, not the pHash.** The single image that
  missed a plain quality-60 re-encode scored 2 of 64 on pHash and 42 of 256 on
  blockhash, just past the limit of 40. Requiring both hashes to agree is what
  keeps false positives at zero, and this is the price of that.
- **False positives were zero** across all 360 copies checked against all 23
  other originals each. That is a clean result, but on a synthetic corpus of 24
  images, which is a much easier test than a registry of millions.

## Writing the result back as reputation

A verification is worth something to the next person only if it is recorded
where they will look. Moolam writes each outcome to the ERC-8004 Reputation
Registry on Monad mainnet at `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, as
feedback about the agent that generated the image.

```sh
npm run reputation:post -- --passport 0x59bd...4440 --matched --distance 1
```

The script reads the passport from the Moolam registry to find the generator
agent and the metadata URI, prints the registry's summary before and after, and
saves the whole run to `proofs/reputation.txt`. The score is
`round(100 * (1 - distance / 11))`, so an exact fingerprint scores 100, 1 bit
scores 91, and 10 bits, the widest distance that still counts as a match, scores
9. A mismatch is 0. The two tags are `moolam` and `verification`, `feedbackURI`
points at the passport's metadata, and `feedbackHash` is the keccak256 of the
small JSON summary the script prints, so anyone can recompute it.

Two facts about the deployed registry decided the design, both checked against
the live contract rather than the specification. It has no feedback
authorisation: `giveFeedback` takes eight plain arguments and no signature. And
it refuses feedback from the agent's owner, which is what makes the record worth
reading, so the verifier signs with its own wallet and never the deployer's. One
post costs about 313,000 gas, and Monad charges the gas limit, so roughly 0.032
MON at the price we paid.

## Using a real corpus

The generated images are reproducible, not realistic: clean edges and even grain
flatter a perceptual hash. Put 10 or more real `.jpg` or `.png` files in
`corpus/` and `npm run robustness` uses them instead and says so in its first
lines. See `corpus/README.md`. The image files are gitignored.

## Configuration

| variable | meaning |
| --- | --- |
| `VERIFIER_PORT` | port to listen on, default 4000 |
| `PASSPORT_SOURCE` | `json` for a local file, `envio` to read the indexer |
| `PASSPORT_SOURCE_PATH` | the JSON passport file, default `test-assets/passports.json` |
| `ENVIO_GRAPHQL_URL` | the Envio GraphQL endpoint, required when `PASSPORT_SOURCE=envio` |
| `MOOLAM_C2PA_CERT_PATH` | signing certificate chain, optional, set with the key |
| `MOOLAM_C2PA_KEY_PATH` | signing key, optional, set with the certificate |
| `MONAD_MAINNET_RPC_URL` | the endpoint every read and send is tried on first, default `https://rpc.monad.xyz`. A dedicated endpoint belongs here |
| `MONAD_RPC_FALLBACK_URL` | the endpoint that picks up whatever the first one drops, default `https://rpc.monad.xyz`. Set to the same address as the first and there is no fallback, which is the default |
| `VERIFIER_PRIVATE_KEY` | the wallet that signs reputation feedback, never the agent owner's |
| `VERIFIER_ADDRESS` | that wallet's address, the client a summary is read for |
| `VERIFIER_BASE_URL` | the public URL of this service, used as the feedback endpoint |
| `X402_ENABLED` | `true` mounts the paid route, `false` (the default) leaves it off |
| `X402_PAY_TO_ADDRESS` | who the USDC goes to, required when `X402_ENABLED` is true |
| `X402_PRICE` | price per paid verification as a dollar amount, default `$0.05`. A bare `0.05` fails the boot |
| `X402_FACILITATOR_URL` | default `https://x402-facilitator.molandak.org`, Monad's facilitator |
| `PINATA_JWT` | the Pinata API token `/prepare` pins with, from app.pinata.cloud |
| `PINATA_GATEWAY_URL` | this account's dedicated IPFS gateway, default the public one |
| `PRIVY_APP_ID` | the Privy app whose access tokens `/prepare` and `/generate` accept |
| `CORS_ORIGINS` | comma separated exact origins allowed to call this service from a browser |
| `PRIVY_APP_SECRET` | that app's secret, from the same dashboard page. `/generate` only |
| `PRIVY_AUTHORIZATION_KEY` | the authorization key that owns the agent's server wallet, so the enclave will sign for it |
| `GENERATOR_WALLET_ID` | the Privy wallet id of the generator agent, recorded by `npm run prove:privy` in `packages/agents/.moolam/wallets.json` |
| `GENERATOR_WALLET_ADDRESS` | that wallet's address, optional. Left unset it is read from Privy once; set, it is checked against Privy and a mismatch stops the signing |
| `GENERATOR_AGENT_ID` | the agent's ERC-8004 identity, default `10249`, the id `wallets.json` records next to the wallet |
| `MOOLAM_REGISTRY_ADDRESS` | the registry the generator signs against, default the deployed `0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0`. Change it only after a redeploy |
| `CONSENT_ADDRESS` | the consent register `/verify` reads statements from, default the deployed `0x1151E69a82947920546e779c4C8c785b2a3C1277`. Change it only after a redeploy |
| `OPENAI_API_KEY` | the image model key from platform.openai.com. This is spending money, so treat it like the Pinata token |
| `OPENROUTER_API_KEY` | used instead when there is no OpenAI key. Set `AGENT_IMAGE_MODEL` to the vendor-prefixed name as well |
| `AGENT_IMAGE_MODEL` | which model draws, default `gpt-image-1-mini` |
| `AGENT_IMAGE_BASE_URL` | a different endpoint for that model, optional |
| `GENERATE_PER_DAY` | how many pictures one creator may have drawn in 24 hours, default 3 |
| `PRIVY_EDIT_SIGNER_ID` | the key quorum the creator grants on their wallet for `/edit`. Its member is the public half of `PRIVY_AUTHORIZATION_KEY`, which is how this service signs as that signer. The id comes from `npm run edit:quorum` in `packages/agents`, which creates that quorum once and writes the id into the root `.env` |
| `PRIVY_EDIT_POLICY_ID` | the policy that quorum is held to: `appendEdit` on the Moolam registry, no MON, nothing else. A wallet that granted the signer without this policy is refused |
| `EDITS_PER_DAY` | how many edits one creator may append in 24 hours, default 5 |

All of it is checked at boot and a bad value names itself, so
`VERIFIER_PORT=abc` stops the service before it listens rather than after.

The certificate and the key are one identity, so `MOOLAM_C2PA_CERT_PATH` and
`MOOLAM_C2PA_KEY_PATH` are set together or not at all. Setting one alone stops
the service at boot rather than pairing a real certificate with the development
key, which would produce manifests no reader can verify.

Signing certificate: the npm package of `@contentauth/c2pa-node` ships only
`dist`, `scripts` and `src`, so the test certificates in its GitHub repository
are not installed with it. On first run the package generates its own throwaway
ES256 chain (a root plus a signer) into `test-assets/certs/` with openssl.
Manifests signed with it read back as `signingCredential.untrusted`, which is
correct: it is not on the public C2PA trust list. Point the two paths above at a
real certificate and key to sign with a trusted identity.
