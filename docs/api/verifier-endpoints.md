---
title: Verifier endpoints
---

# Verifier endpoints

Four routes. Everything is JSON, including errors and 404s. The service listens on
`VERIFIER_PORT`, which defaults to 4000. Two of the four are mounted only when the host is
configured for them: `/verify/paid` needs `X402_ENABLED`, and `/prepare` needs a Pinata token and a
Privy app id.

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
      score: number
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

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Matched, or ran and found nothing. Finding nothing is a 200 with `best: null` |
| `400` | No multipart `file` field and no `{ "url": "..." }` body, a part named something other than `file`, an empty file, or an upload that is not an image the service can decode |
| `403` | The URL resolves to a loopback, private, link-local, unique-local, carrier-grade NAT, multicast, reserved or cloud metadata address, before or after any redirect |
| `413` | Over the 20 MB byte limit, or over 40 megapixels once decoded |
| `429` | Over 60 requests in a minute from that socket address |
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

**Response.** `200` with the same `{ result, manifest }` body as `/verify`.

**Status codes.**

| Code | When |
| --- | --- |
| `200` | Paid and matched. Settlement headers ride on the response |
| `402` | No payment. The terms ride in the base64 `PAYMENT-REQUIRED` header, and the JSON body says in words what to do next |
| `400`, `403`, `413` | Same as `/verify` |
| `404` | `X402_ENABLED` is not `true` |
| `429` | Over 60 requests in a minute |
| `502` | The facilitator did not answer, the payment could not be checked, or settlement threw |

Payment is settled only after the match succeeds, so a failed verification never charges. When the
handler fails after a payment was verified, the authorisation is cancelled rather than left
standing against the payer.

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

**Headers.** `Authorization: Bearer <Privy access token>`, plus the multipart `Content-Type` the
browser or curl sets. The token has to be signed by the app's own key set, carry the issuer
`privy.io`, name this `PRIVY_APP_ID` in its audience, be inside its expiry, and use ES256.

```bash
curl -s -X POST http://localhost:4000/prepare \
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \
  -F "file=@photo.jpg" -F "title=Monsoon fishing nets" -F "kind=human"
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
| `400` | Not a multipart body, no `file` part, an empty file, a file part under another name, a `title` outside 1 to 120 characters, or a `kind` other than `human` |
| `401` | No `Authorization: Bearer` header, or a token that fails on its signature, issuer, audience, algorithm or expiry. A key set that cannot be fetched answers the same way, so a caller never learns the difference between a bad token and a bad network. `{ "error": "unauthorized" }` |
| `413` | Over the 20 MB byte limit, or over 40 megapixels once the header is read |
| `415` | The file is not an image the service can decode. `{ "error": "not-an-image" }` |
| `429` | Over 20 prepares in an hour, counted on the Privy user id from the token, or on the socket address when there is no valid one. This limit replaces the global 60 a minute on this path |
| `502` | Pinata refused a pin. `{ "error": "pin-failed" }`. Pinata's status and its answer go to the log and never to the caller, and the token appears in neither |

**CORS.** A browser may call this service only from an origin listed in `CORS_ORIGINS`, and those
are exact origins: `https://moolam.app`, never a wildcard, a path or a trailing slash. The allowed
methods are `GET` and `POST`, and the allowed headers are `Authorization` and `Content-Type`. An
origin that is not on the list gets no allow header back, which the browser turns into a refusal on
its side; curl and any server-side caller are unaffected either way. With `CORS_ORIGINS` empty, no
browser origin is allowed at all.

## GET /health

```bash
curl -s http://localhost:4000/health
```

```ts
{ ok: boolean, records: number, version: string }
```

`records` is how many passports the index is holding, which is what tells you whether the service
booted against the source you meant. `version` is the package version.

## Unknown routes

Answered with `404` and `{ "error": "no route for <METHOD> <path>" }`, as JSON rather than HTML.
Every rejection is logged with its reason and the socket address.
