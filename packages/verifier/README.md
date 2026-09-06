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

```sh
curl -s -F "file=@packages/verifier/test-assets/original.jpg" http://localhost:4000/verify
```

`GET /health` answers `{ ok, records, version }`, where `records` is how many
passports the index is holding.

Every caller gets 60 requests a minute, counted on the socket address so nobody
can pick their own bucket by sending a header. Every rejection is logged with its
reason. Unknown routes answer with JSON, not HTML.

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

## Using a real corpus

The generated images are reproducible, not realistic: clean edges and even grain
flatter a perceptual hash. Put 10 or more real `.jpg` or `.png` files in
`corpus/` and `npm run robustness` uses them instead and says so in its first
lines. See `corpus/README.md`. The image files are gitignored.

## Configuration

| variable | meaning |
| --- | --- |
| `VERIFIER_PORT` | port to listen on, default 4000 |
| `PASSPORT_SOURCE` | `json` today, `envio` is reserved for the indexer and not built |
| `PASSPORT_SOURCE_PATH` | the JSON passport file, default `test-assets/passports.json` |
| `MOOLAM_C2PA_CERT_PATH` | signing certificate chain, optional |
| `MOOLAM_C2PA_KEY_PATH` | signing key, optional |

All of it is checked at boot and a bad value names itself, so
`VERIFIER_PORT=abc` stops the service before it listens rather than after.

Signing certificate: the npm package of `@contentauth/c2pa-node` ships only
`dist`, `scripts` and `src`, so the test certificates in its GitHub repository
are not installed with it. On first run the package generates its own throwaway
ES256 chain (a root plus a signer) into `test-assets/certs/` with openssl.
Manifests signed with it read back as `signingCredential.untrusted`, which is
correct: it is not on the public C2PA trust list. Point the two paths above at a
real certificate and key to sign with a trusted identity.
