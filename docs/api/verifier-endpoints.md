---
title: Verifier endpoints
---

# Verifier endpoints

Thirty-one routes. Everything is JSON, including errors and 404s, except that `/mcp` may answer a
tool call as a short event stream. The service listens on `VERIFIER_PORT`, which defaults to 4000.
Twenty-two of the thirty-one are mounted only when the host is configured for them: `/verify/paid` needs
`X402_ENABLED`, `/prepare` needs a Pinata token and a Privy app id, `/generate` and `/edit` each need
those plus their own keys, the two `/unseal` routes and the three `/sealed` routes need exactly what
`/prepare` needs, and the four `/platform` routes need that plus `PRIVY_APP_SECRET` and a platform
list that loads. The two [`/challenges`](#post-challengespassportidanswer) routes need `PINATA_JWT`,
because an answer is pinned. The five `/claims` routes and the two `/platform/deliveries` routes are mounted
with the `/platform` routes, and answer `503` `claims-unavailable` until the host has both
`CLAIM_PEPPER` and `CLAIM_PEPPER_VERSION`. An unmounted route answers `404` like any other path that does not exist. The five
`/recheck` routes, the two `/lookalikes` routes and `/mcp` are mounted on every host, and the three `/recheck` routes the runner
uses answer `503` until `RUNNER_TOKEN` is set. `/sealed/link` answers `503` until
`SEALED_LINK_TOKEN` is set.

**Two routes that also need the Privy app secret.** `POST /unseal` and `POST /sealed/forget` decide
who holds a passport by reading the caller's embedded wallets from Privy, and that read needs
`PRIVY_APP_SECRET` as well as `PRIVY_APP_ID`. A host that has what `/prepare` needs and no app secret
leaves those two off and mounts the rest of the family: `GET /unseal/:passportId`,
`GET /sealed/status/:passportId` and `POST /sealed/link` stay on, because none of them reads a
wallet. The boot log names each route left off and why, and [`/health`](#get-health) lists `unseal`
in `routes` only when `POST /unseal` is on, while `sealed` is listed whenever the family is mounted.

**Three routes that also need a signer that loads.** `/prepare`, `/generate` and `/edit` sign each
picture's C2PA manifest. A host whose signing certificate and key do not load still boots, keeps
`/verify`, the re-check queue and the unseal and sealed routes serving, and leaves those three off:
they answer `404`, the boot log says why, and [`/health`](#get-health) names each under `off`. Only
an `EXPECT_ROUTES` that names one of them still stops the boot.

## How a passport's metadata document is read

Several answers depend on a passport's metadata document: the `picture` fact on
[`/verify`](#post-verify), the sealed check behind [`/recheck/request`](#post-recheckrequest), both
[`/unseal`](#post-unseal) routes, the three `/sealed` routes, and the unseal record itself. The
address comes off the chain, where a registrant can write anything, so every one of those reads
follows the same rule:

- Only a bare pinned content id is read: `ipfs://` followed by letters and digits and nothing else.
  An `http` or `https` address, or an `ipfs://` address with a path, is refused before any request is
  made. The test is a byte for byte copy of the one the Chainlink workflows use, so this service, the
  runner and both workflows refuse exactly the same addresses.
- It is read through the configured `PINATA_GATEWAY_URL` and no redirect is followed. Any status but
  `200` is a failed read.
- The body may weigh at most 64 KB, counted after decompression. A declared length over that is
  refused unread, and otherwise reading stops at the first chunk past the cap, so a small body that
  inflates to gigabytes stops there too. A Moolam document is under 2 KB.
- A body that is not JSON is a failed read.

A failed read is never an answer in either direction. Each route turns it into its own "could not
tell": `unavailable` on `/verify`, `metadata-unavailable` or `lookup-unavailable` on the unseal and
sealed routes, and a request let through on `/recheck/request`.

## POST /verify

Takes an image and returns the passport it belongs to.

**Request.** Either a multipart upload in a field named `file`, or a JSON body of
`{ "url": "https://..." }`. Both are capped at 20 MB. The URL form is fetched server-side within one
10 second limit that covers every lookup, every redirect and the body, with the same cap enforced
while the body streams in. Only JPEG, PNG and WebP are read, the same three the studio and the
verify page take: the file signature is checked before any library decodes the bytes, so an SVG, a
GIF or a TIFF is refused in milliseconds, whatever it declares inside. The one exception is a file
that is byte for byte a registered passport, see "An exact hit" below.

```bash
curl -s -F "file=@packages/verifier/test-assets/original.jpg" http://localhost:4000/verify
```

```bash
curl -s -X POST http://localhost:4000/verify \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/photo.jpg"}'
```

**Response.** `200` with `{ result, manifest, index }`.

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
    matches: Match[],               // best first, at most 20. A match may carry
                                    // firstRegistered: true, see below
    confidence: number,             // 1 for an exact hit, 0 when nothing matched
    queried: {
      sha256: `0x${string}`,
      phash: string,                // decimal, see the note below
      blockhash: `0x${string}`,
      width: number,
      height: number,
      format: string
    },
    laterSameFingerprint?: number,  // absent when nothing matched, see below
    firstRegisteredId?: `0x${string}`, // absent unless the first registration is not best
    note?: string                   // only on an exact hit whose pixels could not be read
  },
  manifest: {
    present: boolean,
    validation?: "valid" | "invalid" | "unreadable", // see below
    credential?: "expired" | "untrusted", // only on a "valid" manifest, see below
    failures?: string[],            // with "invalid", and with a "valid" one that carries credential
    manifestHash?: `0x${string}`,   // sha256 of the C2PA store's own box, see below
    title?: string,
    claimGenerator?: string,
    actions?: string[],
    ingredients?: number,
    softBinding?: {
      alg: string,                  // "com.moolam.phash-blockhash.v1"
      phash: string,                // decimal
      blockhash: `0x${string}`
    }
  },
  index: {
    loadedAt: number,               // unix seconds, the last good load of the passport index
    stale: boolean,                 // true once that load is too old, or the indexer behind it is behind, see below
    indexedTo?: number | null,      // on an Envio host, the newest block the indexer had processed
    indexedAt?: number | null       // on an Envio host, that block's time in unix seconds
  }
}
```

**How current the index is.** Matches run against a copy of the passport index this service holds
in memory and reloads every `INDEX_REFRESH_MS`, a minute by default. A reload that fails keeps the
copy it has. `index.loadedAt` is when the copy in hand last loaded, and `index.stale` turns true
once that is more than five refresh periods ago, five minutes by default, and false again after the
next good load. A stale answer is still a real match against that copy, but a picture registered
since it loaded may be missing from it, so a "no match" from a stale copy is not proof the picture is
unregistered. The verify card says so in one line beside the verdict: "Moolam's copy of the register
is {minutes} minutes old, so a picture registered since then may not show yet." A host with
`INDEX_REFRESH_MS=0` never reloads and is never stale on that count. [`/health`](#get-health)
carries the same fields.

**How far the indexer had read.** A host whose `PASSPORT_SOURCE` is `envio` also reads, on every
load, how far the indexer behind the copy had got. `indexedTo` is the newest block the indexer says
it has finished, taken from Envio's own `chain_metadata` and never from the newest passport it
holds, and `indexedAt` is that block's time in unix seconds, read from the chain. Each is `null`
when it could not be read. `stale` is then also true when, at that load, the indexer was more than
ten minutes of block time behind the chain head, still said it was syncing, or either block time
could not be read: an indexer nobody can show is current is never called current. Both block times
come from the chain's RPC, so an RPC that does not answer turns every answer stale until it does. A
host reading the JSON file has no indexer and leaves both fields off.

Every field of one answer comes from one copy of the index: the match, the exact lookup, the four
facts below and `index` all read the copy that was in hand when the match began, so a reload that
lands in the middle of a request never mixes two copies in one answer.

**No production host without the indexer.** A host whose `NODE_ENV` is `production` refuses to
boot unless `PASSPORT_SOURCE` is `envio`. Unset reads as `json`, and the deployed image carries
no passport file, so a production host on that default would load an empty register and call every
picture unregistered while `/health` looked fine. The boot error names `PASSPORT_SOURCE`.

The 64-bit pHash goes out as a decimal string, never a JSON number, because a double cannot hold
it. That applies to `result.queried.phash` and to `manifest.softBinding.phash`.

`queried` is always the identity fingerprint, which is what a caller would register or display,
even when the best match came from a rotated variant. `variant` names which of the eight found it.

**Whether the manifest checks out.** `manifest.validation` is what the C2PA library's own validation
made of the file, and it is one of three words, or absent:

- `valid`: a manifest is present, and its signature and its bindings to these bytes check out. The
  signing certificate is not looked up on any trust list, so `valid` says the file is the one that
  was signed, not who signed it.
- `valid` with `credential`: the library failed the manifest for a signing certificate alone, and
  for nothing else. Moolam signs without a trusted timestamp, so the library judges each certificate
  against today: once a leaf that signed the file, Moolam's own or a camera's inside the file, passes
  its end date, the untouched file reports `signingCredential.expired`, and a certificate on no
  trust list reports `signingCredential.untrusted`. Neither says a byte or a claim changed.
  `credential` is `expired` when any certificate expired and `untrusted` otherwise. The verify
  card still calls the record signed, with one quiet line on the certificate. A camera certificate
  that had already expired when Moolam signed over it is recorded inside the camera's ingredient
  rather than reported for the file, so that file reads plain `valid`.
- `invalid`: a manifest is present and anything else short of a clean pass came back, which usually
  means the file was altered after signing or the manifest was moved here from another file. Every
  code but those two keeps the manifest invalid, `signingCredential.revoked`,
  `signingCredential.invalid` and any code this service has never seen included.

`failures` carries the library's failure codes, such as `assertion.dataHash.mismatch`, from the
active manifest, from each ingredient's deltas, which is where a camera certificate that expired is
recorded, and from the flat status list. It is sent with `invalid`, and with a `valid` manifest that
carries `credential`, so the certificate's own code is named. Only short dotted codes of letters,
digits, dots, underscores and hyphens, at most 64 characters each, are kept, duplicates are dropped,
and the list stops at eight, so a crafted manifest cannot use the field to put text of its own into
the answer. Whether a manifest is `valid` is decided on every code the library reported, before
any is left out of the list.
- `unreadable`: the file carries C2PA data the library could not parse, the library could not
  read the file at all, the file names a manifest stored elsewhere instead of carrying one, or the
  read was still running after five seconds. `present` is `false`, and no other manifest field is
  set. A damaged manifest costs the caller the manifest and never the match.
- Absent: the file carries no manifest, and `present` is `false`.

A remote manifest is never fetched. A file can name one by address in its XMP, and the C2PA library
would request it, from this host and to wherever the uploader pointed it; every read here, and every
signing that reads an upload's own store, runs with that fetch switched off. A read given up on at
five seconds keeps running inside the library until it ends, and its answer is dropped.

`manifestHash` is the sha256 of the C2PA manifest store's own JUMBF box, reassembled from its APP11
segments: the first box labelled `c2pa`, and nothing beside it. Another JUMBF box in the same file,
a 360 degree description or another tool's data, does not move the hash. It is set only for a JPEG.

A match must clear both thresholds: pHash at most 10 of 64, blockhash at most 40 of 256. Past
either one, nothing is returned and `confidence` is 0.

**An exact hit.** When the bytes are byte for byte a registered file, `exact` names it, `best` is
that passport and `confidence` is 1, whatever the distances say. `phashDistance`, `blockhashDistance`
and `score` are still measured, against the fingerprint the passport stored rather than written as
0: the registry cannot check that a fingerprint belongs to its bytes, so a passport carrying another
picture's fingerprint shows how far off it is. `score` is never below 0, which is what it reads when
the stored fingerprint is past a threshold.

The bytes are hashed and looked up before the format and pixel checks. The registry takes any
sha256, so a passport registered straight on chain from a GIF, a HEIC or a picture over 40
megapixels is still answered exact by its own file, where anything else in that format is refused.
Its pixels are not read, so that answer carries `confidence` 1, a `best` and a single entry in
`matches` with only `id` and `variant: "identity"`, no distances and no `score`, a `queried` with
only `sha256`, no earlier registration, and `note`: "this file is byte for byte the one this
passport registered, but its pixels could not be read here, so no distances were measured".

**The first registration.** The closest match leads, but anyone can register a re-encoded copy of
someone else's picture, and a copy a bit or two closer to the query would beat the original on
distance alone. So the passport registered first among everything inside the thresholds is always
in `matches`, whatever the cap of 20: when it would have been crowded out, it takes the last place.

- `firstRegisteredId` is that passport's id. It is present only when it is not `best`, which is the
  case a caller has to look at: the headline match is not the earliest claim on the picture.
- `firstRegistered: true` marks that passport's entry in `matches`. It is set only when the answer
  names more than one passport, so a one-passport answer keeps the shape it always had.
- That entry carries the same four facts as `best`, read the same way: `consent`, `dispute`,
  `recheck` and `picture`, below. A near copy registered later by someone else can be the closest
  match and carry its own holder's `allowed`; the original's own statement is then right beside it,
  so the copy's word is never the only one in the answer.
- On the exact path, where the bytes are a registered file, an earlier registration is looked for
  with the identity fingerprint only, so an exact hit still costs one decode. An earlier passport
  that matches only a rotated or mirrored copy is not surfaced there.

**Later copies of the same fingerprint.** Passports that carry exactly the same fingerprint are
folded into the one registered first, so every place in `matches` is a distinct fingerprint and a
pile of copies cannot fill the list. `laterSameFingerprint` says how many passports registered
after `best` carry exactly its fingerprint: `0` when there are none. It rides along only when
something matched, so an answer with `best: null` has the shape it always had.

**What the holder said about AI use.** The exact match, the best match and the first registration
each carry `consent`, read live from
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
      writer: `0x${string}`,        // the address that held the passport when it was written
      readAt: number }              // unix seconds, when this service read it, see below
  | { source: "chain", stated: false, readAt: number }
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

At most three passports are read per verification, the exact match, the best match and the first
registration, each once however many of those it is. The other near misses in `matches` carry no
facts, so twenty candidates never mean twenty chain reads. Each answer is held in the service's
memory for at most 10 seconds, because a new holder, or the same holder through a second wallet,
can restate within seconds. `readAt` says when the answer was read, so a caller can see how old a
remembered one is. `constraintInfo` is returned exactly as the chain holds it, and is dropped if it
is not within the 256 printable ASCII bytes the contract promises, because this answer is input to
other people's parsers.

**Whether the passport is under dispute.** The same matches carry `dispute`, read live from the
registry's own dispute view at `MOOLAM_REGISTRY_ADDRESS`
(`0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0`), under the same limits: at most three passports, a five
second cap, and a failed read that never fails the verification. `upheld` is the ruling's last word
and is held in memory for 60 seconds; `none`, `open` and `rejected` can change with the next block
and are held for at most 10 seconds.

```ts
type Dispute =
  | { source: "chain", status: "none", readAt: number }      // nobody has challenged this passport
  | { source: "chain", status: "open", readAt: number }      // a challenge is open, with a bond behind it
  | { source: "chain", status: "upheld", readAt: number }    // the challenge stood: the record is marked disputed
  | { source: "chain", status: "rejected", readAt: number }  // the challenge was settled against the challenger
  | { source: "unavailable" }                                // this service could not find out
```

`readAt` is the unix second the registry was read, as on `consent`.

The four words are the registry's own `DisputeStatus` enum, mapped one for one. A status the enum
has no room for comes back `unavailable` rather than as a guess at the nearest word.

**Read `consent` and `dispute` together.** A statement on a passport whose dispute is `open` or
`upheld` should not be relied on: the registry's design says that record is in question, and the
holder's word about AI use rests on that record. `unavailable` on either field is not permission and
not a clean record, it is this service saying it could not find out. The chain is read rather than
the passport index because a dispute opened since the index was last rebuilt is exactly the one a
reader must not miss.

**Whether an earlier version lost a challenge.** The registry marks only the passport a challenge
named, and an edit of a disputed passport is still allowed, so an edit reads `none` in its own
`dispute`. The same matches carry `inheritedDispute` beside it. The eight nearest passports above
the match are read on chain, whatever lies beyond them, through the same reader, memory and timeout
as `dispute`.

```ts
type InheritedDispute =
  | { source: "chain", status: "upheld", ancestor: `0x${string}`, readAt: number } // the nearest ancestor whose challenge stood
  | { source: "chain", status: "none", readAt: number }                             // every ancestor read, none upheld
  | { source: "unavailable" }                                                       // see below
```

`upheld` is the answer whenever any of those eight reads upheld, even when a read of another failed
or the chain goes deeper than eight, and it names the nearest such ancestor. `none` is said only
when every ancestor was read, which means a chain of eight or fewer that the index could follow to
the original. Anything else is `unavailable`: a failed read with nothing upheld, a chain deeper than
eight with nothing upheld among the eight, a parent the index does not hold, or a loop. `readAt` is
the upheld ancestor's read, or the oldest of the reads behind a `none`. An open or rejected
challenge above does not carry down. The web app shows the upheld case as one
line under the dispute line, linked to the ancestor's passport, and says nothing new for the others.

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
  | { state: "public", readAt: number }                // registered in the open
  | { state: "sealed", readAt: number }                // registered without the picture, which was never published
  | { state: "unsealed", at: string, readAt: number }  // registered sealed, published later by its holder
  | { source: "unavailable" }                          // this service could not find out
```

`at` is the ISO 8601 time from the unseal record, the moment the holder published the picture.
`readAt` is the unix second the state was read, as on `consent`. The
state is read from the passport's metadata document and, only for a document that says sealed, from
the unseal record pinned under the passport's id, which is believed only when it names this
passport. A document that cannot be read, a record lookup that fails, and anything slower than the
same five second cap the other reads get come back `unavailable`, never as `sealed` or `public`, and
never fail the verification.

`public` and `unsealed` are held in memory for good, because a document is written once and an
unseal record is never taken back. `sealed` is held for at most 10 seconds, since it is the one
answer the holder can change.

In short, the answers that are final are remembered as before: `public` and `unsealed` for the life
of the process, and an `upheld` dispute for 60 seconds. Every answer that can still change, the
holder's statement, a dispute that is `none`, `open` or `rejected`, and `sealed`, is at most 10
seconds old, counted from the moment its read began, and each says when it was read in `readAt`. A
read that ends after a newer one never replaces it, so no answer goes back to an older state.
Nothing in the field says where the picture lives: a sealed match carries no
address to try, and an unsealed one is found through [`GET /unseal/:passportId`](#get-unsealpassportid).

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Matched, or ran and found nothing. Finding nothing is a 200 with `best: null` |
| `400` | No multipart `file` field and no `{ "url": "..." }` body, a part named something other than `file`, an empty file, or an upload that is not a JPEG, PNG or WebP the service can decode |
| `413` | Over the 20 MB byte limit, or over 40 megapixels once decoded |
| `429` | Over 60 requests in a minute from that caller. The address is read from the hop named in `TRUST_PROXY`, so a service behind a proxy counts callers rather than the proxy. An IPv6 caller is counted by its /64, because every IPv6 host is handed at least that many addresses and could otherwise take a fresh count for each request; an IPv4 address written inside IPv6 counts as the plain IPv4 address, and an address that cannot be read shares one count with every other such address. A host holding more than a /64 still has one count per /64 |
| `502` | `{ "error": "that address could not be fetched" }`, and nothing else, for every URL the service would not or could not fetch: one that resolves to a loopback, private, link-local, unique-local, carrier-grade NAT, multicast, reserved or cloud metadata address before or after any redirect, a name that does not resolve, a port that refuses or does not answer, too many redirects, or a fetch that ran past its 10 seconds. The reason goes to the service log only, so the answer says nothing about which names resolve inside Moolam's network or which ports answer from its address |
| `502` | The remote host answered with a non-2xx status, failed part way through the body, or sent more than it declared |
| `503` | `{ "error": "busy" }`. No turn at the decode gate came free inside `MATCH_WAIT_MS`, 30 seconds by default, or the uploads being sent right now already fill the 200 MiB ceiling or this caller's 40 MiB share of it, see below. Nothing is wrong with the picture; send it again |
| `503` | `{ "error": "service-fault", "reason": "the service could not read this picture right now, try again" }`. The service, not the picture, failed while matching: a blockhash worker that crashed, stopped or ran out of time, a hash of the wrong length, a decoder out of memory, or a failure nobody named. It is logged, and the picture is fine to send again. A file that is not one of the three formats, or whose pixels the decoders refuse, is still a `400` |

Errors are `{ "error": "<reason>" }`. The answers no route writes itself have the same shape:
Fastify's own `413` for a body past the limit, its `415` for a content type it does not read and the
rate limiter's `429` carry Fastify's words, and any `5xx` says only
`{ "error": "verifier failed to handle the request" }`, with the reason in the host's log.

Error text is cut before it is logged or answered, on every route: each web address in it is cut to
its origin, and every `URL:` or `Request body:` line is dropped. A dedicated RPC endpoint's path is
its access key, and the chain library writes the endpoint it called into its own errors, so an error
from the chain is told by its name and short message only. The same rule quotes a URL the caller sent
back by its origin.

**How much is held at once.** Every upload sent to `/verify`, `/verify/paid`, `/prepare`, `/edit`
or `/unseal`, a file or a URL, counts against one ceiling of 200 MiB, ten full uploads. It counts the
bytes that have actually arrived, chunk by chunk as they come in, never the length the request or
the remote host declares, so a body trickling in holds only what it has sent. One caller, counted by
the same address the rate limit counts, may hold 40 MiB of it at once, two full uploads, so a browser
can send a verify while a registration is still uploading and one address cannot hold the room
everyone else needs. Once the body is in, only the file stays counted. The share comes back when the
route's handler has finished with the bytes, not when the connection closes: a caller who hangs up
while a match or a studio job still holds their bytes keeps them counted until that work ends. The
moment a chunk would pass the ceiling or the caller's share, the request is answered `503 busy` and
the rest of its body is dropped unread. A caller who has hung up is not read, fetched or queued any
further, and a turn at the decode gate whose caller left while it waited is skipped rather than run.

A body that stops arriving is closed after 30 seconds with nothing arriving, and its share comes
back. A request whose body is in is never cut off by that limit while it waits for a turn or its
work runs. Every request must arrive whole within 180 seconds, which still lets a 20 MB upload
through a slow phone uplink of about 1 Mbit/s.

**Turns at the decode gate.** At most three pictures are decoded at once. Verifies, the match and
the manifest read of `/verify` and `/verify/paid`, may hold two of the three, so one turn is always
left for `/prepare`, `/edit` and `/unseal`, which may also take a verify turn that is free. One
caller holds one turn at a time: a second request from the same address waits while other callers go
ahead of it. A request that gets no turn inside `MATCH_WAIT_MS`, 30 seconds by default, is answered
`503 busy`.

**Signing.** `/prepare`, `/generate` and `/edit` sign each C2PA manifest on one worker thread of
its own, one file at a time in the order they came, so the thread that answers requests does not
stall while a large file is signed. A signing worker that crashes, stops or runs past 30 seconds is
thrown away and the next file gets a fresh one; `/prepare` and `/edit` answer the file it held
`502 sign-failed`, with nothing pinned.

**The blockhash workers.** Two worker threads work out the blockhash, so the thread that answers
requests never decodes pixels. A worker is replaced, after it answers, when its decoder threw on the
way, when the picture was over 8 megapixels, or once the files it has been handed pass 64 MiB in
total: the decoder keeps memory it never gives back, and a leak nothing reports is bounded by that
budget. A worker that crashes, stops or runs past 30 seconds is replaced too, and that request
answers `503 service-fault`.

The five routes that read a picture, `/verify`, `/prepare`, `/generate`, `/edit` and `/unseal`,
answer a fault of this service with the same `503 service-fault` and the same sentence, beside
`503 busy`. Each says under its own status codes what it hands back.

## POST /verify/paid

The same answer as `/verify`, behind an x402 payment: 5 cents in USDC on Monad mainnet by default,
settled by Monad's facilitator.

Mounted only when `X402_ENABLED=true`. Otherwise the path does not exist and the service answers
`404`.

**Request.** A multipart `file` upload only. The free route also accepts a remote URL, and that
path carries the checks that stop a fetch reaching a private address; rather than copy those checks
and risk the two copies drifting, the paid route does not offer it.

**Response.** `200` with the same `{ result, manifest, index }` body as `/verify`, and the base64
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
| `402` | No payment, or the facilitator refused this one when it checked it, before anything was matched. The terms ride in the base64 `PAYMENT-REQUIRED` header, whose `error` field carries the refusal, and the JSON body says in words what to do next. At settlement a refusal answers `402` only on the second ask, and only when the chain shows the payment was not spent, see below. A payment that already bought an answer about another file goes through this same payment check, as a payment this service never saw would, so the answer never says which file it was for; it is never served for the other file |
| `402` | `{ "error": "payment-unreadable", "reason": "..." }`. The payment header is there, and this service cannot read a payer, a nonce and every signed field from it as strings. It is refused before the upload is read and before the facilitator hears of it, because a payment the in-flight mark and the answer ledger cannot be keyed on could otherwise buy several answers. Nothing was checked or charged: pay with an x402 client, which signs every authorisation field as a string, and send it again |
| `400`, `413` | Same as `/verify` |
| `404` | `X402_ENABLED` is not `true` |
| `429` | Over 60 requests in a minute |
| `409` | `{ "error": "payment-in-flight", "reason": "..." }`. Another request is working on the same payment, the same payer and nonce, right now. It is checked once the upload is read and before the facilitator is asked, so two requests never settle one payment side by side, and a body sent slowly under someone else's payment holds nothing. Send it again once the first has answered: the same payment with the same file then gets the answer it bought |
| `500` | `{ "error": "payment-misconfigured" }`: the route is mounted where x402 is not collecting a payment, so it serves nothing rather than answer free |
| `502` | The facilitator did not answer, or the payment could not be checked |
| `502` | `{ "error": "settlement-unknown", "reason": "..." }`. Nobody could say whether the payment went through, the first settle was refused with no transaction and the chain did not show the payment spent, or the facilitator broadcast the transfer and the chain did not yet show it landed, see below. Nothing was cancelled and the answer is held against the payment. The same payment with the same file answers this again, without reaching the facilitator, while the chain cannot be read |
| `503` | `{ "error": "busy" }`. No turn at the decode gate came free in time, or the upload ceiling under `/verify` or this caller's share of it was full. Nothing is settled or held, the authorisation is cancelled, and the same payment and picture can be sent again |
| `503` | `{ "error": "service-fault", "reason": "the service could not read this picture right now, try again" }`. The service, not the picture, failed while matching, as under `/verify`. Nothing is settled or held, the authorisation is cancelled, and the picture is fine to send again |

A settlement the facilitator has broadcast but not yet confirmed answers `200`, with a pending
receipt, once the chain shows its transaction landed, and a repeat of the same payment inside ten
minutes is answered from this process's memory without settling again. That memory is keyed on the payer and the nonce together, because an
EIP-3009 nonce is unique per payer and not across payers, and it hands an answer over only to a
request carrying the same signed payment, every field and the signature, and the same file.

Payment is settled only after the match succeeds, so a failed verification never charges. When the
match itself fails after a payment was verified, before anything is settled, the authorisation is
cancelled rather than left standing against the payer. Nothing is cancelled once settlement has
been asked for: a settle that throws or answers in words is never read as a refusal.

**When nobody can say whether it settled.** A settle call that throws, times out or answers with a
reason in words rather than a facilitator code says nothing about whether the transfer happened.
Neither does a first settle refused with a code and no transaction: the reference facilitator
answers that way whenever its own transfer call throws, including an RPC that took the transfer and
then timed out. For a first refusal the route asks the chain; a payment the chain shows spent is
answered `200`, and anything else answers `502 settlement-unknown` with the verification held. For
the other cases it asks the chain, then the facilitator once more. A payment the chain shows spent
is answered `200`. A second refusal counts, as a `402`, only when the chain says the payment was not
spent. Anything else answers `502 settlement-unknown`, and the verification is kept against that
payment and file. Sending the same payment with the same file again hands it over once the chain
shows the payment spent, and that check runs before the facilitator is asked about the repeat,
because the facilitator refuses a nonce already spent. A held answer is never released on a "not
spent" read, which is also what a first transfer still pending looks like; the same payment with
another file, or a retry while the chain cannot be read, leaves it in place for the retry that can
prove the payment, until its ten minutes run out. A retry while the chain cannot be read answers
`502 settlement-unknown` again and never reaches the facilitator: sent through as a new payment, a
payment that did land would meet its own spent nonce there and come back as a fresh `402` asking
for a payment already made.

**How the chain proves a payment.** Spent is proven from the pay asset itself, never from one
flag. USDC's `authorizationState` for the payer and nonce is read first: `false` means the
authorisation was never used, so nothing was charged. `true` is not enough on its own, because it
is equally true after the payer cancelled the authorisation or another request spent it. So the
transaction that used it is found and read: first any the facilitator named, then the asset's own
`AuthorizationUsed` log for this payer and this nonce, searched from five blocks before the block
read when the payment was first held, in chunks of 100 blocks, at most 50 of them, up to the block
whose time passes the authorisation's `validBefore`, since EIP-3009 refuses the transfer after
that. A transaction counts only when its receipt is a success and carries both events from the
asset contract: `AuthorizationUsed` for this payer and nonce and, as the very next log after it,
the `Transfer` that authorisation moved, from the payer to the payee, for exactly the value the
payer signed, which must be at least the price. USDC's `transferWithAuthorization` emits the two
in that order, so a `Transfer` anywhere else in the receipt belongs to some other authorisation,
and one transaction that spends several nonces beside one real transfer proves one payment, not all
of them. The next log is found by its `logIndex` when the receipt carries one, and by its place in
the list when it does not.

A payment held while the newest block could not be read has no block to start from, so its search
starts at the first block whose time is past the authorisation's `validAfter`, the earliest block
the transfer can land in. When the blocks from there to `validBefore` are more than one search
reads, as they are for the x402 client's `validAfter` of 0, the search covers the newest of them,
ending at the last block before `validBefore`, and finding nothing there answers "cannot tell",
never "not spent". Not spent is `authorizationState` false, or a search that covered every block
up to `validBefore` with no such transaction. A read that fails, or a search that ran out of chunks
first, is "cannot tell".

**When settlement is broadcast but not yet confirmed.** The facilitator can answer a settle call
with `settlement_pending`: the transfer is on chain but its receipt has not been seen in time. The
route asks once more, five seconds later, and if that does not confirm it either, it asks the chain,
as above, starting with the transaction the facilitator named. When the chain shows that transaction
landed, the route returns `200` with the verification and a `PAYMENT-RESPONSE` whose `success` is
false, whose `errorReason` is `settlement_pending`, and which carries the transaction hash. Otherwise
it answers `502 settlement-unknown` and holds the verification against the payment, exactly as for a
settle nobody could read: a broadcast transfer can still revert, when the payer's balance moved
first, or be dropped, and serving it then would give the answer for nothing. It does not cancel:
the authorisation is signed for that one amount and the transfer may still land, and the same
payment with the same file is handed the answer once the chain shows it did.

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

Mounted only when the host has both `PINATA_JWT` and `PRIVY_APP_ID`, and a signing certificate and
key that load. Otherwise the path does not exist and the service answers `404`.

**Request.** A multipart body with three parts, in any order.

| Part | Type | Rule |
| --- | --- | --- |
| `file` | file | The image, a JPEG, PNG or WebP. Up to 20 MB and 40 megapixels. A file part under any other name is a `400` |
| `title` | text | 1 to 120 characters after trimming. It becomes the passport's name and the C2PA title |
| `kind` | text | `human` is the only value the studio takes today |
| `training` | text | Optional. A JSON object saying how AI may use the picture: `aiTraining`, `aiGenerativeTraining`, `aiInference` and `dataMining`, each `allowed`, `notAllowed` or `constrained`, plus `constraintInfo` when a choice is constrained |
| `sealed` | text | Optional, `true` or `false`; left out or blank is `false`, and any other word is a `400` rather than being read as `false`. `true` registers the picture without publishing it: it is signed and fingerprinted the same way, then only one small metadata document is pinned, and the signed file comes back in the answer as `signedFile`, base64, as the only copy there will be, beside `sealed: true` |
| `privateRecheck` | text | Optional, `true` or `false`. `true` is accepted only together with `sealed` set to `true`, and keeps one private thumbnail for a later private Chainlink re-check, see below. Without `sealed` it is a `400` |

The `training` statement is written into the signed C2PA manifest as one `cawg.training-mining`
assertion and into the pinned metadata, so it travels inside the file and sits under the creator's
passkey signature, which signs the metadata address. A choice left out states nothing at all, which
is not the same as allowing it. `constraintInfo` is required when a choice is `constrained`, refused
otherwise, and is at most 256 bytes of printable ASCII, the same rule the consent contract enforces,
so a statement made here can be written on chain unchanged.

**The private re-check.** With `sealed=true` and `privateRecheck=true` the service keeps one more
thing: a thumbnail of the signed file, 512 pixels on its longest side and made exactly as a public
prepare makes one plus one JPEG comment naming the passport id, so no two passports' copies share a
content id and the pixels are unchanged, uploaded to Pinata's private network under the name
`sealed-thumb-<passport id in lower case>.jpg` with the passport id as the `passportId` key-value.
Private files are not served on the public IPFS network; Moolam's operator and the Pinata account
holder can still open it. The order is fixed: the registry is asked whether the picture is already
registered, then the private copy is uploaded, then the metadata document is pinned. The copy is
kept only when Pinata answers that it is private under exactly that name, and it is deleted again if
the document pin fails, unless Pinata already held that file before this request. Two prepares of
one picture the signer refused carry the same passport id and so the same copy, and Pinata answers
the second with the first one's file; that file is left in place for the first prepare, and the
sweep removes it later if no registered passport asks for it. The pinned document gains `"privateRecheck": true` and nothing that names
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
    manifestHash: `0x${string}`,   // the C2PA store's own box, as under /verify; 32 zero bytes when nothing was embedded
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
  manifest: ({ embedded: true } | { embedded: false, reason: string })
    & { cameraRecord?: "kept" | "dropped" },   // only for an upload that arrived with its camera's own record, see below
  training?: {                     // absent when the creator said nothing
    aiTraining?: "allowed" | "notAllowed" | "constrained",
    aiGenerativeTraining?: "allowed" | "notAllowed" | "constrained",
    aiInference?: "allowed" | "notAllowed" | "constrained",
    dataMining?: "allowed" | "notAllowed" | "constrained",
    constraintInfo?: string,
    standard: "cawg.training-mining/1.1"
  },
  preparedBy: string,              // the Privy user id the token carried
  lookalike:                       // on every 200, public and sealed alike, see below
    | { state: "found", passportId: `0x${string}`, title: string, registeredAt: number }
    | { state: "yours", passportId: `0x${string}` }
    | { state: "none", indexAt: number }
    | { state: "unchecked" },
  webCheck:                        // on every 200, public and sealed alike, see below
    | { state: "found", count: number, pages: string[] }
    | { state: "silent" }
}
```

**The look-alike warning.** Before handing back the fields, the service runs its matcher on the
signed file and on its seven other turns and mirrors, against the passport index in memory, at the
shared thresholds (10 of 64 pHash bits and 40 of 256 blockhash bits, the numbers the Chainlink
workflow uses from the same file). A passport counts as earlier only when its chain `registeredAt`
is strictly before the current second, so one registered in the same second never does.

- `found` names the earliest earlier look-alike by another creator, outside the creator's own edit
  family: its id, lower case; its title, read from its metadata document by the pinned-content rule
  above and made one plain line of at most 120 code points (control, format and direction
  characters become a space, then the line is cut), or `""` when the document could not be read;
  and its `registeredAt` from the chain record, in unix seconds. Nothing in it is a link.
- `yours` names the creator's own earliest earlier look-alike, when every earlier one is theirs or
  an edit within their family. The creator's wallets are read from Privy, only when there is a match.
- `none` means the search ran and found nothing, on an index current to `indexAt`, in unix seconds.
- `unchecked` means the search could not answer: the index was stale, the turns could not be taken,
  or the creator's wallets could not be read within 5 seconds. A screen says so in words; it never
  draws this as nothing found.

The warning never stops the prepare: the person decides. When it says `found`, the pinned document
records that passport's id as `seenEarlier`, see below.

**The web check.** For a public upload, and only then, the service asks Google Cloud Vision's web
detection whether the picture is already on other web pages. One rule decides what is sent: a studio
upload, of kind Captured, not sealed. A sealed picture, a platform's picture and a picture Moolam's
agent drew are never sent. What leaves is the picture's public thumbnail, the same bytes the
passport publishes, and only after the token, the hourly limit and the day's prepare slot have let
the caller through. The key travels in a request header, never in an address, and redirects are
refused. Vision gets 10 seconds.

- `found` carries `count`, how many distinct pages Google listed as showing the picture whole or in
  part, and `pages`, the first ten of them. Each page is kept only as an `http` or `https` address
  with a host, with its query, fragment and any user name dropped, and at most 256 characters; a
  longer one is left out, never cut. They are text to read, never links to follow.
- `silent` is every other outcome: no pages, a failed or unreadable answer, a timeout, a host with no
  `GOOGLE_VISION_API_KEY`, `VISION_CHECKS_PER_DAY` spent or `0`, or a picture the rule never sends.
  It never means "not online", and a screen must not say so.

`VISION_CHECKS_PER_DAY` (default 300) bounds the pictures sent in one UTC day for everyone, kept in
the data folder across restarts; `0` switches the check off without a deploy. By Google's own terms
an online request's picture is held in memory only and is not used for training.

**What the pinned document says in the creator's voice.** Every document this route pins, public or
sealed, carries the sworn line the studio shows beside the sign button, with its version:

```json
"sworn": { "text": "I made this picture, or I hold the rights to register it.", "version": 1 }
```

With a `found` look-alike it also carries `"seenEarlier": "0x<passport id, lower case>"`, and with a
`found` web check `"seenOnline": { "count": n, "pages": [...] }`, exactly the count and pages the
answer shows. A sealed document never has `seenOnline`. All three are checked against their shape
before the pin, and the creator's passkey signs the address of the document that holds them. They are
the creator's own statements, never a fact the chain checked. Documents pinned by
[`/generate`](#post-generate) and [`/edit`](#post-edit) carry the same sworn line.

The browser adds its own wallet address and a deadline to those passport fields, reads
`hashPassport` from the registry, signs that digest with the creator's passkey and sends `register`
itself, so the service never holds a key that can write to the chain.

**What the manifest says about the picture.** Moolam sees a signed-in person send a file and nothing
about how it was made, so the manifest it signs says only that: the upload is its parent ingredient
and the one action is `c2pa.opened`. No `digitalSourceType` is written. A camera capture, a drawing
and an AI picture all leave the studio with the same statement, because a source type under
Moolam's signature would be Moolam vouching for something it never saw. The C2PA library has no form
for a source type that is only the uploader's own claim, so none is recorded as one either. A
picture Moolam's own agent made on [`/generate`](#post-generate) is the one case Moolam did see, and
it says `c2pa.created` with `trainedAlgorithmicMedia`.

`manifest.embedded` is `false` when the C2PA signer refused the file, such as an unusual container.
A host with no signer that loads never mounts this route, and a signing worker that fails answers
`502 sign-failed` rather than an unsigned file. The upload still stands: `manifestHash` is 32 zero bytes, the fingerprint and
the on-chain record work without a manifest, and `reason` says what happened, cut to 200 characters.

**What the pinned file keeps.** Every upload becomes one upright baseline JPEG before it is signed.
A JPEG that is already upright and baseline is not re-encoded: it is rebuilt, byte for byte, from
the segments that decide its pixels and nothing else, which are the JFIF header, the ICC colour
profile, the Adobe colour transform marker, the quantisation and Huffman tables, the restart
interval, the one frame and the one scan up to its end marker. Every other application segment and
every comment is left out, whatever it says: EXIF, XMP, IPTC, GPS blocks, maker notes and serial
numbers live there, and none of them changes a decoded pixel. Every APP11 segment goes too, the
upload's own C2PA store included, so the signed file holds one store, Moolam's. Nothing after the
scan's end marker is kept: a second image, a gain map, a motion clip or a trailer. A file this
rebuild does not recognise, a progressive or rotated JPEG, a PNG and a WebP are re-encoded at
quality 95 instead, which drops all of it as well.

**A camera's own record.** A photo that arrives with its camera's own C2PA record keeps that signed
record inside Moolam's manifest, with its location and serial redacted. The upload exactly as it
arrived becomes the manifest's one `parentOf` ingredient, so the camera's own hard binding is
checked against the bytes the camera signed. In every manifest of the camera's store, these are
redacted, each recorded with the reason `c2pa.PII.present`: the capture metadata assertions
(`stds.exif`, `stds.iptc`, `c2pa.metadata`, `cawg.metadata`), any assertion with a key whose name
says a place or a unit (GPS, geo, location, latitude, longitude, altitude, serial, city, country,
province, region, address, state), any assertion whose data cannot be looked into, and any
thumbnail that carries EXIF, XMP or IPTC or will not decode. The actions, the hard bindings and the
ingredients are never redacted, because the standard does not allow it.

The signed file is read back before it goes anywhere. It keeps the record only when Moolam's
manifest validates by the rule under [`/verify`](#post-verify), so a camera certificate that has
expired, or is on no trust list, does not cost the record while any other failure does, names that
one parent, the parent reports nothing mismatched or missing, no
text value the record held under a place or serial key appears anywhere in the signed bytes, and no
thumbnail left in the store carries EXIF, XMP or IPTC. Otherwise, and for a store that cannot be
read, one past the caps (16 manifests, 64 redactions, 32 thumbnails) or one the library will not
take, the record is dropped and the file is signed as a plain upload, and the reason goes to the
log. `manifest.cameraRecord` then says `kept` or `dropped`, on a public and a sealed answer alike,
and is absent when the upload carried no record. An upload that ends up unsigned has lost its record
too and reads `dropped`.

What this does not remove. A kept record still carries the camera's own signature, and a camera
that signs with a certificate of its own can be named by that certificate. The redaction rule reads
key names, so a place or a serial stored under a key whose name says neither stays in the record,
and the byte check after signing looks only for text values held under place or serial keys.

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Prepared and pinned |
| `400` | Not a multipart body, no `file` part, an empty file, a file part under another name, a `title` outside 1 to 120 characters, a `kind` other than `human`, or a `training` statement that is not JSON, is over 1024 bytes, carries a key or a value the standard has no room for, or breaks the `constraintInfo` rule. The message names the field |
| `400` | `{ "error": "too-many-fields" }`. The body carries more than five text parts. Nothing is read further and nothing is pinned |
| `400` | A text part sent as anything but plain text, such as `application/json`: `the "<name>" field must be sent as plain text, not as <type>`. Skipping it would have read `sealed=true` as a public prepare. Nothing is pinned |
| `400` | `{ "error": "private-recheck-needs-sealed" }`. `privateRecheck` is `true` and `sealed` is not. Nothing is pinned |
| `401` | No `Authorization: Bearer` header, or a token that fails on its signature, issuer, audience, algorithm or expiry. A key set that cannot be fetched answers the same way, so a caller never learns the difference between a bad token and a bad network. `{ "error": "unauthorized" }` |
| `409` | `{ "error": "already-registered", "passportId": "0x..." }`. The registry already holds this exact picture. Nothing is pinned, and the id names the passport that holds it |
| `409` | `{ "error": "private-copy-not-private" }`. Pinata answered the private upload with a file that is not on its private network or not under the name sent, as it does for bytes the account already holds publicly. No document is pinned, nothing is registered, and the file id Pinata gave back goes to the log for an operator |
| `413` | Over the 20 MB byte limit, or over 40 megapixels once the header is read |
| `413` | `{ "error": "signed-file-too-large", "limit": 20971520, "reason": "..." }`. Signing re-encodes at quality 95 and adds the manifest store, so an upload under the cap can come out over it, and a registered file over it could never come back through `/verify` or `/unseal`. Refused before anything is pinned or handed back, and the day's slot is given back |
| `415` | The file is not a JPEG, PNG or WebP, or is one the service cannot decode. `{ "error": "not-an-image" }`, with `reason` when the header parsed and the pixels behind it did not. Any other format, an SVG above all, is refused by its file signature before anything renders it or takes a place at the shared decode gate |
| `422` | `{ "error": "fingerprint-unstable", "limit": 10, "distance": n, "reason": "..." }`. The picture's own thumbnail lands more than 10 of 64 pHash bits from the picture, so its Chainlink re-check would read a mismatch and no copy of it could be matched. See [Fingerprints](../concepts/fingerprints). Nothing is pinned and the day's slot is given back |
| `500` | `{ "error": "metadata-refused", "reason": "..." }` or, sealed, `sealed-metadata-refused`. The document's statements did not fit the shape they are checked against, which nothing a caller sends can cause. Nothing is registered |
| `422` | `{ "error": "thumbnail-too-large", "limit": 60000, "reason": "..." }`. A real picture with so much fine detail that its 512 pixel thumbnail stays over 60,000 bytes even at the lowest quality tried, so the Chainlink verifier could never fetch it. A plain sealed prepare is held to the thumbnail an unseal would publish and is refused the same way, since that passport could never be unsealed; the `reason` says a public passport could never be re-checked and a sealed one could never be unsealed. With `privateRecheck` the private copy is held to the budget, and the `reason` says a private re-check could never open it. Nothing is pinned and the day's slot is given back |
| `429` | Over 20 prepares in an hour, counted on the Privy user id from the token, or on the caller's address when there is no valid one. This limit replaces the global 60 a minute on this path |
| `429` | `{ "error": "global-limit", "reason": "...", "quota": { used, limit, resetsAt } }` once `GLOBAL_PREPARES_PER_DAY` is spent by everyone together, with `retry-after` in seconds. Nothing is pinned. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `502` | Pinata refused a pin. `{ "error": "pin-failed" }`. Pinata's status and its answer go to the log and never to the caller, and the token appears in neither. With `privateRecheck`, a refused or timed out private upload answers this with no document pinned, and a document pin that fails after the private copy was kept answers this after the copy is deleted, or left in place when Pinata held it before this request. The day's slot is given back only when no pin can have stored anything: Pinata answered with a 4xx, or the request never left the service. A 5xx, a timeout or a dropped connection may come after Pinata kept the file, so those keep it spent |
| `502` | `{ "error": "sign-failed" }`. The signing worker crashed, stopped or ran past 30 seconds. Nothing is pinned |
| `503` | `busy`. No turn at the decode gate came free inside `MATCH_WAIT_MS`, see [Turns at the decode gate](#post-verify), or the upload ceiling or this caller's share of it was full. Nothing was pinned, so the call can be made again |
| `503` | `{ "error": "service-fault", "reason": "the service could not read this picture right now, try again" }`. The service, not the picture, failed while fingerprinting it: a blockhash worker that crashed, stopped or ran out of time, a hash of the wrong length, or a decoder out of memory. The signed path never falls back to an unsigned file for this. Nothing is pinned, and the day's slot is given back |
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

Before it draws anything, the host reads the registry on chain once to confirm the generator
agent's settings. A chain that cannot be read does not stop the boot: `/generate` answers `503
generator-unchecked`, `/health` lists it under `off` with the same reason, and the check runs again
every 5 minutes until it reads the chain. A check that finds the chain disagreeing stops the boot,
and one that finds it later keeps `/generate` closed with that reason.

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
| `422` | `{ "error": "thumbnail-too-large", "limit": 60000, "reason": "..." }` when the drawing's thumbnail cannot fit the Chainlink budget: the pinned thumbnail for a public drawing, the private copy with `privateRecheck`, and the thumbnail an unseal would publish for a plain sealed one. Nothing is pinned. The caller's own allowance is given back and the day's ceiling stays spent, because the drawing was made and paid for |
| `422` | `{ "error": "fingerprint-unstable", "limit": 10, "distance": n, "reason": "..." }`. The drawing's own thumbnail lands more than 10 of 64 pHash bits from it: the pinned thumbnail for a public drawing, the private copy with `privateRecheck`, and the thumbnail an unseal would publish for a plain sealed one. Nothing is pinned. The drawing was made and paid for, so the caller's allowance and the day's ceiling both stay spent |
| `429` | Past `GENERATE_PER_DAY` in a rolling 24 hours, counted on the Privy user id. `{ "error": "quota", "quota": { used, limit, resetsAt } }` |
| `429` | `{ "error": "global-limit", "reason": "...", "quota": { used, limit, resetsAt } }` once `GLOBAL_GENERATIONS_PER_DAY` is spent by everyone together, with `retry-after` in seconds. Nothing is drawn and the caller's own allowance is handed back. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `502` | `model-failed`, `pin-failed` or `sign-failed`: the image model, Pinata or Privy's enclave would not play |
| `503` | `busy`. Two pictures were already being drawn and no slot came free inside 90 seconds. The allowance is given back |
| `503` | `{ "error": "generator-unchecked", "reason": "..." }`. This host has not yet read the registry on chain to confirm the generator agent's settings, or a later check found them disagreeing. Answered before the token is read, so nothing is drawn or spent |
| `503` | `{ "error": "service-fault", "reason": "the service could not read this picture right now, try again" }`. The service failed while fingerprinting the drawing, as under `/prepare`. Nothing is pinned; the drawing was made and paid for, so the allowance and the day's ceiling stay spent |
| `503` | With `privateRecheck`: `{ "error": "chain-unreachable" }` when the check for an existing passport could not reach the chain. No private copy is made and nothing is pinned; the picture was drawn, so the allowance stays spent |

**The allowance.** `GENERATE_PER_DAY`, three by default, per verified Privy user id over a rolling 24
hours. A refused prompt and a request that never got a drawing slot hand the slot back. A model that
failed part way keeps it, because it may have drawn and been billed before it failed, and so do a
failed pin, a failed signature, a drawing whose fingerprint does not survive its own thumbnail and
a fault of the service while fingerprinting it, which all happen after the picture exists. The count
is saved in the data folder as `quota-generate.json`, on the Railway volume at `/data`, so a redeploy
or a restart hands nobody their allowance back. The service runs one copy, because two would count
separately. The global 60 requests a minute applies to this path as well.

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
| `file` | file | The edited image, a JPEG, PNG or WebP. Up to 20 MB and 40 megapixels. A file part under any other name is a `400` |
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
  manifest: ({ embedded: true } | { embedded: false, reason: string })
    & { cameraRecord?: "kept" | "dropped" },   // as under /prepare
  quota: { used: number, limit: number, resetsAt: number }
}
```

The wallet comes from the Privy user record, never from the request, and the ownership check is read
from the chain before anything is spent. The manifest written into an edit records the file as
opened and then `c2pa.edited`, with the upload as its parent ingredient and no `digitalSourceType`,
which is the one place inside the file that says this picture is a change to another one. Moolam
did not watch the edit being made, so it states no source type for it, the same rule as
[`/prepare`](#post-prepare). The edited file goes through the same byte path, and an edit that
arrives with a camera's own record gets the same redaction, read back and `cameraRecord` answer.

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Pinned and sent |
| `400` | Not a multipart body, no `file` part, a file part under another name, a `title` outside 1 to 120 characters, a `parentId` that is not 32 bytes of hex, or a `note` over 280 characters |
| `400` | `{ "error": "too-many-fields" }`. The body carries more than five text parts. Nothing is read further and nothing is pinned |
| `400` | A text part sent as anything but plain text, as under `/prepare`. Nothing is pinned or sent |
| `401` | The token is missing or fails a check. `{ "error": "unauthorized" }` |
| `403` | `not-owner`. None of this caller's wallets is the one the registry says holds the parent. A creator with more than one embedded wallet is matched by the address on chain, not by which wallet is listed first |
| `404` | `no-parent`. The registry has no passport with that id |
| `409` | `no-signer`. This app is not a signer on that wallet, or its signer does not carry the edit policy. A Privy user id this app does not know answers the same way |
| `409` | `{ "error": "already-registered", "passportId": "0x..." }`. The registry already holds this exact edited picture. The check runs on the fingerprint of the bytes about to be pinned, so nothing is pinned, nothing is sent and the day's allowance is given back |
| `413` | Over the 20 MB byte limit, or over 40 megapixels |
| `413` | `{ "error": "signed-file-too-large", "limit": 20971520, "reason": "..." }`. Signing grew the edit past the 20 MB cap, as under `/prepare`. Refused before the duplicate check and before anything is pinned or sent, and both allowances are given back |
| `415` | `not-an-image`: not a JPEG, PNG or WebP, refused before anything decodes it, or with `reason` when the header parsed and the pixels behind it did not decode |
| `422` | `{ "error": "thumbnail-too-large", "limit": 60000, "reason": "..." }`. The edit is too detailed for a thumbnail under the Chainlink fetch budget. Nothing is pinned or sent, and both allowances are given back |
| `422` | `{ "error": "fingerprint-unstable", "limit": 10, "distance": n, "reason": "..." }`. The edit's own pinned thumbnail would land more than 10 of 64 pHash bits from it, as under `/prepare`. Nothing is pinned or sent, and both allowances are given back |
| `429` | Past `EDITS_PER_DAY` in a rolling 24 hours. `{ "error": "quota", "quota": { used, limit, resetsAt } }` |
| `429` | `{ "error": "global-limit", "reason": "...", "quota": { used, limit, resetsAt } }` once `GLOBAL_EDITS_PER_DAY` is spent by everyone together, with `retry-after` in seconds. Nothing is pinned, nothing is sent, and the caller's own allowance is handed back. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `499` | `{ "error": "client-gone" }`. The caller really left: the connection closed before the answer was written, or its socket is gone. It is checked twice, before the allowance is taken and again just before the send, so a creator who closed the tab while waiting at the decode gate is never sent a transaction. Both allowances go back only if nothing was pinned yet. A request whose body was simply read to the end is not read as gone |
| `502` | `pin-failed`, `sign-failed`, or `send-failed` with the registry's own revert name when the call was simulated and refused. Both allowances come back only when no pin can have stored anything, the rule under `/prepare` |
| `502` | `{ "error": "send-failed", "reason": "the user operation reverted: ...", "passportId": "0x...", "hash": "0x..." }`. The transaction landed and its receipt carries no `PassportRegistered` event from the registry for this child. A sponsored send is a user operation inside a bundle, and the bundle succeeds even when the `appendEdit` inside it reverted, so the registry's own event is the only proof the edit was written. `send-failed` with the receipt's own `reason` is also the answer when the receipt says the transaction reverted |
| `502` | `{ "error": "send-pending", "transactionId": "...", "passportId": "0x...", "hash": "0x..." }`, the hash only when Privy reported one. Privy took the transaction and the chain did not show it inside the wait. It may still land, so a caller must check the chain and must never send it again. `passportId` is the child's own id, which is why the check is a read of that one passport rather than a guess at which edit under the parent belongs to this caller |
| `502` | `privy-unavailable` or `chain-unavailable`: Privy or the Monad RPC did not answer while the parent, the owner and the signer were being checked. That all happens before the allowance is taken, so nothing was sent and nothing was spent |
| `503` | `busy`. No turn at the decode gate came free inside `MATCH_WAIT_MS`, as under `/prepare`, or the upload ceiling or this caller's share of it was full |
| `503` | `{ "error": "service-fault", "reason": "the service could not read this picture right now, try again" }`. The service failed while reading or fingerprinting the edit, as under `/prepare`. Nothing is pinned or sent, and both allowances are given back |

**One send per edit, and a landing read from the chain.** The send carries Privy's idempotency key
`moolam-edit-` followed by the sha256 of the wallet id and the whole calldata, the deadline included.
The Privy SDK's own retries of one send carry the same key, so Privy runs that `appendEdit` once.
The same edit sent again by the creator is built with a new deadline, so it is a new send with a key
of its own, and another holder's send of the same bytes, from another wallet, never shares a key.

Before any `send-failed` that follows a send, whether Privy called the send dead, the receipt says
reverted, or the receipt carries no `PassportRegistered` event for this child, the registry is read
for the child passport. When the chain holds it, registered by this creator's wallet under this
parent, the edit landed, most likely through an earlier try of the same send: the answer is `200`,
or `502 send-pending` with the `passportId` when Privy called the send dead and reported no hash,
so the browser watches for a child it will find at once. The receipt's own event is read the same
way, and its creator and parent must be this edit's too. A copy of these bytes someone else
registered, or one under another parent, is never answered as this edit, and a chain that does not
answer is not a landing: `send-failed` stands.

The parent is checked first, because it is the one claim in the request that costs nothing to settle.
Then the signer, then the ownership, then the creator's own allowance, then today's budget for
everyone, and only then is a pin or a transaction spent.

**The allowance.** `EDITS_PER_DAY` per Privy user id over a rolling 24 hours, beside the day's
`GLOBAL_EDITS_PER_DAY` for everyone. The two go back together, and only when the request spent
nothing: no pin that may have stored something and no send. A pin is money spent whether or not the
edit reaches the chain, so an edit that pinned and then failed at the estimate or the send, or whose
caller hung up after the pins, keeps both. Giving the creator's own slot back there let one caller
drain the day's edits for everyone at no cost to their own count.

## POST /unseal

The holder of a sealed passport publishes the picture it committed to. A sealed passport is a hash
on chain with no picture behind it; unsealing is the creator handing that picture over, and from
then on it is an ordinary passport the Chainlink workflow can re-check.

Mounted on the same terms as `/prepare`, a Pinata token to pin with and a Privy app id to check
tokens against, plus `PRIVY_APP_SECRET`, because the holder's wallets are read from Privy. Without
the secret this route is off and answers `404`, and `GET /unseal/:passportId` stays on. Nothing here
signs on a wallet or sends a transaction, and a signer that does not load leaves this route on.

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

The thumbnail must fit. A sealed prepare or drawing is now refused when the thumbnail an unseal would
publish cannot fit the 60 KB budget, but a passport sealed before that rule, or registered outside
Moolam, can still hold such a picture. Publishing it would leave a passport the Chainlink workflow
can never fetch and so can never re-check, which reads as a fault for ever, so the unseal is refused
with `422` instead.

The fingerprint must survive that thumbnail. The thumbnail about to be published is held to the
check `/prepare` makes: a picture registered sealed before that check existed, or drawn by
`/generate`, can have a fingerprint its own thumbnail does not keep, and publishing it would leave a
passport the re-check reads as mismatched for good. It is refused with `422 fingerprint-unstable`.

One unseal of a passport at a time. The first request that passes the hash check holds the
passport on this server until it has answered, and a second one meanwhile is refused with `409
unseal-in-progress` rather than reading "no record yet" while the first pins. A passport this
server has already seen unsealed is answered `409 already-unsealed` from memory, before any Privy,
Pinata or chain call, so a resend costs nothing. So is a passport this server unsealed in the last ten
minutes when it could not tell which record is the oldest: Pinata's listing can trail a fresh pin,
and a second unseal that believed a listing reading "none" would pin a second record.

The thumbnail is pinned first, and alone. If Pinata answers it with a private file, which happens
when a private copy of these same bytes is kept for another passport, the unseal stops with `409
thumbnail-held-privately` and nothing public. Only once the thumbnail is public are the picture and
its manifest document pinned, then the record.

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
| `400` | A text part sent as anything but plain text, as under `/prepare`. Nothing is pinned |
| `400` | `{ "error": "hash-mismatch", "passportId": "0x..." }`. The upload is not the file this passport commits to. Usually the creator kept their own copy of the picture rather than the file this service signed and handed back |
| `400` | `{ "error": "fingerprint-mismatch", "passportId": "0x...", "recomputed": {...} }`. The bytes hash right and the fingerprint recomputed from them is not the one on chain |
| `401` | The token is missing or fails a check. `{ "error": "unauthorized" }` |
| `403` | `not-holder`. The registry says another wallet holds this passport. A Privy user id this app does not know answers the same way |
| `404` | `no-passport`. The registry has no passport with that id |
| `409` | `not-sealed`. The passport's metadata document is already public, so there is nothing to unseal |
| `409` | `{ "error": "already-unsealed", "passportId": "0x...", "record": {...} }`. A record is pinned for this passport already. A passport this server has seen unsealed is answered from memory, right after the hash check. One this server unsealed in the last ten minutes without learning its oldest record is answered the same way with no `record`, since there is none it can name for sure, and nothing is pinned |
| `409` | `{ "error": "unseal-in-progress", "passportId": "0x..." }`. Another unseal of this passport is running on this server. Nothing was read or spent |
| `409` | `{ "error": "thumbnail-held-privately", "passportId": "0x...", "reason": "..." }`. Pinata answered the public thumbnail pin with a private file it already keeps for these bytes. Nothing is public and the passport still reads sealed. The holder's allowance comes back; the day's ceiling stays spent, because the pin reached Pinata |
| `413` | Over the 20 MB byte limit, or over 40 megapixels |
| `415` | `not-an-image`: not a JPEG, PNG or WebP, refused before anything decodes it, or with `reason` when the header parsed and the pixels behind it did not decode |
| `422` | `{ "error": "thumbnail-too-large", "limit": 60000, "reason": "..." }`. Nothing was pinned |
| `422` | `{ "error": "fingerprint-unstable", "limit": 10, "distance": n, "reason": "..." }`. The thumbnail that would be published lands more than 10 of 64 pHash bits from the registered fingerprint. Nothing was pinned |
| `429` | Past `EDITS_PER_DAY` in a rolling 24 hours, which is the allowance unsealing shares. `{ "error": "quota", "quota": { used, limit, resetsAt } }` |
| `429` | `{ "error": "global-limit", ... }` once `GLOBAL_UNSEALS_PER_DAY` is spent by everyone together. See [Today's budget for everyone](#todays-budget-for-everyone) |
| `429` | Thirty a minute per address, the limit `GET /unseal/:passportId` has, because even a refused resend costs a Privy read and a chain read |
| `502` | `{ "error": "pin-failed", "passportId": "0x...", "published": {...}, "failed": [...], "reason": "..." }`. One of the three pins before the record failed. `failed` names the pieces that did not land, out of `image`, `thumbnail` and `manifest`, and `published` holds the address of each piece that did, which is public now and cannot be taken back. The thumbnail goes first and alone, so a failed thumbnail pin answers `failed: ["thumbnail"]` with nothing published. The passport still reads sealed, no record is written and nothing private is touched. Sending the same file again lands on the same content ids and finishes the unseal |
| `502` | `{ "error": "record-pin-failed", "passportId": "0x...", "image": {...}, "thumbnail": {...}, "reason": "..." }`. The picture is public and the record that points at it is not. This is the one half-done state the route can end in, and the answer says so rather than failing silently, because the caller has to know their picture is already out there. Sending the same file again lands on the same three addresses, because every pin is content addressed, and finishes the record |
| `502` | `chain-unavailable`, `metadata-unavailable` or `privy-unavailable`: the Monad RPC, the gateway or Privy did not answer. All of that happens before the allowance is taken, so nothing was spent |
| `503` | `busy`. No turn at the decode gate came free inside `MATCH_WAIT_MS`, as under `/prepare`, or the upload ceiling or this caller's share of it was full |
| `503` | `{ "error": "service-fault", "reason": "the service could not read this picture right now, try again" }`. The service failed while fingerprinting the upload or making its thumbnail, as under `/prepare`, which is never read as a file that is not an image. A thumbnail step that runs out of memory is this answer; `thumbnail-too-large` is only ever the size budget, and any other thumbnail failure is `415 not-an-image`. Nothing is pinned, and both allowances are given back |
| `503` | `service-fault` as well when the manifest read of the upload, made before any pin, gives up at its five second limit, or comes back unreadable for bytes the chain says were registered with a manifest. A record pinned without the manifest could never be replaced, so the holder sends the same file again. Only a read given up on counts: a file registered with no manifest whose own store cannot be parsed is published without a manifest document, however long the read took. Nothing is pinned, and both allowances are given back |

A public pin counts only when Pinata answers with the content id this service computed for the
bytes it sent, on the public network. Pinata stores one copy of any content, across its networks
too, so an answer naming another file or the private network is not believed: that pin is treated
as failed, and nothing is recorded or deleted on the strength of it.

The two allowances go back on different terms. The holder's own comes back for any unseal that did
not finish, so a partial one can be finished without spending a second slot. Today's ceiling for
everyone comes back only when no pin can have landed, because a pin that landed is money spent: a
thumbnail pin Pinata refused with a 4xx, or one that never left the service, gives it back, and a
5xx, a timeout or an answer naming a private file keeps it.

The private copy is deleted only after the record is pinned, and never a private file whose content
id is one of the four this unseal just published.

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
| `404` | `{ "error": "no-passport", "passportId": "0x..." }`. Neither the index nor the registry holds this passport |
| `404` | `{ "error": "not-sealed", "passportId": "0x..." }`. The passport's metadata document is public, so it was never sealed and has no record to find |
| `404` | `{ "error": "not-unsealed", "passportId": "0x..." }`. The passport is sealed and no record is pinned for it |
| `429` | Thirty a minute per address, the limit `/sealed/status` has, rather than the sixty everything else gets |
| `503` | `lookup-unavailable`. The chain, the metadata document or Pinata could not say, which is not the same as "not unsealed" and must never be shown as one |

Pinata's listing is read by one rule here and in the private listings: `files` as a list, or `null`
for an empty one, which is `not-unsealed`. A listing with no `files` key at all is a shape this
service does not know and answers `lookup-unavailable`, never `not-unsealed`.

Every miss costs one request out of the Pinata account's shared minute, so Pinata is asked only
about a passport that exists and whose document says sealed, the only kind that can have a record.
The passport is looked up in the index first and on the registry only when the index does not hold
it, so a made-up id costs a chain read at most and never a Pinata request. The document is read by
the rule in [How a passport's metadata document is read](#how-a-passports-metadata-document-is-read).

A record is pinned once and never changes, so a hit is remembered for the life of the process. A
miss of any of the three kinds is remembered for 60 seconds, and at most 2,000 misses are held
before the oldest is forgotten. `lookup-unavailable` is never remembered.

**Right after an unseal on this server.** When the unseal's own check found no earlier record, the
record it just pinned is the oldest, so it is remembered at once and GET answers `200` with it while
Pinata's listing still trails the pin. When that check could not answer, another server may have
pinned first, so the record remembered is the oldest a fresh lookup names, or none; for the next ten
minutes GET then remembers no `not-unsealed` miss for that passport and asks the listing again each
time. Either way the unseal clears the passport's own miss, so a minute is the longest another
server's answer can lag behind.

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
[`/sealed/forget`](#post-sealedforget), or by an unseal, that removed every file under the name
makes the status read `gone` at once and holds it for the next 60 seconds, even while Pinata's
listing still shows the deleted file. That holds for a delete made while the passport's document
could not be read too, since every file under the name went. A delete that failed part way drops the
memory instead, so the next read asks again.

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
ten minutes ago, so a stolen token opens only what is being run right now. The status memory behind
[`/sealed/status`](#get-sealedstatuspassportid) does not hold `gone` for it: for the minute after a
delete removed every file under the name, the link is refused without asking the listing, which can
still show the deleted file. Exactly one private file has the passport's name. The link is then asked of Pinata for a fixed 120 seconds, never a time from
the request, and parsed again before it is sent: it has to be `https` on the host
`PINATA_GATEWAY_URL` names.

| Code | When |
| --- | --- |
| `200` | The link and when it stops working |
| `400` | The body is not `{ "passportId": "0x..." }` with 64 hex characters |
| `401` | `unauthorized`. No `Authorization: Bearer ...` header, or the wrong token |
| `404` | `no-passport`. The registry holds no such passport |
| `404` | `nothing-kept`. The passport's document did not ask for a private re-check |
| `404` | `gone`. No private file has the passport's name, or a delete through [`/sealed/forget`](#post-sealedforget) or an unseal removed every file under it in the last minute, while Pinata's listing may still show one |
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

Mounted with the other `/sealed` routes, and only on a host that also has `PRIVY_APP_SECRET`,
because the holder's wallets are read from Privy. Without it this route answers `404` while
`/sealed/status` and `/sealed/link` stay on.

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
included, and `deleted` says how many. The name alone decides what is deleted, never the passport's
document: a copy kept for one prepare of a picture can sit under a passport registered with another
prepare's document that never asked for a private re-check, and it is still the holder's to delete.
The document is read only to say what `/sealed/status` should hold afterwards, and a document that
cannot be read no longer stops the delete. When every file under the name was deleted, the status
reads `gone` at once and holds it, so neither `/sealed/status` nor the re-check queue goes on saying
`kept`. The answer and the log line carry the count and never a file id.

| Code | When |
| --- | --- |
| `200` | Deleted, with the count. `0` when the copy was already gone and the document asks for a private re-check |
| `400` | The body is not `{ "passportId": "0x..." }` with 64 hex characters |
| `401` | The Privy token is missing or fails a check. `{ "error": "unauthorized" }` |
| `403` | `not-holder`. The registry says another wallet holds this passport. A Privy user id this app does not know answers the same way |
| `404` | `no-passport`. The registry holds no such passport |
| `404` | `nothing-kept`. No private file has the passport's name, and its document does not say it asked for a private re-check |
| `429` | Thirty a minute per address, like `/sealed/status`, because every call spends a Privy read and a Pinata listing |
| `502` | `privy-unavailable`. Privy did not answer the wallet lookup |
| `502` | `{ "error": "delete-failed", "passportId": "0x...", "deleted": n }`. Pinata refused at least one delete. Send the same request again to finish |
| `503` | `chain-unavailable` or `lookup-unavailable`. Nothing was deleted: a listing that did not finish is never read as "nothing there" |

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
the queue. A claim a runner took more than thirty minutes ago and never closed reads as waiting
again, here and on every route below: `status: "pending"`, no `startedAt`, and its old place in the
line, so a runner that died or a done that never arrived cannot leave a passport stuck in
`running` with nobody able to ask for it.

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
process, because neither can change back, and a sealed one for 10 seconds, so a holder who unseals
waits at most ten seconds before a re-check can be asked for. Only passports the index already holds get that far, so a
caller cannot turn this route into a gateway or Pinata read per request. A gateway or a record
lookup that does not answer inside five seconds lets the request through; the runner refuses it
later, which is the right way round for a request that spends nothing.

A sealed passport whose document asks for a private re-check is queued only while
[`/sealed/status`](#get-sealedstatuspassportid) says its copy is `kept`, and while it says
`unknown`, because the runner checks the status again before it spends anything. A copy that is
`gone` gets the same `409 sealed` a plain sealed passport gets.

## POST /lookalikes/candidates

Which earlier passports might show the same picture as a set of fingerprints. Chainlink's nodes ask
it during a look-alike run; anyone may. The answer only proposes: the workflow reads each id on
chain and measures it itself before it writes anything.

**Request.** A JSON body, exactly these two keys:

```json
{ "fingerprints": [{ "phash": "0x<16 hex>", "blockhash": "0x<64 hex>" }], "asOf": 1790000000 }
```

`fingerprints` holds 1 to 8 pairs, such as a picture's eight turns and mirrors. `asOf` is a whole
number of unix seconds, no later than this host's clock plus 60 seconds.

**Response.** `200` with one of:

```ts
{ status: "ok", candidates: `0x${string}`[] }   // 0 to 3 passport ids, lower case
{ status: "not-ready" }                          // no list at all
```

Every passport carrying a fingerprint within 10 pHash bits and 40 blockhash bits of any pair, and
registered strictly before `asOf` by its chain `registeredAt`, is a candidate. Each fingerprint
counts once, named by its first registration, so later copies of one fingerprint take no extra
place. The list is sorted by `registeredAt`, then by id, and cut to three, so the earliest
registration within the thresholds is always first. The answer depends only on the index in memory
and the request, so two callers with the same body get the same bytes while one copy of the index
is in hand.

`not-ready` means the index is stale or has not been loaded through `asOf`: behind the indexer, its
newest processed block is older than `asOf`. The caller should ask again later rather than read it
as "none".

| Code | When |
| --- | --- |
| `200` | `ok` or `not-ready` |
| `400` | Not JSON, an extra or missing key, a pair out of shape, no pairs or more than 8, an `asOf` that is not a whole number or is more than 60 seconds ahead. Refused before any search |
| `429` | Over the service's 60 a minute per address, or `{ "error": "route-limit" }` once every caller together has asked 600 times this minute, with `retry-after` |

## GET /lookalikes/backlog

Which passports still wait for Chainlink's network. The workflow's ten-minute run asks it to catch
up on runs that were dropped and on passports registered before the network run went live.

**Request.** `GET /lookalikes/backlog?asOf=<unix seconds>&n=<1 to 7>`, nothing else in the query.
`asOf` may be at most 60 seconds ahead of this host's clock.

**Response.** `200` with one of:

```ts
{ status: "ok", passports: `0x${string}`[] }    // 0 to n passport ids, lower case, oldest first
{ status: "not-ready" }
```

A passport is listed when it was registered strictly before `asOf`, its metadata document is public
and names its picture as pinned content (so the workflow can check it), and it still lacks one of:

- a network verdict: an attestation from receiver `0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04` at or
  after `NETWORK_ACTIVATION_TIME`, read from the index;
- for an original, a look-alike record: a `LookalikeChecked` event from `LOOKALIKE_RECEIVER` whose
  `executedAt` is at or after `NETWORK_ACTIVATION_TIME`. Until the index carries these records, the
  service reads the events itself in the background, after each index refresh.

With `NETWORK_ACTIVATION_TIME` unset the list says nothing about either. With it set and
`LOOKALIKE_RECEIVER` unset, it says nothing about look-alike records. The order is `registeredAt`,
then id.

`not-ready` comes instead of a shorter list whenever a passport that could belong in it cannot be
judged yet: the index is stale or not loaded through `asOf`, the index cannot say whether a verdict
landed, the look-alike events have not been read up to the chain head, or a document has never been
read. A document whose read failed is left out and read again ten minutes later.

Neither look-alike route reads the chain, Pinata or the gateway while the request waits: the
documents and the events are read in the background, and the answer comes from memory.

| Code | When |
| --- | --- |
| `200` | `ok` or `not-ready` |
| `400` | A missing or extra query parameter, an `n` outside 1 to 7, or an `asOf` that is not a whole number or is more than 60 seconds ahead |
| `429` | Over the service's 60 a minute per address, or `{ "error": "route-limit" }` once every caller together has asked 120 times this minute, with `retry-after` |

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
It counts, and the page lists, a claim older than thirty minutes that nobody closed, and `running`
leaves it out.

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
another attestation and nothing more. The runner keeps the report transactions it sent for seven
days, so a passport offered again after its done was lost is answered with the report it already
holds and is never paid for twice.

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
claimed. A done that arrives after the thirty minutes is still recorded: the request is offered again,
but it stays claimed underneath until a done closes it.

The runner reads only a `2xx` as recorded. A `503`, any other `5xx`, a `429` or a connection that
fails is tried again twice, two and then four seconds apart, and then logged; a `4xx` such as
`409 not-running` is not tried again.

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

The default path is `recheck-queue.json` in the data folder: `DATA_DIR` when it is set, else the
volume Railway mounts, which on the live service is `/data`, so the queue survives a redeploy and a
restart. `RECHECK_QUEUE_PATH` moves the queue alone. A host with neither a `DATA_DIR` nor a volume
keeps the file on the image's own disk, which every deploy empties, and says so once at boot. In
production a data folder that cannot be written stops the boot with one line naming it; in
development the queue is held in memory and forgotten when the process stops, and the cost of that is
one press of a free button. The private copy sweep keeps its place in the listing in the same data
folder.

## POST /platform/prepare

An outside image generator's server turns a picture its agent made into passport fields: signed
into a C2PA manifest that names the platform's ERC-8004 agent, fingerprinted, and either pinned for
the platform to register itself (`platform` mode) or frozen for a person to co-sign (`cosign` mode).
The guide is [For platforms](../developers/platform-kit), and `@moolam/platform` makes every call
below for you.

Mounted only when the host has `PINATA_JWT`, `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, a signing
certificate and key that load, and a platform list whose every signature checks out. A refused list
turns all four `/platform` routes off; it is never half loaded. Live on the hosted verify service. The
`deliverTo` part and its refusals below belong to the claim and delivery routes, and go live with
them at the next deploy.

**Headers.** `Authorization: Bearer <platform key>`, the 64 hex characters Moolam issued. The key
identifies and meters the platform and authorises nothing else.

**Request.** A multipart body.

| Part | Type | Rule |
| --- | --- | --- |
| `file` | file | The picture, a JPEG, PNG or WebP, up to 20 MB and 40 megapixels |
| `mode` | text | `platform` or `cosign` |
| `title` | text | 1 to 120 characters after trimming |
| `nonce` | text | `0x` and 64 hex characters, the PlatformPrepare's nonce |
| `issuedAt` | text | The PlatformPrepare's time in unix seconds |
| `signature` | text | The agent owner's 65 byte EIP-712 signature over the PlatformPrepare below |
| `training` | text | Optional. The AI-use terms as JSON, by the same rule as [`/prepare`](#post-prepare), with no space at either end of `constraintInfo` |
| `creator`, `wallet`, `agentId` | text | Optional. In platform mode a body may repeat the creator wallet and agent id its key is listed with, and never name others. In co-sign mode it may name no creator or wallet at all |
| `platformStatement` | text | Optional, platform mode only. The platform's own statement about the picture, written into the pinned document byte for byte as `platformStatement`, in place of the sworn line a person signs in the studio. One line of printable text, no space at either end, at most 1,000 bytes. Left out, the document carries no statement |
| `deliverTo` | text | Optional, platform mode only. JSON of exactly `{ "email": string, "verifiedBy": "google" \| "email-code" \| "platform" }`, at most 2,048 bytes, for a passport that waits for that person's email at Moolam. The address is hashed under the service's claim pepper and goes into no answer, log line or error; see [Leaving a passport for a person's email](../developers/platform-kit#leaving-a-passport-for-a-persons-email) |

Those twelve names, `file` and the eleven text parts, are the only ones read. Any other part name, or a
part sent twice, is a `400`.

The PlatformPrepare the agent's owner signs:

```ts
{
  domain: { name: "Moolam platform", version: "1", chainId: 143 },
  types: {
    PlatformPrepare: [
      { name: "mode", type: "uint8" },          // 0 platform, 1 cosign
      { name: "pictureHash", type: "bytes32" }, // sha256 of the file exactly as sent
      { name: "platformId", type: "bytes32" },  // sha256 of the platform key's 32 bytes
      { name: "nonce", type: "bytes32" },
      { name: "issuedAt", type: "uint64" },     // chain time, at most ten minutes old
    ],
  },
  primaryType: "PlatformPrepare",
}
```

```bash
curl -s -X POST https://<verify-service>/platform/prepare \
  -H "Authorization: Bearer $MOOLAM_PLATFORM_KEY" \
  -F "file=@lighthouse.png" -F "mode=cosign" -F "title=A lighthouse at dusk" \
  -F "nonce=0x..." -F "issuedAt=1790700000" -F "signature=0x..." \
  -F 'training={"aiTraining":"notAllowed"}'
```

**The order of checks.** The key, then the body, then the identity fields (P18), then `deliverTo`
when it is sent (its mode, whether the claim routes are open on this host, its shape), then `issuedAt`
against the latest block's time, then the agent owner's signature, recovered by the rules the
registry's ECDSA applies and compared with `ownerOf(agentId)` read on chain at that moment (P19),
then the replay memory, then, with `deliverTo`, whether this key may write a ticket now, then the
platform's quota and the ceiling for every platform. Only then is anything signed or pinned. The P and M numbers refer to the
[threat model](../security/threat-model#the-platform-kit-and-the-mcp-server). A request refused before the first pin or frozen file gives its quota
slot back.

**The manifest.** The claim generator is `moolam-platform-kit/0.1.0`, the action `c2pa.created` and
the source type `trainedAlgorithmicMedia`. Its `softwareAgent` names `<platform> generator` and, under
the key `app.vercel.moolam.erc8004`, the agent id and the registry
`eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. A picture the signer will not embed a
manifest in is refused, because the manifest is what names the agent.

**Response in platform mode.** `200`. The four files are pinned, each checked against the content id
computed before the pin.

```ts
{
  mode: "platform",
  passport: {
    exactHash: `0x${string}`,      // sha256 of signedFile, and the passport id
    parentId: `0x${string}`,       // 32 zero bytes: a platform picture is an original
    creator: `0x${string}`,        // the creator wallet the key is listed with
    generatorAgentId: string,      // the listed agent, decimal
    phash: string,
    blockhash256: `0x${string}`,
    manifestHash: `0x${string}`,
    kind: 0,                       // Generated
    fingerprintVersion: 1,
    metadataURI: string,           // ipfs://...
    deadline: string               // chain time plus 30 minutes, decimal
  },
  digest: `0x${string}`,           // hashPassport of those fields: what the agent and the passkey sign
  files: {
    image: { cid, uri, gatewayUrl, bytes },
    thumbnail: { cid, uri, gatewayUrl, bytes },
    manifest: { cid, uri, gatewayUrl, bytes },
    metadata: { cid, uri, gatewayUrl, bytes }
  },
  signedFile: { name, type, bytes, sha256 },  // bytes is base64; serve this file, not the upload
  manifest: { embedded: true },
  training?: { ...terms, standard: "cawg.training-mining/1.1" },
  platform: { name: string, agentId: string },
  deliverNow?: `0x${string}`,      // with deliverTo only: the person's standing choice for this key
  lookalike: { state: "found" | "yours" | "none" | "unchecked", ... }  // as under /prepare
}
```

`lookalike` is the warning described under [`/prepare`](#post-prepare), with the platform's own
creator wallet as the creator: its earlier passports read `yours`. When it says `found`, the pinned
document records `seenEarlier` as under `/prepare`. A platform's picture is never sent to the web
check, so there is no `webCheck` here and no `seenOnline` in the document.

With `deliverTo`, a ticket is written pending after the pins and opens once the chain shows the
passport under the platform's wallet. `deliverNow` appears only when the person behind that address
asked Moolam to send this platform's future pictures straight to their wallet, and only to the key
they chose it for; the platform registers, then hands the passport to that wallet. Every other answer
reads the same whether or not the address has a Moolam account (P30).

**Response in co-sign mode.** `200`. Nothing is pinned: the four files are frozen on the service's
volume under their computed content ids until the person has opened the link and the agent has
signed (P6).

```ts
{
  mode: "cosign",
  handle: string,                  // 32 hex characters, 128 bits from the CSPRNG, shown once
  passport: { ...the fields above, without creator and deadline },
  files: { image, thumbnail, manifest, metadata },
  openBy: number,                  // chain time by which the person must open the link
  manifest: { embedded: true },
  training?: { ...terms, standard: "cawg.training-mining/1.1" },
  platform: { name: string, agentId: string },
  lookalike: { state: "found" | "none" | "unchecked", ... }  // as under /prepare
}
```

In co-sign mode the creator is whoever opens the link, unknown at this point, so every earlier
look-alike reads `found` and none reads `yours`. The frozen document carries the sworn line the
person signs on the co-sign page, as under `/prepare`, and `seenEarlier` with a `found` look-alike.

The service keeps only the handle's sha256. The person's link is `https://moolam.vercel.app/cosign#<handle>`.

| Code | When |
| --- | --- |
| `200` | The fields, as above |
| `400` | A missing or misnamed file, an unknown or repeated part, a mode, title, nonce or `issuedAt` out of shape, or terms the consent contract would refuse |
| `400` | `platformStatement` sent in co-sign mode, or not one line of printable text with no space at either end and at most 1,000 bytes. Nothing is spent |
| `400` | `deliverTo`: the field was sent in co-sign mode, or is not JSON of exactly an email and one of the three `verifiedBy` words, is over 2,048 bytes, or holds an address the service's one email rule refuses. Only the field's name comes back, never its value |
| `401` | `unauthorized`: no key, or one no current entry holds. `agent-signature-required`: no `signature` part |
| `403` | `platform-mismatch` with the `field`: the body named a creator, wallet or agent the key is not listed with |
| `403` | `prepare-expired` with the `reason` and `chainTime`: `issuedAt` is more than ten minutes before chain time, or more than 60 seconds ahead of it |
| `403` | `agent-signature-refused`: the signature does not recover to the agent's owner on the identity registry now |
| `403` | `deliver-closed`: with `deliverTo`, this key's ticket writing is closed, because at least 10 of its tickets were refused and more than one in four. Prepares without `deliverTo` carry on |
| `409` | `replayed`: this nonce was already accepted for this platform. `same-picture`: this picture was already prepared by this platform inside the window |
| `409` | `already-registered` with the `passportId`: the registry already holds the signed picture |
| `413` | Over 20 MB or 40 megapixels, or `signed-file-too-large` |
| `415` | `not-an-image` |
| `422` | `manifest-not-embedded`, `thumbnail-too-large` or `fingerprint-unstable`, as under [`/prepare`](#post-prepare) |
| `429` | `quota` with `{ used, limit, resetsAt }`: past `PLATFORM_PREPARES_PER_KEY_PER_DAY` in a rolling 24 hours |
| `429` | `global-limit`, with `retry-after`: past `GLOBAL_PLATFORM_PREPARES_PER_DAY` for every platform together today. `0` closes the route |
| `429` | `pending-full`: this platform's waiting co-signs already hold 100 MiB of frozen files |
| `429` | `deliver-full`: with `deliverTo`, a ticket cap is reached: 20 tickets from this key for that address inside a ticket's 180 day life, whatever became of them, 1,000 of this key's tickets still waiting, or 20,000 tickets on the service |
| `500` | `signed-file-refused`: the signed file did not hash to the passport id. Nothing was pinned |
| `500` | `metadata-refused`: the document's statements did not fit their shape. Nothing was pinned |
| `502` | `sign-failed` or `pin-failed` |
| `503` | `claims-unavailable`: with `deliverTo`, the host's claim routes are closed (no `CLAIM_PEPPER` and `CLAIM_PEPPER_VERSION`), or the ticket file could not be read |
| `503` | `chain-unreachable`, `busy`, `service-fault`, `cosign-unavailable` (nowhere to freeze files), `pending-full` (5,000 waiting co-signs on the service), `closed` (the replay memory could not be believed after a restart, so every prepare is refused for ten minutes) or `full` (the replay memory holds 20,000 entries) |

Every answer on the four `/platform` routes carries `Cache-Control: no-store`.

## GET /platform/record/:handle

The co-sign page's read. The first time a signed-in person opens a record, their Moolam wallet
becomes its creator, once, and the deadline is set to chain time plus 30 minutes.

**Headers.** `Authorization: Bearer <Privy access token>`, checked as under [`/prepare`](#post-prepare).
The creator is the first embedded wallet Privy lists for that user, never a value in the request (P2).

**Response.** `200` with the record, including the `digest` the person's passkey will sign:

```ts
{
  state: "awaiting-creator" | "creator-set" | "signed" | "expired",
  agentId: string,
  platform: { name: string, agentId: string },
  exactHash: `0x${string}`,
  passport: { ...fields, creator?: `0x${string}`, deadline?: string },
  files: { image, thumbnail, manifest, metadata },
  openBy: number,
  digest?: `0x${string}`,
  agentSignature?: `0x${string}`
}
```

| Code | When |
| --- | --- |
| `200` | The record |
| `401` | `unauthorized`: no valid Privy token |
| `403` | `creator-mismatch`: the record's creator is another wallet. `no-wallet`: the user has no embedded wallet. Both still carry `agentId`, `platform` and `exactHash`, so the person sees what they were sent |
| `404` | `not-found`: not a handle this service issued, or no such record |
| `409` | `record-refused` with a `reason`: the record failed its checks on read and was dropped, never repaired (P3) |
| `410` | `expired`, with the same three public facts: the link was not opened by `openBy`, or the deadline passed |
| `502` | `wallet-lookup-failed` |
| `503` | `chain-unreachable` |

## POST /platform/sign/:handle

The platform's agent signs the passport digest, once the person has set the creator. The signature
is kept only if it recovers to `ownerOf(agentId)` read now, over the digest rebuilt from the record's
own fields (P5). Then the frozen files are pinned and each returned content id is checked against the
one computed at prepare (P6). Only after that may the person's page ask for their passkey.

**Headers.** `Authorization: Bearer <platform key>`, the key that made the record.

**Request.** `{ "signature": "0x..." }`, 65 bytes.

**Response.** `200` with the record as under `GET /platform/record/:handle`, in state `signed`, with
`digest` and `agentSignature`.

| Code | When |
| --- | --- |
| `200` | Signed and pinned |
| `400` | The body is not `{ "signature": "0x..." }` with 130 hex characters |
| `401` | `unauthorized` |
| `403` | `agent-signature-refused` |
| `404` | `not-found`, also for a record another key made |
| `409` | `awaiting-creator`: nobody has opened the link yet. `already-signed`. `signing`: a signature for this record is being pinned right now. `record-refused` with a `reason`: the stored digest or a frozen file no longer matches, and the record was dropped |
| `410` | `expired` |
| `502` | `pin-failed`: a file could not be pinned under the id the passport names. Nothing was signed; send again |
| `503` | `chain-unreachable` |

## GET /platform/status/:handle

Where a co-sign stands. The platform polls it with its key; the person may read it with their Privy
token. `digest` is in the answer only for the platform's key.

**Response.** `200` with the record, plus:

- `state: "registered"` and `registeredAt` once the registry holds this very passport: this creator,
  this agent, this metadata and this manifest (P13).
- `state: "failed"` and `reason` when the registry holds a different passport under the same id.
- `chain: "unknown"` when the chain could not be read, with the stored state unchanged.

| Code | When |
| --- | --- |
| `200` | The record, as above |
| `401` | `unauthorized`: neither a valid platform key nor a valid Privy token |
| `403` | `creator-mismatch`: a Privy token whose wallet is not the record's creator |
| `404` | `not-found`, also for a record another key made |
| `409` | `record-refused` with a `reason` |

**No handle in any log.** The three handle routes are mounted at log level `silent`, so no request
line carries a handle, and their refusals are logged without the URL. The handle is compared in
constant time, stored only as its sha256, and dies with its deadline (P4). Records are removed a day
after their deadline.

## GET /platform/deliveries

The platform's delivery worker reads it to learn which passports people accepted and where each
goes. A ticket exists only after a platform-mode `/platform/prepare` that carried a `deliverTo`
field; the guide is [Leaving a passport for a person's email](../developers/platform-kit#leaving-a-passport-for-a-persons-email),
and `runDeliveries` in `@moolam/platform` calls this route for you. Not live until the next deploy.

**Who may call.** A platform, with its key. **Headers.** `Authorization: Bearer <platform key>`.
**Request.** No body.

**Response.** `200`:

```ts
{
  deliveries: {
    ticketId: string,           // 32 hex characters
    passportId: `0x${string}`,
    destination: `0x${string}`  // the person's Moolam wallet, checksummed
  }[]
}
```

Only this key's accepted tickets whose `ownerOf`, read on chain at that moment, is still the
platform's wallet, oldest accepted first. The service reads the 64 oldest and lists at most 32 of
them. A ticket whose holder could not be read is left out of this answer, never guessed. Every
destination is checked again on the way out: never the zero address, the registry, the ticket's
platform wallet or any listed platform's wallet (P31). Moolam marks a ticket delivered by itself,
when the chain shows the destination holding the passport; the worker says nothing on success.

| Code | When |
| --- | --- |
| `200` | The list, which may be empty |
| `401` | `unauthorized`: no key, or one no current entry holds |
| `503` | `claims-unavailable`: the host has no claim pepper, or the ticket file could not be read |

## POST /platform/deliveries/:ticketId/failed

The worker gives up on a hand-over. The ticket moves from accepted to failed, is never listed again,
and the person's page says the platform could not hand it over (P34). Not live until the next deploy.

**Who may call.** A platform, with the key that wrote the ticket. **Headers.**
`Authorization: Bearer <platform key>`. **Request.** No body; the ticket id is in the path.

**Response.** `200` with `{ "ticketId": "<id>", "state": "failed" }`.

| Code | When |
| --- | --- |
| `200` | The ticket is now failed |
| `401` | `unauthorized` |
| `404` | `not-found`: not a ticket id, no such ticket, or another key's ticket, which answers like an unknown one |
| `409` | `not-accepted`: the ticket is not waiting for a hand-over, for example because it was delivered |
| `503` | `claims-unavailable` |

## The claims routes

Five routes a person's browser calls from My pictures on the Moolam web app, to see what platforms
hold for their verified email and to answer. The guide is
[Leaving a passport for a person's email](../developers/platform-kit#leaving-a-passport-for-a-persons-email),
and the standards are in the [threat model](../security/threat-model#claim-with-your-email). Not live
until the next deploy.

**Who may call.** A person signed in to Moolam. **Headers.** `Authorization: Bearer <Privy access
token>`, checked as under [`/prepare`](#post-prepare), and `Content-Type: application/json` on a
body. The service reads the person's addresses from Privy's own record of them, server-side, never
from the request: the email account and the Google account's email, each with Privy's verified time.
Each is hashed by the same rule a platform's address went through, and a ticket is the person's only
when its hash is one of theirs (P28, P32). No answer, refusal or log line carries an address or its
hash (P29).

**The order of checks, on all five.** The claim pepper (else `503` `claims-unavailable`), the token
(else `401` `unauthorized`), the body (else `400` with the name of the first field it failed on, or
`body` for a key the route does not read), the person's and the address's daily allowance and the
ceiling for everyone (else `429`), then Privy's record (else `502` `privy-unavailable`). A ticket file
that cannot be read answers `503` `claims-unavailable`, never a guess.

**Limits.** 500 calls a day per Privy user and 1,000 per address, together across the five routes,
and `CLAIM_REQUESTS_PER_DAY` for everyone, 20,000 by default; `0` closes the routes. The service's
60 requests a minute per address holds here too. One accept or
refuse names at most 32 tickets, `setConsentBatch`'s cap, each once. Every answer carries
`Cache-Control: no-store`.

### GET /claims

**Request.** No body.

**Response.** `200`:

```ts
{
  offers: {                       // open tickets, newest first, at most 100; none from a platform this person muted
    ticketId: string,
    passportId: `0x${string}`,
    platform: { name: string, keyHash: `0x${string}` },
    verifiedBy: "google" | "email-code" | "platform",   // the platform's own word, shown as its claim
    preview: { title: string, image: string } | null,   // image is ipfs://<cid>; null shows "No preview"
    createdAt: number
  }[],
  waiting: {                      // accepted, delivered or failed, newest accepted first, at most 100
    ticketId: string,
    passportId: `0x${string}`,
    platform: { name: string, keyHash: `0x${string}` },
    state: "accepted" | "delivered" | "failed",
    destination: `0x${string}`,
    terms: { aiTraining, aiGenerativeTraining, aiInference, dataMining, constraintInfo }  // exactly as accepted
  }[],
  standing: { platform: { name, keyHash }, destination: `0x${string}` }[],
  muted: { platform: { name, keyHash } }[]
}
```

A preview is read only through the pinned-content rule: a bare IPFS content id through Moolam's
gateway, a title of one printable line up to 120 code points, and a thumbnail that is itself a
content id. Anything else, a read that fails, or one that takes more than five seconds, is `null`
(P36).

| Code | When |
| --- | --- |
| `200` | The lists, any of which may be empty |
| `401`, `429`, `502`, `503` | As in the order of checks above |

### POST /claims/accept

"These are mine". Accepts the named tickets for the person's Moolam wallet, all or none.

**Request.**

```ts
{
  ticketIds: string[],     // 1 to 32 ticket ids, each once
  terms: {                 // every field required; the consent contract's own rule
    aiTraining: "unspecified" | "allowed" | "notAllowed" | "constrained",
    aiGenerativeTraining: "unspecified" | "allowed" | "notAllowed" | "constrained",
    aiInference: "unspecified" | "allowed" | "notAllowed" | "constrained",
    dataMining: "unspecified" | "allowed" | "notAllowed" | "constrained",
    constraintInfo: string // "" unless a use is constrained, then 1 to 256 printable ASCII bytes
  },
  sendFuture: boolean      // true: this wallet and these terms stand for each platform named
}
```

The wallet is the first embedded Ethereum wallet in the person's Privy record, never a value in the
body (P31). The terms are stored unchanged and later written by the person's own `setConsentBatch`
(P37).

**Response.** `200` with `{ "accepted": ["<ticket id>", ...], "destination": "0x..." }`.

| Code | When |
| --- | --- |
| `200` | Every named ticket is accepted |
| `400` | `ticketIds`, `terms`, `sendFuture` or `body`: the field that failed |
| `401` | `unauthorized` |
| `403` | `no-wallet`: the person has no embedded wallet yet. `destination`: that wallet is the registry, the ticket's platform wallet or a listed platform's wallet |
| `404` | `not-found`: an id that is not one of this person's tickets, unknown, or another person's. The whole request is refused |
| `409` | `not-open`: a named ticket was already answered, here or in another window. `record-refused`: the store refused the step |
| `429` | `limit` or `global-limit`, as above. `full`: the service's list of standing choices is full |
| `502` | `privy-unavailable` |
| `503` | `claims-unavailable` |

### POST /claims/refuse

"Not mine". Refuses the named tickets for good, all or none. Each refusal also mutes that platform
for this person's address until they allow it again, clears any standing choice for it, and counts
against the platform's key: a key with at least 10 refusals, more than one in four of its tickets,
stops writing tickets (P26, P38).

**Request.** `{ "ticketIds": ["<ticket id>", ...] }`, 1 to 32, each once.

**Response.** `200` with `{ "refused": ["<ticket id>", ...] }`.

| Code | When |
| --- | --- |
| `200` | Every named ticket is refused |
| `400` | `ticketIds` or `body` |
| `401` | `unauthorized` |
| `404` | `not-found`, as under accept |
| `409` | `not-open` or `record-refused` |
| `429` | `limit` or `global-limit`. `full`: the service's list of mutes is full |
| `502` | `privy-unavailable` |
| `503` | `claims-unavailable` |

### POST /claims/unmute

"Allow again". Lets a platform this person refused offer them pictures again.

**Request.** `{ "platformKeyHash": "0x..." }`, the `keyHash` from `muted` in `GET /claims`: `0x` and
64 hex characters.

**Response.** `200` with `{ "ok": true }`, also when there was nothing to remove.

| Code | When |
| --- | --- |
| `200` | Done |
| `400` | `platformKeyHash` or `body` |
| `401` | `unauthorized` |
| `409` | `record-refused` |
| `429`, `502`, `503` | As in the order of checks above |

### DELETE /claims/standing/:platformKeyHash

"Stop". Ends a standing choice, so that platform's future pictures wait for an answer again.

**Request.** No body; the platform's `keyHash` from `standing` in `GET /claims` is in the path.

**Response.** `200` with `{ "ok": true }`, also when there was nothing to remove.

| Code | When |
| --- | --- |
| `200` | Done |
| `400` | `platformKeyHash`: the path is not `0x` and 64 hex characters |
| `401` | `unauthorized` |
| `409` | `record-refused` |
| `429`, `502`, `503` | As in the order of checks above |

## POST /challenges/:passportId/answer

The holder of a challenged passport answers the challenge, once, with their wallet and no gas. The
answer is pinned to IPFS and its address comes back; pages draw it beside the dispute it answers.

Mounted on any host with `PINATA_JWT`. Under the service's 60 a minute per address, and 120 a minute
for everyone together.

**Request.** JSON, at most 32 KB:

```ts
{
  text: string,       // the answer: 1 to 4,000 bytes of UTF-8, printable; line breaks (\n, or
                      // \r\n read as one) are allowed so it can have paragraphs; a lone \r, a tab,
                      // every other control character and direction characters are refused;
                      // never rewritten
  deadline: number,   // unix seconds; the answer is refused after it, by chain time
  signature: string   // 0x and 130 hex characters: a plain 65 byte wallet signature
}
```

The holder's wallet signs this EIP-712 typed data:

```ts
{
  domain: { name: "Moolam", version: "1", chainId: 143, verifyingContract: "<registry>" },
  types: {
    ChallengeAnswer: [
      { name: "passportId", type: "bytes32" },
      { name: "openedAt", type: "uint64" },     // getDispute(passportId).openedAt
      { name: "challenger", type: "address" },  // getDispute(passportId).challenger
      { name: "answerHash", type: "bytes32" },  // sha256 of the text's UTF-8 bytes
      { name: "deadline", type: "uint64" },
    ],
  },
  primaryType: "ChallengeAnswer",
}
```

**What is checked, in one call.** The service reads `getDispute(passportId)` and `ownerOf` on the
registry at one block and judges everything against that block's time. It accepts the answer only
while that dispute is `Open`, no later than 14 days after its `openedAt`, no later than `deadline`,
and only when the signature, recovered by the rules the registry's ECDSA applies (65 bytes, `v` of
27 or 28, `s` in the lower half), is the holder's. Only a plain wallet signature counts: a contract
wallet's ERC-1271 signature is not checked against its contract and is refused. The signature binds
the passport, this very dispute and this text, so it cannot be carried to another passport, a later
challenge or other words. One answer per dispute; a signature already used is refused.

**The pinned document.**

```ts
{
  kind: "moolam-challenge-answer",
  version: 1,
  chainId: 143,
  registry: `0x${string}`,
  passportId: `0x${string}`,   // lower case
  openedAt: number,            // the dispute it answers
  challenger: `0x${string}`,
  holder: `0x${string}`,       // the wallet that signed, the holder at that block
  text: string,
  answerHash: `0x${string}`,
  deadline: number,
  signature: `0x${string}`,
  note: string
}
```

Anyone can check it against the chain and the holder's key without this service. It is the holder's
own words: Moolam checks who signed it, which dispute it names, its size and that it is plain text,
and judges nothing else. The text goes into no log line.

| Code | When |
| --- | --- |
| `200` | `{ "answerURI": "ipfs://<cid>" }` |
| `400` | A passport id that is not `0x` and 64 hex characters, a body of another shape, or a `text` that breaks the rule above. Nothing is read from the chain |
| `403` | `not-the-holder`: the signature does not recover to the passport's holder for this text, this dispute and this deadline. `answer-expired` with `chainTime`: the deadline has passed |
| `409` | `no-open-dispute`, `answer-window-closed` (more than 14 days after `openedAt`), `already-answered` with the `answerURI`, `signature-used`, `answering` (another answer for this dispute is being pinned now) or `no-holder` |
| `429` | The service's per-address limit, or `route-limit` with `retry-after` |
| `502` | `pin-failed`: nothing was kept, and the holder may send the same answer again |
| `503` | `chain-unreachable`, or `answers-unavailable` when the answers file could not be believed after a restart |

## GET /challenges/:passportId/answer

The pinned answer for the dispute the chain holds for this passport now. The service reads
`getDispute` and answers only the answer whose passport, `openedAt` and challenger match it, so an
answer to an earlier challenge is never drawn beside a later one. 600 a minute for everyone together,
on top of the per-address limit.

| Code | When |
| --- | --- |
| `200` | `{ "answerURI": "ipfs://<cid>", "answer": { ...the document above } }` |
| `400` | A passport id that is not `0x` and 64 hex characters |
| `404` | `not-found`: no challenge, or no answer to the current one |
| `503` | `chain-unreachable` or `answers-unavailable` |

Both answers carry `Cache-Control: no-store`.

## POST /decisions/reasons

Moolam's resolver pins the written reasons for a challenge it has settled, then names their address
in `MoolamDecisions.publish` (`0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F`). Only the resolver can
pin through this route: the proof is the resolver's own wallet signature, and the service holds no
key of its own for it. The Pinata key is the same one every other pin here uses.

Mounted on any host with `PINATA_JWT`. Under the service's 60 a minute per address, and its own
ceiling of 20 pins a day for everyone; a repeat of reasons already pinned takes no slot.

**Request.** JSON, at most 64 KB:

```ts
{
  passportId: string, // 0x and 64 hex characters
  openedAt: number,   // getDispute(passportId).openedAt of the settled dispute, unix seconds
  upheld: boolean,    // true when the challenge stood (Upheld), false when it was Rejected
  reasons: string,    // 1 to 8,000 bytes of UTF-8, printable; line breaks (\n, or \r\n read as
                      // one) allowed; a lone \r, a tab, every other control character and
                      // direction characters are refused; never rewritten
  deadline: number,   // unix seconds; refused after it, by chain time
  signature: string   // 0x and 130 hex characters: a plain 65 byte wallet signature
}
```

The resolver's wallet signs this EIP-712 typed data, in the same domain as the holder's answer:

```ts
{
  domain: { name: "Moolam", version: "1", chainId: 143, verifyingContract: "<registry>" },
  types: {
    DecisionReasons: [
      { name: "passportId", type: "bytes32" },
      { name: "openedAt", type: "uint64" },
      { name: "upheld", type: "bool" },
      { name: "reasonsHash", type: "bytes32" },  // sha256 of the reasons' UTF-8 bytes
      { name: "deadline", type: "uint64" },
    ],
  },
  primaryType: "DecisionReasons",
}
```

**What is checked, in one call and in this order.** The service reads, at one block, the resolver
from the policy `MoolamDecisions` reads, `getDispute(passportId)` on the registry and
`MoolamDecisions.published(passportId, openedAt)`. Then: the body has exactly the shape above; the
deadline has not passed by that block's time; the signature, recovered by the rules the registry's
ECDSA applies (65 bytes, `v` of 27 or 28, `s` in the lower half), is that resolver's, so a contract
wallet's ERC-1271 signature is refused; the dispute is settled with this `openedAt` and this outcome
(`Upheld` for `true`, `Rejected` for `false`); its reasons are not yet published; and the reasons
pass the text rule above. Only then is the document pinned.

**A stranger costs no chain read.** Before that one-block read, the service recovers the signer and
compares it with the resolver it last read. A signer that matches goes on to the full check above.
For any other signer, the service reads `resolver()` again only when a minute or more has passed
since its last attempt, whether that attempt was answered or failed, so a flood of strangers costs
at most one read a minute even while the chain is down. Every request arriving during a read shares
it. Inside the minute after an answered read, any other signer is refused `403 not-the-resolver`;
inside the minute after a failed read, any signer but the held resolver gets `503
chain-unreachable`, never a pass. A newly named resolver passes within a minute, and the old one is
refused by the one-block check meanwhile.

**The pinned document.**

```ts
{
  kind: "moolam-decision-reasons",
  version: 1,
  chainId: 143,
  registry: `0x${string}`,
  passportId: `0x${string}`,   // lower case
  openedAt: number,            // the dispute it explains
  upheld: boolean,
  resolver: `0x${string}`,     // the wallet that signed, the resolver at that block
  reasons: string,
  reasonsHash: `0x${string}`,
  note: string
}
```

It carries no signature and no deadline, so the same reasons for the same decision are the same
bytes and the same address: sending them again, even under a fresh signature, answers the address
already pinned without a second pin. The address always fits `MoolamDecisions.publish`: `ipfs://`
then letters and digits only, at least 46 of them, at most 128 bytes in all; a pin whose address
would not fit is refused and nothing is kept. The reasons go into no log line.

| Code | When |
| --- | --- |
| `200` | `{ "reasonsURI": "ipfs://<cid>" }`, the same address again for the same reasons |
| `400` | A body of another shape (nothing is read from the chain), or `reasons` that break the rule above |
| `403` | `reasons-expired` with `chainTime`: the deadline has passed. `not-the-resolver`: the signature does not recover to the policy's resolver for these reasons, this decision and this deadline |
| `409` | `dispute-not-settled` (never challenged, or still open), `dispute-mismatch` (settled with another `openedAt` or the other outcome), `already-published`, or `pinning` (the same reasons are being pinned now) |
| `429` | The service's per-address limit, or `global-limit` with `retry-after` when today's 20 pins are spent |
| `502` | `pin-failed` or `address-unfit`: nothing was kept, and the resolver may send the same body again |
| `503` | `chain-unreachable`, or `reasons-unavailable` when the reasons file could not be believed after a restart |

The answer carries `Cache-Control: no-store`.

## POST /mcp

The Model Context Protocol server: six read-only tools and two resources over the passport
registry, the AI-use register, the index and the ERC-8004 identity registry. Mounted on every host,
with no sign-in. The tools, their inputs and their answers are in
[For AI agents (MCP)](../developers/mcp). Live on the hosted verify service.

**Request.** A JSON-RPC message, `Content-Type: application/json`, with `Accept` naming both
`application/json` and `text/event-stream`. A 2026-07-28 client also sends `MCP-Protocol-Version`,
`Mcp-Method` and, for a tool call, `Mcp-Name`. A request without the version header is answered as a
2025-era client, statelessly.

```bash
curl -s -X POST https://<verify-service>/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_passport","arguments":{"passportId":"0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c"}}}'
```

**Response.** `200`, as JSON or as one short event stream (`event: message`, then `data:` and the
JSON-RPC result), with `Cache-Control: no-store, no-transform`. A tool that could not answer returns
a normal result with `isError: true` and one fixed sentence, never a protocol error: `unavailable:`
for a failed or stale read, or the input rule that was broken.

| Code | When |
| --- | --- |
| `200` | Any tool result, including `isError: true` |
| `400` | JSON-RPC `-32700`: the body is not JSON or ended early. JSON-RPC `-32602`: a 2026-07-28 request missing its per-request envelope |
| `403` | A browser `Origin` that is not one of `CORS_ORIGINS`. No `Origin` at all passes |
| `405` | `GET` or `DELETE`, with `Allow: POST`: the server keeps no stream and no session |
| `413` | Over a 20 MB picture as base64 plus 64 KB, refused before the body is read when the declared length says so |
| `415` | `Content-Type` is not `application/json` |
| `429` | Past 60 requests a minute from one address. Claude calls from Anthropic's cloud, so every Claude user shares one count |
| `503` | `busy`: the upload ceiling is full |

A browser client's preflight is told `POST` and the MCP header set are allowed, for the origins in
`CORS_ORIGINS` only.

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
and a record the service refused to publish. From the first pin that may have stored something it
stays taken, because the ceiling bounds what is spent and a pin is money. A failed pin counts as
nothing stored only when Pinata answered it with a 4xx or the request never left the service; a
5xx, a timeout, a dropped connection or an answer naming another file can each come after Pinata
kept the file, so they keep the slot. `/generate` counts the drawing as the spend, so a picture the
provider drew keeps its slot however the request ends, and a prompt the model turned down hands it
back.

The counts are saved in the data folder as `global-day.json`, beside the per-user allowances, so a
redeploy or a restart on the volume keeps them. A file that cannot be believed is read as today's
ceiling already reached, until midnight UTC. The platform routes keep their own ceiling the same way,
in `platform-day.json`.

What this does not do. A second copy of the service would keep its own counts, which is one reason
the service runs one. The counts bound how many actions a day holds, never what one of them costs. And the real bound on sponsored
gas is the daily cap on the Privy app, which is a dashboard setting that no code here can enforce.

## Nothing on these routes is cacheable

Every reply to a POST on `/prepare`, `/generate`, `/edit` and `/unseal` carries
`Cache-Control: no-store`, whatever its status. It is set in one hook on the way out rather than by
each route, so the replies no handler writes carry it too: the `401` sent before the body is read,
the `413` raised in the middle of an upload and the `429` from the rate limiter. These answers hold
a title, a prompt, a wallet address or, for a sealed registration, the only copy of a picture, and
none of that belongs in a proxy or a browser store. The hook judges by the route the request
matched, not by the path as sent, so a percent-encoded spelling such as `POST /%70repare`, which
the router decodes and runs as `/prepare`, carries the header too; a request that matches no route
is judged by its decoded path.

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
  index: { loadedAt: number, stale: boolean },
  version: string,
  routes: string[],
  off: { route: string, reason: string }[],
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
minute by default, so a passport registered a minute ago verifies without a redeploy. `index` is
the same pair every verify answer carries: `loadedAt`, the unix second of the last good load, and
`stale`, true once that is more than five refresh periods old. A refresh that keeps failing shows
here while `ok` and `records` still look healthy. `version` is
the package version. `routes` is what this host actually mounted, which is where a deploy missing a
key becomes visible from outside: a host without `PINATA_JWT` still boots and still verifies, and
`prepare` is simply not in the list. It is read on every call, so `generate` appears once the
registry check has read the chain and agreed. A host with `PINATA_JWT` lists `decisions/reasons`
there, for [POST /decisions/reasons](#post-decisionsreasons).

`off` names each route of a mounted family that is off right now, as `POST /prepare`, with a plain
reason. There are three kinds today: `POST /prepare`, `POST /generate` and `POST /edit` when the
host's signing certificate and key did not load; `POST /generate` while the registry on chain has
not been read yet, or was read and disagreed; and `POST /unseal` and `POST /sealed/forget` without
`PRIVY_APP_SECRET`. A reason never carries a path, an address or a key, which stay in the boot log.
A route whose family is not configured at all, such as `/prepare` without `PINATA_JWT`, is simply
absent from both lists.

`limits` is how much of [today's budget for everyone](#todays-budget-for-everyone) is gone, so a
daily check can see a ceiling coming before creators meet it. `links` is the private read links
minted today against `GLOBAL_LINKS_PER_DAY`. It counts the whole world and names nobody: there is
no per-caller data on this route. A host that mounts the unseal and sealed family lists `sealed` in
`routes`, and lists `unseal` only when `POST /unseal` is on, which needs `PRIVY_APP_SECRET` as well.

`recheck` is how many second opinions are waiting and how many a runner has in hand, which is where
a runner that has died shows up from outside: `pending` climbs and `running` stays at zero.

`sweep` is the hourly sweep of private copies no route will use again, set by
`PRIVATE_SWEEP`. It first runs an hour after boot and never at boot. Each run reads two pages of
100 from the account's private listing, asking Pinata for no name filter, and starts where the last
run stopped, going back to the first page once the listing ends. That place is kept in
`private-sweep-cursor.json` in the data folder, on the volume at `/data`, so a redeploy goes on from
there rather than reading the first pages again; a file that is missing or not one it
wrote means the first page. The run keeps only exact thumbnail names Pinata says were uploaded more
than 48 hours ago, and marks a file when the registry answered that its passport does not exist, or
when the passport is registered under a document that does not ask for a private re-check of it,
which leaves a copy no route would ever use. A registered passport's document that cannot be read
keeps its file. A chain read that failed, a listing it could not finish or an answer in an unknown
shape stops the run with nothing marked. In `dry`, the default, the host's log names each file it would
delete and its age in hours; in `delete` it deletes them. `off` is also what a host with no Pinata
token reports. No file name, file id or reason appears here: they stay in the host's log.

This is the one route outside the 60-a-minute limit. A status page, an uptime monitor or a build
pre-rendering hundreds of pages may probe it as often as it likes and never reads a refusal as an
outage; the answer costs microseconds. Every other route keeps the limit.

## Unknown routes

Answered with `404` and `{ "error": "no route for <METHOD> <path>" }`, as JSON rather than HTML.
Every rejection is logged with its reason and the caller's address.
