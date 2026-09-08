---
title: Verifier endpoints
sidebar_label: Verifier endpoints
sidebar_position: 4
---

# Verifier endpoints

Three routes. Everything is JSON, including errors and 404s. The service listens on
`VERIFIER_PORT`, which defaults to 4000.

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
