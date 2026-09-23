---
title: Verifier endpoints
---

# Verifier endpoints

Fifteen routes. Everything is JSON, including errors and 404s. The service listens on
`VERIFIER_PORT`, which defaults to 4000. Nine of the fifteen are mounted only when the host is
configured for them: `/verify/paid` needs `X402_ENABLED`, `/prepare` needs a Pinata token and a
Privy app id, `/generate` and `/edit` each need those plus their own keys, and the two `/unseal`
routes and the three `/sealed` routes need exactly what `/prepare` needs. An unmounted route answers
`404` like any other path that does not exist. The four `/recheck` routes are mounted on every host,
and the three of them the runner uses answer `503` until `RUNNER_TOKEN` is set. `/sealed/link`
answers `503` until `SEALED_LINK_TOKEN` is set.

## POST /verify

Takes an image and returns the passport it belongs to.

**Request.** Either a multipart upload in a field named `file`, or a JSON body of
`{ "url": "https://..." }`. Both are capped at 20 MB. The URL form is fetched server-side with a 10
second timeout and the same cap enforced while the body streams in.

```bash
curl -s -F "file=@packages/verifier/test-assets/original.jpg" http://localhost:4000/verify
```

```bash
curl -s -X POST http://localhost:4000/verify \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/photo.jpg"}'
```

**Response.** `200` with `{ result, manifest }`.

```ts
{
  result: {
    // The passport id when the uploaded bytes are byte for byte a registered
    // file, otherwise null.
    exact: `0x${string}` | null,
    best: {
      id: `0x${string}`,
      phashDistance: number,        // 0 to 64
      blockhashDistance: number,    // 0 to 256
      variant: "identity" | "rot90" | "rot180" | "rot270"
             | "mirror" | "mirror-rot90" | "mirror-rot180" | "mirror-rot270",
      score: number,
      consent: Consent,             // what the holder has stated, see below
      dispute: Dispute,             // whether the passport is challenged, see below
      recheck: Recheck,             // what has re-checked the picture since, see below
      picture: Picture              // whether the picture is public or sealed, see below
    } | null,
    matches: Match[],               // best first, at most 20
    confidence: number,             // 1 for an exact hit, 0 when nothing matched
    queried: {
      sha256: `0x${string}`,
      phash: string,                // decimal, see the note below
      blockhash: `0x${string}`,
      width: number,
      height: number,
      format: string
    }
  },
  manifest: {
    present: boolean,
    manifestHash?: `0x${string}`,
    title?: string,
    claimGenerator?: string,
    actions?: string[],
    ingredients?: number,
    softBinding?: {
      alg: string,                  // "com.moolam.phash-blockhash.v1"
      phash: string,                // decimal
      blockhash: `0x${string}`
    }
  }
}
```

The 64-bit pHash goes out as a decimal string, never a JSON number, because a double cannot hold
it. That applies to `result.queried.phash` and to `manifest.softBinding.phash`.

`queried` is always the identity fingerprint, which is what a caller would register or display,
even when the best match came from a rotated variant. `variant` names which of the eight found it.

A match must clear both thresholds: pHash at most 10 of 64, blockhash at most 40 of 256. Past
either one, nothing is returned and `confidence` is 0.

**What the holder said about AI use.** Every match the answer names carries `consent`, read live from
the MoolamConsent contract on Monad mainnet at `CONSENT_ADDRESS`
(`0x1151E69a82947920546e779c4C8c785b2a3C1277`). This is the lookup an AI company makes before using
a picture: from the pixels alone, even with the metadata stripped, to the creator's own statement
and the date they wrote it.

```ts
type Use = "unspecified" | "allowed" | "notAllowed" | "constrained"

type Consent =
  | { source: "chain", stated: true,
      standard: "cawg.training-mining/1.1",
      aiTraining: Use, aiGenerativeTraining: Use, aiInference: Use, dataMining: Use,
      constraintInfo?: string,      // at most 256 printable ASCII bytes, absent when there are none
      at: number,                   // unix seconds, the block timestamp of the statement
      writer: `0x${string}` }       // the address that held the passport when it was written
  | { source: "chain", stated: false }
  | { source: "unavailable" }
```

The three sources mean three different things and must not be mixed up. `source: "chain"` with
`stated: true` is the holder's own word, read from the register. `source: "chain"` with
`stated: false` is the contract saying that holder has never spoken for this passport. `source:
"unavailable"` is this service saying it could not find out, because the read failed or ran past its
five second limit, and it is never permission to use the picture. A failed read never fails the
verification: the match is what the caller came for, so the answer still comes back `200`.

Per the CAWG Training and Data Mining 1.1 standard this vocabulary comes from, a reader with no way
to reach the creator treats `constrained` the same as `notAllowed`. A field left `unspecified` is
not permission either: the creator has said nothing about that use.

At most two passports are read per verification, the exact match and the best match when they are
different, and each answer is held in the service's memory for 60 seconds. `constraintInfo` is
returned exactly as the chain holds it, and is dropped if it is not within the 256 printable ASCII
bytes the contract promises, because this answer is input to other people's parsers.

**Whether the passport is under dispute.** The same matches carry `dispute`, read live from the
registry's own dispute view at `MOOLAM_REGISTRY_ADDRESS`
(`0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0`), under the same limits: at most two passports, a five
second cap, 60 seconds in memory, and a failed read that never fails the verification.

```ts
type Dispute =
  | { source: "chain", status: "none" }      // nobody has challenged this passport
  | { source: "chain", status: "open" }      // a challenge is open, with a bond behind it
  | { source: "chain", status: "upheld" }    // the challenge stood: the record is marked disputed
  | { source: "chain", status: "rejected" }  // the challenge was settled against the challenger
  | { source: "unavailable" }                // this service could not find out
```

The four words are the registry's own `DisputeStatus` enum, mapped one for one. A status the enum
has no room for comes back `unavailable` rather than as a guess at the nearest word.

**Read `consent` and `dispute` together.** A statement on a passport whose dispute is `open` or
`upheld` should not be relied on: the registry's design says that record is in question, and the
holder's word about AI use rests on that record. `unavailable` on either field is not permission and
not a clean record, it is this service saying it could not find out. The chain is read rather than
the passport index because a dispute opened since the index was last rebuilt is exactly the one a
reader must not miss.

**What has re-checked the picture.** The same matches carry `recheck`: what the Chainlink CRE
workflow found when it re-fetched this picture, recomputed its fingerprint and wrote the verdict to
Monad. It comes from the passport index this service already holds in memory, the same records the
match ran against, so it costs no call per verification and is as fresh as the service's last index
refresh.

```ts
type Recheck =
  | { source: "index", attestations: number, matched: number, mismatched: number,
      latest: { matched: boolean, distance: number, at: number, receiver: `0x${string}` } }
  | { source: "index", attestations: 0 }   // nothing has re-checked this passport yet
  | { source: "unavailable" }               // this service cannot tell
```

`distance` is how many of the 64 fingerprint bits the recomputed value differs by, `at` is unix
seconds, and `receiver` is the contract the verdict was written to. For the known picture in this
page's examples the fact reads:

```json
{"source":"index","attestations":1,"matched":1,"mismatched":0,"latest":{"matched":true,"distance":0,"at":1789368639,"receiver":"0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04"}}
```

A count and a newest verdict that disagree are not reconciled: the whole fact goes out `unavailable`
rather than half true. How each re-check was delivered, through Chainlink's simulation forwarder or
its network forwarder, is on the passport page beside the transaction, because that is read from the
transaction itself and not from the index.

