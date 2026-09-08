---
title: Verifier service
sidebar_label: Verifier service
sidebar_position: 3
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

The passport index is read into memory once at boot rather than queried per request, because a
Hamming search is a full scan by design and rebuilding it per call would put a file read in front
of every verification.

## Endpoints

Full request and response shapes are in the [API reference](../api/verifier-endpoints).

| Route | What it does |
| --- | --- |
| `POST /verify` | Takes a multipart `file` upload or a JSON body of `{ "url": "..." }`, returns the matching passport and any manifest |
| `POST /verify/paid` | The same answer behind an x402 payment. Multipart upload only. Mounted only when `X402_ENABLED=true`, otherwise the path answers 404 |
| `GET /health` | `{ ok, records, version }`, where `records` is how many passports the index holds |

Both verify routes read uploads, match and render their answer through the same shared code, so the
two cannot drift apart.

## The limits, and why each one exists

**20 MB per upload.** Big enough for a camera original, small enough that a flood cannot exhaust
memory. Enforced on the multipart part and again chunk by chunk while a remote body streams in,
because a `Content-Length` header is a claim by the remote server and not a fact.

**40 megapixels.** Refused with 413 before a single pixel is decoded, because a 572 KB JPEG can
unpack to 100 megapixels.

**Two concurrent matches.** Matching decodes the picture nine times over, so the rate limit alone
does not bound memory: sixty large uploads inside one minute would all decode at once. A third
caller parks on a promise and is woken by whichever match finishes next.

**60 requests a minute.** Counted on the socket address. `trustProxy` is off, so nobody can pick
their own rate-limit bucket by sending a header. Every rejection is logged with its reason.

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
| `X402_ENABLED` | `true` mounts the paid route, `false` (the default) leaves it off |
| `X402_PAY_TO_ADDRESS` | Who the USDC goes to, required when `X402_ENABLED` is true |
| `X402_PRICE` | Price per paid verification, default `$0.05` |
| `X402_FACILITATOR_URL` | Default `https://x402-facilitator.molandak.org`, Monad's facilitator |

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
