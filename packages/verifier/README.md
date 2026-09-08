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

`POST /verify/paid` is the same answer behind an x402 payment: 5 cents in USDC
on Monad mainnet, settled by Monad's facilitator. It only exists when
`X402_ENABLED=true`, and otherwise the path returns 404. Without a payment it
answers 402, the terms ride in the base64 `PAYMENT-REQUIRED` header, and the JSON
body says in words what to do next. It takes a multipart `file` upload only,
because a paid caller already has the bytes; the free route is the one that also
accepts a remote URL. Both routes read uploads, match and render their answer
through the same shared code, so the two cannot drift apart.

Every caller gets 60 requests a minute, counted on the socket address so nobody
can pick their own bucket by sending a header. Every rejection is logged with its
reason. Unknown routes answer with JSON, not HTML.

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
`kitchen/reports/WO-2-robustness.txt`, regenerate it with `npm run robustness`.

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
saves the whole run to `kitchen/reports/WO-6a-reputation.txt`. The score is
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
| `MONAD_MAINNET_RPC_URL` | where the reputation writer reads and sends, default `https://rpc.monad.xyz` |
| `VERIFIER_PRIVATE_KEY` | the wallet that signs reputation feedback, never the agent owner's |
| `VERIFIER_ADDRESS` | that wallet's address, the client a summary is read for |
| `VERIFIER_BASE_URL` | the public URL of this service, used as the feedback endpoint |
| `X402_ENABLED` | `true` mounts the paid route, `false` (the default) leaves it off |
| `X402_PAY_TO_ADDRESS` | who the USDC goes to, required when `X402_ENABLED` is true |
| `X402_PRICE` | price per paid verification, default `$0.05` |
| `X402_FACILITATOR_URL` | default `https://x402-facilitator.molandak.org`, Monad's facilitator |

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