**Whether the picture is public or sealed.** The same matches carry `picture`. A sealed passport is a
hash on chain with no picture behind it, and its holder can publish the picture later with
[`/unseal`](#post-unseal); this field says which of those a match is, so a caller reading the JSON
learns it without opening the metadata document themselves.

```ts
type Picture =
  | { state: "public" }                    // registered in the open
  | { state: "sealed" }                    // registered without the picture, which was never published
  | { state: "unsealed", at: string }      // registered sealed, published later by its holder
  | { source: "unavailable" }              // this service could not find out
```

`at` is the ISO 8601 time from the unseal record, the moment the holder published the picture. The
state is read from the passport's metadata document and, only for a document that says sealed, from
the unseal record pinned under the passport's id, which is believed only when it names this
passport. A document that cannot be read, a record lookup that fails, and anything slower than the
same five second cap the other reads get come back `unavailable`, never as `sealed` or `public`, and
never fail the verification.

`public` and `unsealed` are held in memory for good, because a document is written once and an
unseal record is never taken back. `sealed` is held for 60 seconds, since it is the one answer the
holder can change. Nothing in the field says where the picture lives: a sealed match carries no
address to try, and an unsealed one is found through [`GET /unseal/:passportId`](#get-unsealpassportid).

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Matched, or ran and found nothing. Finding nothing is a 200 with `best: null` |
| `400` | No multipart `file` field and no `{ "url": "..." }` body, a part named something other than `file`, an empty file, or an upload that is not an image the service can decode |
| `403` | The URL resolves to a loopback, private, link-local, unique-local, carrier-grade NAT, multicast, reserved or cloud metadata address, before or after any redirect |
| `413` | Over the 20 MB byte limit, or over 40 megapixels once decoded |
| `429` | Over 60 requests in a minute from that caller. The address is read from the hop named in `TRUST_PROXY`, so a service behind a proxy counts callers rather than the proxy |
| `502` | The remote host did not answer, or answered with a non-2xx status |

Errors are `{ "error": "<reason>" }`. A 500 answers with a fixed message rather than the internal
one.

## POST /verify/paid

The same answer as `/verify`, behind an x402 payment: 5 cents in USDC on Monad mainnet by default,
settled by Monad's facilitator.

Mounted only when `X402_ENABLED=true`. Otherwise the path does not exist and the service answers
`404`.

**Request.** A multipart `file` upload only. The free route also accepts a remote URL, and that
path carries the checks that stop a fetch reaching a private address; rather than copy those checks
and risk the two copies drifting, the paid route does not offer it.

**Response.** `200` with the same `{ result, manifest }` body as `/verify`, and the base64
`PAYMENT-RESPONSE` header carrying the settlement: `{ success, transaction, network, payer }`.

Each match carries the same `consent`, `dispute`, `recheck` and `picture` fields, with the same sources, the same rule that
`constrained` reads as `notAllowed` to anyone who cannot reach the creator, and the same rule that a
statement on an `open` or `upheld` passport should not be relied on. All four are attached before the
payment is settled, so the body the facilitator signs over and the answer the payer is served are the
same. Nothing about payment changes any of them: a read that fails answers `{ source: "unavailable" }`
and the paid verification still comes back `200`.

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Paid and matched. The settlement receipt rides in the `PAYMENT-RESPONSE` header |
| `402` | No payment, or the facilitator refused this one. The terms ride in the base64 `PAYMENT-REQUIRED` header, whose `error` field carries the refusal, and the JSON body says in words what to do next |
| `400`, `403`, `413` | Same as `/verify` |
| `404` | `X402_ENABLED` is not `true` |
| `429` | Over 60 requests in a minute |
| `500` | `{ "error": "payment-misconfigured" }`: the route is mounted where x402 is not collecting a payment, so it serves nothing rather than answer free |
| `502` | The facilitator did not answer, or the payment could not be checked |

A settlement the facilitator has broadcast but not yet confirmed also answers `200`, with a pending
receipt, and a repeat of the same payment inside ten minutes is answered from this process's memory
without settling again.

Payment is settled only after the match succeeds, so a failed verification never charges. When the
handler fails after a payment was verified, the authorisation is cancelled rather than left
standing against the payer.

**When settlement is broadcast but not yet confirmed.** The facilitator can answer a settle call
with `settlement_pending`: the transfer is on chain but its receipt has not been seen in time. The
route asks once more, five seconds later, and if the answer is the same it returns `200` with the
verification and a `PAYMENT-RESPONSE` whose `success` is false, whose `errorReason` is
`settlement_pending`, and which carries the transaction hash. It does not cancel: the authorisation
is signed for that one amount, the facilitator holds it, and the money lands when the transaction
confirms.
Cancelling would throw away a transfer already on its way, and withholding the answer would take
the payment and give nothing back.

### Paying for one

`packages/agents/scripts/pay-verify.ts` is a complete paying client: it reads the terms, signs an
EIP-3009 `transferWithAuthorization` for USDC on Monad mainnet, sends the image with the payment,
and prints the receipt.

```bash
cd packages/agents
npm run pay:verify                       # the default test image
npm run pay:verify -- ./my-picture.jpg   # any other file
```

It reads `X402_PAYER_PRIVATE_KEY` (the paying wallet, which needs USDC and no MON, because the
facilitator pays the settlement gas) and `X402_VERIFIER_URL` from the repo root `.env`. What it
prints:

```
Moolam paid verification over x402, on Monad mainnet.
Verifier https://.../verify/paid
Payer    0x...
Image    .../packages/verifier/test-assets/original.jpg

Terms offered and accepted:
  scheme    exact on eip155:143
  price     0.05 USDC (50000 atomic units)
  asset     0x754704Bc059F8C67012fEd69BC8A327a5aafb603
  pay to    0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7
  valid for 300 seconds

Signing the transfer authorisation and sending the image ...
Settled. Transaction 0x... on eip155:143, paid by 0x....

Verification:
  these exact bytes are registered, passport 0xb95adc...354c
  confidence 1
  C2PA manifest not in the file
```

When the facilitator has broadcast the transfer but not yet seen it confirmed, the middle line reads
"Broadcast but not confirmed yet." with the transaction and "The facilitator finishes it." instead,
and the verification still prints.

A wallet with no USDC gets the facilitator's refusal instead, printed as
`Refused: the verifier answered 402: insufficient_funds`, and the script exits non-zero. Nothing is
charged and nothing is verified.

## POST /prepare

Everything a signed-in creator needs before they sign a passport. The studio's browser posts the
image straight here, because a Vercel function cannot take a 20 MB upload.

Mounted only when the host has both `PINATA_JWT` and `PRIVY_APP_ID`. Otherwise the path does not
exist and the service answers `404`.

**Request.** A multipart body with three parts, in any order.

| Part | Type | Rule |
| --- | --- | --- |
| `file` | file | The image. Up to 20 MB and 40 megapixels. A file part under any other name is a `400` |
| `title` | text | 1 to 120 characters after trimming. It becomes the passport's name and the C2PA title |
| `kind` | text | `human` is the only value the studio takes today |
| `training` | text | Optional. A JSON object saying how AI may use the picture: `aiTraining`, `aiGenerativeTraining`, `aiInference` and `dataMining`, each `allowed`, `notAllowed` or `constrained`, plus `constraintInfo` when a choice is constrained |
| `privateRecheck` | text | Optional, `true` or `false`. `true` is accepted only together with `sealed` set to `true`, and keeps one private thumbnail for a later private Chainlink re-check, see below. Without `sealed` it is a `400` |

The `training` statement is written into the signed C2PA manifest as one `cawg.training-mining`
assertion and into the pinned metadata, so it travels inside the file and sits under the creator's
passkey signature, which signs the metadata address. A choice left out states nothing at all, which
is not the same as allowing it. `constraintInfo` is required when a choice is `constrained`, refused
otherwise, and is at most 256 bytes of printable ASCII, the same rule the consent contract enforces,
so a statement made here can be written on chain unchanged.

**The private re-check.** With `sealed=true` and `privateRecheck=true` the service keeps one more
thing: a thumbnail of the signed file, 512 pixels on its longest side and made exactly as a public
prepare makes one, uploaded to Pinata's private network under the name
`sealed-thumb-<passport id in lower case>.jpg` with the passport id as the `passportId` key-value.
Private files are not served on the public IPFS network; Moolam's operator and the Pinata account
holder can still open it. The order is fixed: the registry is asked whether the picture is already
registered, then the private copy is uploaded, then the metadata document is pinned. The copy is
kept only when Pinata answers that it is private under exactly that name, and it is deleted again if
the document pin fails. The pinned document gains `"privateRecheck": true` and nothing that names
the private file, and the answer gains `privateRecheck: true`. Nothing else changes for a public or
a plain sealed prepare.

**Headers.** `Authorization: Bearer <Privy access token>`, plus the multipart `Content-Type` the
browser or curl sets. The token has to be signed by the app's own key set, carry the issuer
`privy.io`, name this `PRIVY_APP_ID` in its audience, be inside its expiry, and use ES256.

```bash
curl -s -X POST http://localhost:4000/prepare \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -F "file=@photo.jpg" -F "title=Monsoon fishing nets" -F "kind=human" \
  -F 'training={"aiGenerativeTraining":"notAllowed","dataMining":"constrained","constraintInfo":"ask hello@moolam.app"}'
```

**Response.** `200` with the passport fields and the pinned files. The image bytes never come back:
the caller already has them, and the answer has to sit in a browser's memory next to the upload.

```ts
{
  passport: {
    exactHash: `0x${string}`,      // sha256 of the pinned bytes, and the passport id
    parentId: `0x${string}`,       // 32 zero bytes: a studio upload is an original
    generatorAgentId: string,      // "0" as a decimal string: no agent made this one
    phash: string,                 // decimal, for the reason given under /verify
    blockhash256: `0x${string}`,
    manifestHash: `0x${string}`,   // 32 zero bytes when nothing was embedded
    kind: number,                  // 1, Captured
    fingerprintVersion: number,    // 1
    metadataURI: string            // ipfs://...
  },
  image: {
    cid: string,
    uri: string,                   // ipfs://...
    gatewayUrl: string,
    bytes: number,
    width: number,
    height: number
  },
  thumbnail: { cid: string, uri: string, gatewayUrl: string },
  metadata: { cid: string, uri: string },
  manifest: { embedded: true } | { embedded: false, reason: string },
  training?: {                     // absent when the creator said nothing
    aiTraining?: "allowed" | "notAllowed" | "constrained",
    aiGenerativeTraining?: "allowed" | "notAllowed" | "constrained",
    aiInference?: "allowed" | "notAllowed" | "constrained",
    dataMining?: "allowed" | "notAllowed" | "constrained",
    constraintInfo?: string,
    standard: "cawg.training-mining/1.1"
  },
  preparedBy: string               // the Privy user id the token carried
}
```

The browser adds its own wallet address and a deadline to those passport fields, reads
`hashPassport` from the registry, signs that digest with the creator's passkey and sends `register`
itself, so the service never holds a key that can write to the chain.

`manifest.embedded` is `false` when the C2PA signer refused the file, an unusual container or a
missing certificate. The upload still stands: `manifestHash` is 32 zero bytes, the fingerprint and
the on-chain record work without a manifest, and `reason` says what happened, cut to 200 characters.

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Prepared and pinned |
| `400` | Not a multipart body, no `file` part, an empty file, a file part under another name, a `title` outside 1 to 120 characters, a `kind` other than `human`, or a `training` statement that is not JSON, is over 1024 bytes, carries a key or a value the standard has no room for, or breaks the `constraintInfo` rule. The message names the field |
| `400` | `{ "error": "too-many-fields" }`. The body carries more than five text parts. Nothing is read further and nothing is pinned |
| `400` | `{ "error": "private-recheck-needs-sealed" }`. `privateRecheck` is `true` and `sealed` is not. Nothing is pinned |
| `401` | No `Authorization: Bearer` header, or a token that fails on its signature, issuer, audience, algorithm or expiry. A key set that cannot be fetched answers the same way, so a caller never learns the difference between a bad token and a bad network. `{ "error": "unauthorized" }` |
| `409` | `{ "error": "already-registered", "passportId": "0x..." }`. The registry already holds this exact picture. Nothing is pinned, and the id names the passport that holds it |
| `409` | `{ "error": "private-copy-not-private" }`. Pinata answered the private upload with a file that is not on its private network or not under the name sent, as it does for bytes the account already holds publicly. No document is pinned, nothing is registered, and the file id Pinata gave back goes to the log for an operator |
| `413` | Over the 20 MB byte limit, or over 40 megapixels once the header is read |
| `415` | The file is not an image the service can decode. `{ "error": "not-an-image" }`, with `reason` when the header parsed and the pixels behind it did not |
| `422` | `{ "error": "thumbnail-too-large", "limit": 60000, "reason": "..." }`. A real picture with so much fine detail that its 512 pixel thumbnail stays over 60,000 bytes even at the lowest quality tried, so the Chainlink verifier could never fetch it. The `reason` says so and adds that registering the picture sealed still works, because a sealed prepare makes no thumbnail. Nothing is pinned and the day's slot is given back. A plain sealed prepare makes no thumbnail and never answers this; one with `privateRecheck` does, and its `reason` says a private re-check could never open the thumbnail and a plain sealed registration still works |
| `429` | Over 20 prepares in an hour, counted on the Privy user id from the token, or on the caller's address when there is no valid one. This limit replaces the global 60 a minute on this path |
| `429` | `{ "error": "global-limit", "reason": "...", "quota": { used, limit, resetsAt } }` once `GLOBAL_PREPARES_PER_DAY` is spent by everyone together, with `retry-after` in seconds. Nothing is pinned. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `502` | Pinata refused a pin. `{ "error": "pin-failed" }`. Pinata's status and its answer go to the log and never to the caller, and the token appears in neither. With `privateRecheck`, a refused or timed out private upload answers this with no document pinned, and a document pin that fails after the private copy was kept answers this after the copy is deleted |
| `503` | `busy`. The two-slot decode gate stayed full for thirty seconds. Nothing was pinned, so the call can be made again |
| `503` | `{ "error": "chain-unreachable" }`. `privateRecheck` was asked for and the check for an existing passport could not reach the chain, so no private copy was made and nothing was pinned. A public or plain sealed prepare goes on in that case, as it always has |

**CORS.** A browser may call this service only from an origin listed in `CORS_ORIGINS`, and those
are exact origins: `https://moolam.app`, never a wildcard, a path or a trailing slash. The allowed
methods are `GET` and `POST`, and the allowed headers are `Authorization` and `Content-Type`. An
origin that is not on the list gets no allow header back, which the browser turns into a refusal on
its side; curl and any server-side caller are unaffected either way. With `CORS_ORIGINS` empty, no
browser origin is allowed at all.

## POST /generate

The generator agent draws a picture for a signed-in creator and co-signs its passport. The creator's
browser adds their passkey signature over the same struct and sends the transaction, so this route
never holds a key that can write to the chain.

Mounted only when the host has everything `/prepare` needs plus an image model key
(`OPENAI_API_KEY` or `OPENROUTER_API_KEY`), `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` and
`GENERATOR_WALLET_ID`. Otherwise the path does not exist and the service answers `404`.

**Request.** A JSON body, with the creator's Privy access token in an `Authorization: Bearer` header.

| Field | Type | Rule |
| --- | --- | --- |
| `prompt` | string | 8 to 600 characters after trimming. It is the only text that reaches the model: nothing is added around it |
| `title` | string | 1 to 120 characters after trimming. It becomes the passport's name and the C2PA title |
| `creator` | string | `0x` and 40 hex characters. The wallet that will sign and send, and it goes inside what the agent signs |
| `deadline` | number or numeric string | Unix seconds, between 10 minutes and 2 hours from now. The studio asks for 30 minutes |
| `training` | object | Optional. The same statement `/prepare` takes: `aiTraining`, `aiGenerativeTraining`, `aiInference` and `dataMining`, each `allowed`, `notAllowed` or `constrained`, plus `constraintInfo` when a choice is constrained |
| `privateRecheck` | boolean | Optional. `true` is accepted only together with `sealed: true`, and keeps one private thumbnail exactly as `/prepare` does under "The private re-check". The answer gains `privateRecheck: true`. Without `sealed` it is a `400` before anything is drawn |

The `training` statement is written into the signed C2PA manifest as one `cawg.training-mining`
assertion and into the pinned metadata, before the agent signs, so it is inside both signatures:
the agent's over the passport and the creator's passkey over the same struct, which carries the
metadata address. The rules are the ones under `/prepare`, and a choice left out states nothing.

```bash
curl -s -X POST http://localhost:4000/generate \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt":"a fishing boat leaving a harbour at first light","title":"First light","creator":"0x...","deadline":1788878000}'
```

**Response.** `200` with the passport fields, the agent's signature over them, and the pinned files.

```ts
{
  passport: {
    exactHash: `0x${string}`,      // sha256 of the pinned bytes, and the passport id
    parentId: `0x${string}`,       // 32 zero bytes: a generated picture is an original
    creator: `0x${string}`,        // the address from the request, checksummed
    generatorAgentId: string,      // decimal, the ERC-8004 id that signed
    phash: string,                 // decimal, for the reason given under /verify
    blockhash256: `0x${string}`,
    manifestHash: `0x${string}`,   // 32 zero bytes when nothing was embedded
    kind: number,                  // 0, Generated
    fingerprintVersion: number,    // 1
    metadataURI: string,           // ipfs://...
    deadline: string               // the deadline from the request, as a decimal string
  },
  generatorSig: `0x${string}`,     // the agent owner's EIP-712 signature over that struct
  image: { cid, uri, gatewayUrl, bytes, width, height },
  thumbnail: { cid, uri, gatewayUrl },
  metadata: { cid, uri },
  manifest: { embedded: true } | { embedded: false, reason: string },
  training?: { ...the statement that was written, plus standard: "cawg.training-mining/1.1" },
  model: string,                   // what drew it, also pinned in the metadata
  agent: { id: string, wallet: `0x${string}` },
  quota: { used: number, limit: number, resetsAt: number },
  preparedBy: string               // the Privy user id the token carried
}
```

The agent signs over the final pinned bytes, not the model's output, so the signature covers exactly
what the passport id is computed from. The browser must send these fields unchanged: `creator` and
`deadline` are inside what was signed, and the registry checks both.

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Drawn, pinned and signed |
| `400` | A field outside its rule, a deadline outside the 10 minute to 2 hour window, or a `training` statement the standard has no room for. The reason names the field |
| `400` | `{ "error": "prompt-refused", "reason": "..." }` when the model's safety system turns the prompt down. The day's allowance is given back |
| `400` | `{ "error": "deadline-passed" }` when the picture was drawn and too little of the window was left for the agent to sign something a person could still use. The picture exists, so the day's allowance stays spent |
| `400` | `{ "error": "private-recheck-needs-sealed" }`. `privateRecheck` is `true` and `sealed` is not. Nothing is drawn or pinned and the allowance is untouched |
| `401` | No `Authorization: Bearer` header, or a token that fails on its signature, issuer, audience, algorithm or expiry. `{ "error": "unauthorized" }` |
| `403` | `{ "error": "creator-mismatch" }`. The `creator` address is not one of the caller's own Privy wallets, read from their user record rather than taken from the request. A Privy user id this app does not know answers the same way |
| `409` | With `privateRecheck`: `{ "error": "already-registered", "passportId": "0x..." }` when the registry already holds the drawn picture, or `{ "error": "private-copy-not-private" }` as under `/prepare`. No document is pinned; the picture was drawn, so the allowance stays spent |
| `422` | With `privateRecheck`: `{ "error": "thumbnail-too-large", "limit": 60000, "reason": "..." }` when the drawing's thumbnail cannot fit the Chainlink budget. Nothing is pinned and the allowance stays spent |
| `429` | Past `GENERATE_PER_DAY` in a rolling 24 hours, counted on the Privy user id. `{ "error": "quota", "quota": { used, limit, resetsAt } }` |
| `429` | `{ "error": "global-limit", "reason": "...", "quota": { used, limit, resetsAt } }` once `GLOBAL_GENERATIONS_PER_DAY` is spent by everyone together, with `retry-after` in seconds. Nothing is drawn and the caller's own allowance is handed back. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `502` | `model-failed`, `pin-failed` or `sign-failed`: the image model, Pinata or Privy's enclave would not play |
| `503` | `busy`. Two pictures were already being drawn and no slot came free inside 90 seconds. The allowance is given back |
| `503` | With `privateRecheck`: `{ "error": "chain-unreachable" }` when the check for an existing passport could not reach the chain. No private copy is made and nothing is pinned; the picture was drawn, so the allowance stays spent |

**The allowance.** `GENERATE_PER_DAY`, three by default, per verified Privy user id over a rolling 24
hours. A refused prompt and a request that never got a drawing slot hand the slot back. A model that
failed part way keeps it, because it may have drawn and been billed before it failed, and so do a
failed pin and a failed signature, which both happen after the picture exists. The count lives in the
service's memory, so a redeploy resets it and two copies of the service would count separately. The
global 60 requests a minute applies to this path as well.

## POST /edit

The owner of a passport appends an edited version of it with no passkey prompt. The transaction goes
out from the owner's own Privy wallet, asked for with this app's authorization key under a policy
that allows `appendEdit` on the Moolam registry and nothing else.

Mounted only when the host has everything `/prepare` needs plus `PRIVY_APP_SECRET`,
`PRIVY_AUTHORIZATION_KEY`, `PRIVY_EDIT_SIGNER_ID` and `PRIVY_EDIT_POLICY_ID`. Otherwise the path does
not exist and the service answers `404`.

**The two ids, on both sides.** The browser names the same pair when it asks Privy for the grant,
through `NEXT_PUBLIC_PRIVY_SIGNER_ID` and `NEXT_PUBLIC_PRIVY_EDIT_POLICY_ID`. They have to be the
same signer id and the same policy id the service holds: the service reads the signers on the wallet,
looks for its own `PRIVY_EDIT_SIGNER_ID`, and refuses the edit unless that signer carries
`PRIVY_EDIT_POLICY_ID`. A grant made without the policy is refused, because a signer with no policy
on it could do more than append an edit and this route promises it cannot.

**Request.** A multipart body with one file and three text parts, in any order, and the owner's Privy
access token in an `Authorization: Bearer` header.

| Part | Type | Rule |
| --- | --- | --- |
| `file` | file | The edited image. Up to 20 MB and 40 megapixels. A file part under any other name is a `400` |
| `title` | text | 1 to 120 characters after trimming |
| `parentId` | text | `0x` and 64 hex characters, the passport being edited |
| `note` | text | Optional, up to 280 characters saying what changed. It is pinned beside the picture with the parent's id |

```bash
curl -s -X POST http://localhost:4000/edit \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -F "file=@edited.jpg" -F "title=Kadal at dawn, warmer" \
  -F "parentId=0x75bf..." -F "note=Lifted the shadows and cropped the right edge."
```

**Response.** `200` with the child passport, the transaction it went out in, and the pinned files.

```ts
{
  child: {
    exactHash: `0x${string}`,      // sha256 of the pinned bytes, and the child's passport id
    parentId: `0x${string}`,       // the parent from the request
    creator: `0x${string}`,        // the owner's wallet, read from the Privy user record
    generatorAgentId: string,      // "0": an edit carries no agent
    phash: string,
    blockhash256: `0x${string}`,
    manifestHash: `0x${string}`,
    kind: number,                  // 2, Edited
    fingerprintVersion: number,    // 1
    metadataURI: string,
    deadline: string               // 30 minutes out, though the send happens within seconds
  },
  tokenId: string,                 // the ERC-721 id, the image hash as a decimal
  hash: `0x${string}`,             // the transaction
  sponsored: boolean,
  image: { cid, uri, gatewayUrl, bytes, width, height },
  thumbnail: { cid, uri, gatewayUrl },
  metadata: { cid, uri },
  manifest: { embedded: true } | { embedded: false, reason: string },
  quota: { used: number, limit: number, resetsAt: number }
}
```

The wallet comes from the Privy user record, never from the request, and the ownership check is read
from the chain before anything is spent. The manifest written into an edit records the action
`c2pa.edited` rather than `c2pa.created`, which is the one place inside the file that says this
picture is a change to another one.

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Pinned and sent |
| `400` | Not a multipart body, no `file` part, a file part under another name, a `title` outside 1 to 120 characters, a `parentId` that is not 32 bytes of hex, or a `note` over 280 characters |
| `400` | `{ "error": "too-many-fields" }`. The body carries more than five text parts. Nothing is read further and nothing is pinned |
| `401` | The token is missing or fails a check. `{ "error": "unauthorized" }` |
| `403` | `not-owner`. None of this caller's wallets is the one the registry says holds the parent. A creator with more than one embedded wallet is matched by the address on chain, not by which wallet is listed first |
| `404` | `no-parent`. The registry has no passport with that id |
| `409` | `no-signer`. This app is not a signer on that wallet, or its signer does not carry the edit policy. A Privy user id this app does not know answers the same way |
| `409` | `{ "error": "already-registered", "passportId": "0x..." }`. The registry already holds this exact edited picture. The check runs on the fingerprint of the bytes about to be pinned, so nothing is pinned, nothing is sent and the day's allowance is given back |
| `413` | Over the 20 MB byte limit, or over 40 megapixels |
| `415` | `not-an-image`, with `reason` when the header parsed and the pixels behind it did not decode |
| `429` | Past `EDITS_PER_DAY` in a rolling 24 hours. `{ "error": "quota", "quota": { used, limit, resetsAt } }` |
| `429` | `{ "error": "global-limit", "reason": "...", "quota": { used, limit, resetsAt } }` once `GLOBAL_EDITS_PER_DAY` is spent by everyone together, with `retry-after` in seconds. Nothing is pinned, nothing is sent, and the caller's own allowance is handed back. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `502` | `pin-failed`, `sign-failed`, or `send-failed` with the registry's own revert name when the call was simulated and refused |
| `502` | `{ "error": "send-pending", "transactionId": "...", "passportId": "0x...", "hash": "0x..." }`, the hash only when Privy reported one. Privy took the transaction and the chain did not show it inside the wait. It may still land, so a caller must check the chain and must never send it again. `passportId` is the child's own id, which is why the check is a read of that one passport rather than a guess at which edit under the parent belongs to this caller |
| `502` | `privy-unavailable` or `chain-unavailable`: Privy or the Monad RPC did not answer while the parent, the owner and the signer were being checked. That all happens before the allowance is taken, so nothing was sent and nothing was spent |
| `503` | `busy`. The shared decode gate, which matching, prepares and edits all queue on, stayed full for thirty seconds |

The parent is checked first, because it is the one claim in the request that costs nothing to settle.
Then the signer, then the ownership, then the creator's own allowance, then today's budget for
everyone, and only then is a pin or a transaction spent.

## POST /unseal

The holder of a sealed passport publishes the picture it committed to. A sealed passport is a hash
on chain with no picture behind it; unsealing is the creator handing that picture over, and from
then on it is an ordinary passport the Chainlink workflow can re-check.

Mounted on the same terms as `/prepare`: a Pinata token to pin with and a Privy app id to check
tokens against. Nothing here signs on a wallet or sends a transaction.

**Request.** A multipart body with one file and one text part, in any order, and the holder's Privy
access token in an `Authorization: Bearer` header.

| Part | Type | Rule |
| --- | --- | --- |
| `file` | file | The signed file the service handed back at registration. Up to 20 MB and 40 megapixels |
| `passportId` | text | `0x` and 64 hex characters, the sealed passport being opened |

```bash
curl -s -X POST http://localhost:4000/unseal \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -F "file=@the-file-we-handed-back.jpg" -F "passportId=0x75bf..."
```

**What it checks, before a byte is pinned.**

Only the holder unseals. The token names a Privy user, the Privy user record names their embedded
wallets, and `ownerOf` on the registry has to be one of them at that moment. The wallet never comes
from the body, and the holder is read from the chain rather than from the index, because an index
is a copy of the chain a minute ago and a passport can change hands in a minute.

Unsealing publishes exactly what was registered. The sha-256 of the upload must equal the passport
id, which is the registry's own rule for what a passport id is, and the fingerprint recomputed from
the upload must equal the one recorded on chain. A caller holding a different picture publishes
nothing.

The passport must still be sealed. Its metadata document is read through the gateway and has to say
`"sealed": true`. A document that cannot be read is answered `502`, never treated as "public
already": that reading would refuse a creator their own unseal because a gateway was slow.

The thumbnail must fit. The sealed path makes no thumbnail, so a picture the public path would have
refused for its 60 KB budget can be registered sealed. Publishing it would leave a passport the
Chainlink workflow can never fetch and so can never re-check, which reads as a fault for ever, so
the unseal is refused with `422` instead.

**Response.** `200` with the four things now on IPFS.

```ts
{
  passportId: `0x${string}`,
  image: { cid, uri, gatewayUrl },
  thumbnail: { cid, uri, gatewayUrl },
  manifest?: { cid, uri, gatewayUrl },   // absent when the file carries no readable manifest
  record: { cid, uri, gatewayUrl },
  unsealedBy: `0x${string}`,             // the wallet the registry says holds it
  unsealedAt: string,                    // ISO 8601
  fingerprint: { phash, blockhash, version },
  quota: { used: number, limit: number, resetsAt: number }
}
```

**Nothing on chain changes, and nothing can.** The registry writes `metadataURI` once at
registration and has no setter, so the sealed document stays the passport's metadata for ever. The
picture's address lives in the `record`: a small JSON document pinned under a name worked out from
the passport id, which is what makes it findable again by a service that has just been redeployed
and keeps no database. The record names the passport, the three addresses, the wallet that opened
it and the time.

The record is not signed. A signature would only say Moolam published the file; the hash says the
bytes are the registered ones, which is the thing anyone actually wants to know and is checkable by
a stranger with a copy of the picture and no knowledge of this service. Fetch the image, hash it,
compare with the passport id on Monad.

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Published. Once the record is pinned, a private copy kept for a private re-check is deleted by its exact name, `sealed-thumb-<passportId>.jpg`, and [`/sealed/status`](#get-sealedstatuspassportid) reads `gone` at once. A lookup or delete that fails is logged with the passport id and changes nothing in this answer |
| `400` | Not a multipart body, no `file` part, a file part under another name, or a `passportId` that is not 32 bytes of hex |
| `400` | `{ "error": "too-many-fields" }`. The body carries more than five text parts. Nothing is read further and nothing is pinned |
| `400` | `{ "error": "hash-mismatch", "passportId": "0x..." }`. The upload is not the file this passport commits to. Usually the creator kept their own copy of the picture rather than the file this service signed and handed back |
| `400` | `{ "error": "fingerprint-mismatch", "passportId": "0x...", "recomputed": {...} }`. The bytes hash right and the fingerprint recomputed from them is not the one on chain |
| `401` | The token is missing or fails a check. `{ "error": "unauthorized" }` |
| `403` | `not-holder`. The registry says another wallet holds this passport. A Privy user id this app does not know answers the same way |
| `404` | `no-passport`. The registry has no passport with that id |
| `409` | `not-sealed`. The passport's metadata document is already public, so there is nothing to unseal |
| `409` | `{ "error": "already-unsealed", "passportId": "0x...", "record": {...} }`. A record is pinned for this passport already |
| `413` | Over the 20 MB byte limit, or over 40 megapixels |
| `415` | `not-an-image`, with `reason` when the header parsed and the pixels behind it did not decode |
| `422` | `{ "error": "thumbnail-too-large", "limit": 60000, "reason": "..." }`. Nothing was pinned |
| `429` | Past `EDITS_PER_DAY` in a rolling 24 hours, which is the allowance unsealing shares. `{ "error": "quota", "quota": { used, limit, resetsAt } }` |
| `429` | `{ "error": "global-limit", ... }` once `GLOBAL_UNSEALS_PER_DAY` is spent by everyone together. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `502` | `pin-failed`. Nothing reached IPFS |
| `502` | `{ "error": "record-pin-failed", "passportId": "0x...", "image": {...}, "thumbnail": {...}, "reason": "..." }`. The picture is public and the record that points at it is not. This is the one half-done state the route can end in, and the answer says so rather than failing silently, because the caller has to know their picture is already out there. Sending the same file again lands on the same three addresses, because every pin is content addressed, and finishes the record |
| `502` | `chain-unavailable`, `metadata-unavailable` or `privy-unavailable`: the Monad RPC, the gateway or Privy did not answer. All of that happens before the allowance is taken, so nothing was spent |
| `503` | `busy`. The shared decode gate, which matching, prepares, edits and unseals all queue on, stayed full for thirty seconds |

Both allowances go back whenever the request pinned nothing, because an unseal sends no
transaction: a request that pinned nothing has cost the world nothing to keep.

## GET /unseal/:passportId

Where the picture of an unsealed passport lives, or that there is none yet. The passport page
cannot learn this from the chain, so it asks here.

```bash
curl -s http://localhost:4000/unseal/0x75bf...
```

```ts
{
  passportId: `0x${string}`,
  image: { cid, uri, gatewayUrl },
  thumbnail: { cid, uri, gatewayUrl },
  manifest?: { cid, uri, gatewayUrl },
  record: { cid, uri, gatewayUrl },
  unsealedBy: `0x${string}`,
  unsealedAt: string
}
```

The answer carries the record's own address as well as the three it names, so a reader who does not
want to take this service's word for it can open the record on IPFS and hash the picture
themselves.

| Code | When |
| --- | --- |
| `200` | A record was found and read |
| `400` | The id is not `0x` and 64 hex characters |
| `404` | `{ "error": "not-unsealed", "passportId": "0x..." }`. No record is pinned for this passport |
| `503` | `lookup-unavailable`. This service could not find out, which is not the same as "not unsealed" and must never be shown as one |

A record is pinned once and never changes, so a hit is remembered for the life of the process and a
miss never is. That keeps a passport page, which is read far more often than a passport is
unsealed, from spending a Pinata request every time somebody opens it.

## GET /sealed/status/:passportId

Whether Moolam still keeps the private copy of a sealed passport whose creator asked for a private
Chainlink re-check. The copy is one 512 pixel thumbnail on Pinata's private network, kept under
`sealed-thumb-<passportId>.jpg`. No token.

```bash
curl -s http://localhost:4000/sealed/status/0x75bf...
```

```ts
{
  passportId: `0x${string}`,
  state: "kept" | "gone" | "unknown",
  privateRecheck: boolean
}
```

The passport has to be on the registry, read from the chain. Its metadata document then decides
whether Pinata is asked at all: only a document that is sealed, says `privateRecheck: true`, carries
no `image` or `thumbnail` key and commits to this very passport id counts as asking. Any other
document answers `privateRecheck: false` and `state: "gone"` without a Pinata request.

For a document that asks, the private listing is read and filtered on the whole file name.
`kept` is exactly one file under the name. `gone` is a listing that finished and found none.
`unknown` is everything this service cannot tell: the chain, the gateway or the listing did not
answer, or two files share the name. Unknown is never shown as kept or as gone. When the document
itself could not be read, `privateRecheck` is `false` because the service does not know.

| Code | When |
| --- | --- |
| `200` | Any of the three states |
| `400` | The id is not `0x` and 64 hex characters |
| `404` | `{ "error": "no-passport", "passportId": "0x..." }`. The registry holds no such passport |
| `429` | Thirty a minute per address, rather than the sixty everything else gets |

`kept` and `gone` are held in memory for 60 seconds per passport and carry
`Cache-Control: public, max-age=60`. `unknown` and every refusal carry `no-store` and are never
held, because they are the answers that must be asked again. A delete through
[`/sealed/forget`](#post-sealedforget) drops the memory for that passport at once.

## POST /sealed/link

A read link to one passport's private copy, for the confidential Chainlink workflow that re-checks
it. The link is a bearer secret for the two minutes it lives.

```bash
curl -s -X POST http://localhost:4000/sealed/link \
  -H "Authorization: Bearer $SEALED_LINK_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"passportId":"0x75bf..."}'
```

```ts
{ url: string, expiresAt: string }   // expiresAt is ISO 8601, 120 seconds from the request
```

A link is minted only when every check holds, and they run in this order. The token is compared in
constant time. The id is 32 bytes of hex, lower-cased once. The registry holds the passport. Its
metadata document, read through the service's own guarded fetch, asks for a private re-check and
commits to this very id. The re-check queue holds a request for it that a runner claimed less than
ten minutes ago, so a stolen token opens only what is being run right now. Exactly one private file
has the passport's name. The link is then asked of Pinata for a fixed 120 seconds, never a time from
the request, and parsed again before it is sent: it has to be `https` on the host
`PINATA_GATEWAY_URL` names.

| Code | When |
| --- | --- |
| `200` | The link and when it stops working |
| `400` | The body is not `{ "passportId": "0x..." }` with 64 hex characters |
| `401` | `unauthorized`. No `Authorization: Bearer ...` header, or the wrong token |
| `404` | `no-passport`. The registry holds no such passport |
| `404` | `nothing-kept`. The passport's document did not ask for a private re-check |
| `404` | `gone`. No private file has the passport's name |
| `409` | `commitment-mismatch`. The document commits to a different passport id |
| `409` | `not-claimed`. No runner claimed this passport's request in the last ten minutes: nobody asked, it is still waiting, it is answered, or the claim is older |
| `409` | `ambiguous`. More than one private file has the passport's name |
| `429` | `link-cap`. Five links for this passport in the last hour |
| `429` | `{ "error": "global-limit", ... }` once `GLOBAL_LINKS_PER_DAY` links were minted today across every passport, 100 by default. At `0` every request that passes the checks answers this, which switches the route off. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `502` | `link-unavailable`. Pinata did not mint the link, or answered one that is not `https` on the configured gateway |
| `503` | `not-configured`. This host has no `SEALED_LINK_TOKEN`, so it mints nothing |
| `503` | `chain-unavailable`, `metadata-unavailable` or `lookup-unavailable`. The chain, the gateway or the private listing did not answer, which is never read as a no |

Every refusal carries the error and the passport id and nothing else: no URL and no file id. No log
line carries the link or the token either. `SEALED_LINK_TOKEN` must be at least 24 characters or the
service refuses to boot. The two caps are taken only after every check passed, and once the link is
asked of Pinata they stay spent, because a request that timed out may still have signed one.

## POST /sealed/forget

The holder deletes Moolam's private copy of their passport.

```bash
curl -s -X POST http://localhost:4000/sealed/forget \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"passportId":"0x75bf..."}'
```

```ts
{ passportId: `0x${string}`, deleted: number }
```

Only the holder deletes, checked the way `/unseal` checks it: the Privy token names a user, the
Privy user record names their embedded wallets, and `ownerOf` on the registry, read at that moment,
has to be one of them. Then every private file whose name is exactly the passport's is deleted, two
included, and `deleted` says how many. The status memory for the passport is dropped at once, so
neither `/sealed/status` nor the re-check queue goes on saying `kept`. The answer and the log line
carry the count and never a file id.

| Code | When |
| --- | --- |
| `200` | Deleted, with the count. `0` when the copy was already gone |
| `400` | The body is not `{ "passportId": "0x..." }` with 64 hex characters |
| `401` | The Privy token is missing or fails a check. `{ "error": "unauthorized" }` |
| `403` | `not-holder`. The registry says another wallet holds this passport. A Privy user id this app does not know answers the same way |
| `404` | `no-passport`. The registry holds no such passport |
| `404` | `nothing-kept`. The passport's document did not ask for a private re-check |
| `502` | `privy-unavailable`. Privy did not answer the wallet lookup |
| `502` | `{ "error": "delete-failed", "passportId": "0x...", "deleted": n }`. Pinata refused at least one delete. Send the same request again to finish |
| `503` | `chain-unavailable`, `metadata-unavailable` or `lookup-unavailable`. Nothing was deleted: a listing that did not finish is never read as "nothing there" |

A deleted copy cannot be put back by any route. The passport, its sealed document and its verdicts
on chain are untouched; what goes is the private re-check, which needs the copy.

## POST /recheck/request

Asks for a Chainlink second opinion on a registered picture. Free, and no account: the runner that
does the work decides for itself what it can afford, so a request costs this service nothing to
take and nothing to serve.

```bash
curl -s -X POST http://localhost:4000/recheck/request \
  -H 'content-type: application/json' \
  -d '{"passportId":"0x75bf..."}'
```

```ts
{
  passportId: `0x${string}`,
  status: "pending" | "running",
  requestedAt: number,
  position: number,
  already: boolean
}
```

`requestedAt` is unix milliseconds, like every time on these four routes. `position` is the place
in the waiting line, 1 for the next one out, and `0` for a passport a runner already has in hand.
`already` is true when this passport was already waiting or running, which is what makes the route
idempotent: pressing the button twice is one request, and the second answer carries the first
one's time. A passport asked for again after its last answer starts a fresh request at the back of
the queue.

| Code | When |
| --- | --- |
| `200` | Recorded, or already waiting |
| `400` | The body is not `{ "passportId": "0x..." }` with 64 hex characters |
| `404` | `no-passport`. This service's index does not hold that passport |
| `409` | `sealed`. The picture was never published, so there is nothing for the Chainlink verifier to fetch. Publish it with [`/unseal`](#post-unseal) and ask again. A passport its holder has unsealed since is queued like a public one, and so is a sealed passport whose private copy is kept (below) |
| `429` | Ten a minute per address, rather than the sixty everything else gets |
| `503` | `queue-full`. A thousand requests are waiting and none has been run |

Whether a passport is sealed is read from its metadata document, and for a document that says
sealed, from the unseal record its holder pins on publishing the picture. The registry writes
`metadataURI` at registration and has no setter, so the document says sealed for ever; the record is
what says the picture is out since. A public or unsealed answer is remembered for the life of the
process, because neither can change back, and a sealed one for 60 seconds, so a holder who unseals
waits at most a minute to be re-checked. Only passports the index already holds get that far, so a
caller cannot turn this route into a gateway or Pinata read per request. A gateway or a record
lookup that does not answer inside five seconds lets the request through; the runner refuses it
later, which is the right way round for a request that spends nothing.

A sealed passport whose document asks for a private re-check is queued only while
[`/sealed/status`](#get-sealedstatuspassportid) says its copy is `kept`, and while it says
`unknown`, because the runner checks the status again before it spends anything. A copy that is
`gone` gets the same `409 sealed` a plain sealed passport gets.

## GET /recheck/status/:passportId

Where a request got to.

```ts
{
  passportId: `0x${string}`,
  status: "none" | "pending" | "running" | "done" | "failed",
  requestedAt?: number,
  startedAt?: number,
  finishedAt?: number,
  reportTx?: `0x${string}`,
  matched?: boolean,
  distance?: number,
  reason?: string
}
```

`none` means nobody has asked, which is also what a request that finished more than seven days ago
reads as: the verdict itself lives on the chain and on the passport page, and this queue only ever
remembered who asked for it. `reportTx` is the transaction the Chainlink report landed in, and it
is what separates `done` from `failed`. The answer carries `Cache-Control: public, max-age=30`,
because a re-check takes minutes and a waiting page should not poll this service every second.

| Code | When |
| --- | --- |
| `200` | Including `status: "none"` |
| `400` | The id is not `0x` and 64 hex characters |

## GET /recheck/queue

What the runner should pick up, oldest first, at most fifty. Reading it claims nothing.

```bash
curl -s http://localhost:4000/recheck/queue -H "authorization: Bearer $RUNNER_TOKEN"
```

```ts
{
  items: { passportId: `0x${string}`, requestedAt: number, requestedBy: "public" }[],
  pending: number,
  running: number
}
```

`pending` is the whole waiting line, so a runner can see there is more than the page it was handed.

## POST /recheck/claim

The runner takes one request before it starts work, so a second runner leaves it alone. Body is
`{ "passportId": "0x..." }`. Answers the status shape above with `status: "running"`, `startedAt`
and `reclaimed`.

| Code | When |
| --- | --- |
| `200` | Taken. `reclaimed` is true when the last runner had been gone half an hour |
| `404` | `no-request`. Nobody asked for this passport |
| `409` | `already-running`, or `not-pending` for a request that is already answered |

A request that has sat in `running` for more than thirty minutes may be claimed again, because that
means the runner died rather than that it is slow: a simulation is given ten minutes by the runner
itself. The worst case of a wrong guess is one duplicate second opinion, which the chain records as
another attestation and nothing more.

## POST /recheck/done

The runner says what happened.

```ts
{
  passportId: `0x${string}`,
  reportTx?: `0x${string}`,
  matched?: boolean,
  distance?: number,
  reason?: string
}
```

A report transaction is what makes a request `done`; without one it is `failed`, whatever else the
body carries, because a re-check with no report on chain did not happen. `reason` is cut to 200
characters. Answers the status shape, `404 no-request`, or `409 not-running` for a request nobody
claimed.

## The runner's token

The three routes above are the only ones on this service behind a shared token rather than a user
login, because there is exactly one caller and it is a machine.

| Code | When |
| --- | --- |
| `503` | `runner-disabled`. This host has no `RUNNER_TOKEN`, so it has no runner. A runner pointed at the wrong service learns that here instead of guessing at tokens |
| `401` | `unauthorized`. No `Authorization: Bearer ...` header, or the wrong token. The comparison takes the same time whatever is sent, so a caller cannot find the token a character at a time |

`RUNNER_TOKEN` must be at least 24 characters or the service refuses to boot. Nothing about the
queue is secret: the three routes are held closed because claiming and reporting work are writes,
not because the waiting line is private.

## Where the queue is kept

A JSON file at `RECHECK_QUEUE_PATH`, rewritten whole on every change: written to a temp name and
renamed over the real one, so a process killed mid-write leaves the last good file untouched rather
than half a file. It is loaded at boot, and a file that is missing, is not JSON or is from another
version starts the queue empty with one line in the log.

The queue never holds more than 1,000 requests, and a finished one is dropped after seven days or
sooner if the room is needed. A request that is still waiting or running is never dropped, which is
why a queue full of real work refuses the next caller with `queue-full` instead.

The default path is the service's own working directory, which the container's user cannot write
to. A host that wants the queue to survive a redeploy names a writable path, such as
`/data/recheck-queue.json` on a mounted volume. Without one the queue still takes requests and
still hands them to the runner; it forgets them when the process stops, and the cost of that is one
press of a free button.

## Today's budget for everyone

Four ceilings bound what the whole world may spend in a UTC day, on the four routes that cost
money, and a fifth bounds how many read links to private copies exist:

| Variable | Default | What it bounds |
| --- | --- | --- |
| `GLOBAL_PREPARES_PER_DAY` | 300 | Prepares, so about 1,200 Pinata pins and 300 sponsored registrations |
| `GLOBAL_GENERATIONS_PER_DAY` | 60 | Pictures the agent draws, so about two dollars of image model spend |
| `GLOBAL_EDITS_PER_DAY` | 150 | Edits, so about 600 pins and 150 sponsored `appendEdit` calls |
| `GLOBAL_UNSEALS_PER_DAY` | 50 | Sealed pictures published, so about 200 pins, and the pictures are whole files rather than thumbnails |
| `GLOBAL_LINKS_PER_DAY` | 100 | Links [`/sealed/link`](#post-sealedlink) mints, across every passport. It spends nothing; it bounds how much of the private store a stolen link token could open in a day |

Every other limit on this service is counted per Privy user id, and an account costs nothing to
make, so these are the only numbers that bound a determined caller with a hundred accounts.

Each ceiling is asked after the caller's token and their own allowance have both passed, and before
the first thing that costs anything, so a request with no token can never take a slot. Past a
ceiling the route answers `429` with the same body shape the per-user refusal uses:

```ts
{
  error: "global-limit",
  reason: "Moolam has reached today's limit for this action for everyone. It opens again at midnight UTC.",
  quota: { used: number, limit: number, resetsAt: number }
}
```

`resetsAt` is the unix second of the next midnight UTC, and the `retry-after` header holds how many
seconds that is from now. `global-limit` is not a code the studio knows, so it reads the 429 as the
"try later" it already shows, with the sentence above underneath.

Setting a ceiling to `0` closes that route for everyone. That is a kill switch: it can be flipped on
the host without a deploy, and the route answers the same 429 to every caller until it is raised.

All four routes hand a slot back whenever the request that took it spent nothing. The rule is the
same everywhere: the slot goes back on any exit before the first pin, which covers a signer that is
down, a queue that stayed full, a picture the registry already holds, a file that will not decode
and a record the service refused to publish. From the first pin onwards it stays taken, because the
ceiling bounds what is spent and a pin is money. `/generate` counts the drawing as the spend, so a
picture the provider drew keeps its slot however the request ends, and a prompt the model turned
down hands it back.

What this does not do. The counts live in one process's memory, exactly like the per-user
allowances, so a redeploy resets them and a second copy of the service would keep its own. They
bound how many actions a day holds, never what one of them costs. And the real bound on sponsored
gas is the daily cap on the Privy app, which is a dashboard setting that no code here can enforce.

## Nothing on these routes is cacheable

Every reply to a POST on `/prepare`, `/generate`, `/edit` and `/unseal` carries
`Cache-Control: no-store`, whatever its status. It is set in one hook on the way out rather than by
each route, so the replies no handler writes carry it too: the `401` sent before the body is read,
the `413` raised in the middle of an upload and the `429` from the rate limiter. These answers hold
a title, a prompt, a wallet address or, for a sealed registration, the only copy of a picture, and
none of that belongs in a proxy or a browser store.

`GET /unseal/:passportId` is in the same hook for a different reason: whether a passport is still
sealed is the one fact on this service that turns from private to public in an instant, and a
cached "still sealed" would show a sealed plate over a picture that is already out. `GET /health`
and both verify routes are untouched by this.

The three `/recheck` POSTs are in the hook too, and so is `GET /recheck/queue`, which is the one
answer here that exists only because the caller held the runner's token and must never be replayed
to anyone else. `GET /recheck/status/:passportId` is the exception on this service: it is public,
it is asked repeatedly while somebody waits, and it says so with `Cache-Control: public,
max-age=30`.

`POST /sealed/link` and `POST /sealed/forget` are in the hook as well: a link is a bearer secret
until it expires, and a delete names a holder's passport. `GET /sealed/status/:passportId` sets its
own header: `public, max-age=60` for `kept` and `gone`, `no-store` for `unknown` and every refusal.

## GET /health

```bash
curl -s http://localhost:4000/health
```

```ts
{
  ok: boolean,
  records: number,
  version: string,
  routes: string[],
  limits: {
    prepares: { used: number, max: number },
    generations: { used: number, max: number },
    edits: { used: number, max: number },
    unseals: { used: number, max: number },
    links: { used: number, max: number }
  },
  recheck: { pending: number, running: number },
  sweep: {
    mode: "off" | "dry" | "delete",
    lastRun: null | {
      at: string,                         // ISO 8601, when the run started
      mode: "dry" | "delete",
      outcome: "finished" | "stopped",    // stopped: a listing or chain read failed, nothing marked
      more: boolean,                      // the listing stopped at 10 pages or 200 files
      counts: { listed, oddNames, undated, young, registered, marked, deleted, failed }
    }
  }
}
```

`records` is how many passports the index is holding, which is what tells you whether the service
booted against the source you meant. It is re-read from the source every `INDEX_REFRESH_MS`, a
minute by default, so a passport registered a minute ago verifies without a redeploy. `version` is
the package version. `routes` is what this host actually mounted, which is where a deploy missing a
key becomes visible from outside: a host without `PINATA_JWT` still boots and still verifies, and
`prepare` is simply not in the list.

`limits` is how much of [today's budget for everyone](#todays-budget-for-everyone) is gone, so a
daily check can see a ceiling coming before creators meet it. `links` is the private read links
minted today against `GLOBAL_LINKS_PER_DAY`. It counts the whole world and names nobody: there is
no per-caller data on this route. A host that mounts the unseal routes lists `sealed` in `routes` too.

`recheck` is how many second opinions are waiting and how many a runner has in hand, which is where
a runner that has died shows up from outside: `pending` climbs and `running` stays at zero.

`sweep` is the hourly sweep of private copies whose passport never reached the chain, set by
`PRIVATE_SWEEP`. It first runs an hour after boot and never at boot. Each run lists at most 10 pages
and 200 files named `sealed-thumb-`, keeps only exact thumbnail names Pinata says were uploaded more
than 48 hours ago, and marks a file only when the registry answered that its passport does not
exist. A chain read that failed, a listing it could not finish or an answer in an unknown shape
stops the run with nothing marked. In `dry`, the default, the host's log names each file it would
delete and its age in hours; in `delete` it deletes them. `off` is also what a host with no Pinata
token reports. No file name, file id or reason appears here: they stay in the host's log.

This is the one route outside the 60-a-minute limit. A status page, an uptime monitor or a build
pre-rendering hundreds of pages may probe it as often as it likes and never reads a refusal as an
outage; the answer costs microseconds. Every other route keeps the limit.

## Unknown routes

Answered with `404` and `{ "error": "no route for <METHOD> <path>" }`, as JSON rather than HTML.
Every rejection is logged with its reason and the caller's address.
