---
title: GraphQL
---

# GraphQL

The Envio indexer serves every passport, edit tree, attestation, dispute and counter over GraphQL.

```
https://indexer.dev.hyperindex.xyz/a8a9316/v1/graphql
```

Each entity is a query field named exactly as it is in `schema.graphql`, taking `where`,
`order_by`, `limit` and `offset`. Addresses are stored lowercase, including entity ids, so query
with lowercase addresses or you will miss rows.

## The entities

| Entity | Keyed by | Holds |
| --- | --- | --- |
| `Passport` | The image's exact hash, which is also the token id | The fingerprint, where it came from, where it sits in its edit tree, who holds it now, and the running verification tally |
| `Creator` | Wallet address | `passportCount` for everything it registered, `editCount` for the subset that were edits |
| `Passkey` | Wallet address | The WebAuthn public key currently bound. Rebinding replaces the row |
| `Generator` | ERC-8004 agent id | Its recheck record and its trust score |
| `Attestation` | Transaction hash plus log index | One verification result written on chain |
| `Dispute` | Passport id | `status` mirrors the contract enum: 1 open, 2 upheld, 3 rejected |
| `Receiver` | Verifier address | Whether the policy currently allows it, and since when |
| `CreatorDay` | `<day>-<creator>` | A marker row so `DailyStats.uniqueCreators` can count distinct creators |
| `DailyStats` | UTC day | `registrations`, `edits`, `attestations`, `disputes`, `uniqueCreators` |
| `GlobalStats` | `global` | `passports`, `creators`, `generators`, `attestations`, `disputes` |

`edits` is a subset of `registrations`, not a figure beside it. `BigInt` fields come back as
strings, which is why `phash` and `registeredAt` are quoted in the output below.

## Example: the newest passports

```graphql
query NewestPassports {
  Passport(order_by: { registeredAt: desc }, limit: 3) {
    id
    kind
    phash
    fingerprintVersion
    registeredAt
    disputed
    attestationCount
    matchedCount
    owner
    creator { id passportCount }
    generator { id trustScore }
  }
}
```

Run against the live endpoint:

```json
{
  "data": {
    "Passport": [
      {
        "id": "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638",
        "kind": 0,
        "phash": "7840506850305415717",
        "fingerprintVersion": 1,
        "registeredAt": "1788881666",
        "disputed": false,
        "attestationCount": 0,
        "matchedCount": 0,
        "owner": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6",
        "creator": { "id": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6", "passportCount": 10 },
        "generator": { "id": "10249", "trustScore": 50 }
      },
      {
        "id": "0xdece558a3ca0a892a2e0ee1b5295a7140bed9388e78416b86c058f23fbb29436",
        "kind": 0,
        "phash": "5981005701605027647",
        "fingerprintVersion": 1,
        "registeredAt": "1788881590",
        "disputed": false,
        "attestationCount": 0,
        "matchedCount": 0,
        "owner": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6",
        "creator": { "id": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6", "passportCount": 10 },
        "generator": { "id": "10249", "trustScore": 50 }
      },
      {
        "id": "0x7cb4aead3b37f16b78a203a43aba83db10fa5f2fc7629f353826183d8c9d693f",
        "kind": 0,
        "phash": "4119816390749050675",
        "fingerprintVersion": 1,
        "registeredAt": "1788881503",
        "disputed": false,
        "attestationCount": 0,
        "matchedCount": 0,
        "owner": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6",
        "creator": { "id": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6", "passportCount": 10 },
        "generator": { "id": "10249", "trustScore": 50 }
      }
    ]
  }
}
```

`kind` is 0 for Generated, 1 for Captured, 2 for Edited. Agent 10249 shows a trust score of 50
because nothing it made has been rechecked yet, which is what the Laplace smoothing is for: a new
agent starts neutral rather than perfect.

## Example: what the verifiers have recorded

```graphql
query VerifiedPassports {
  Attestation(order_by: { at: desc }, limit: 5) {
    id
    receiver
    matched
    distance
    recomputed
    at
    passport {
      id
      phash
      generator { id trustScore matchedCount mismatchedCount disputesUpheld }
    }
  }
}
```

Run against the live endpoint:

```json
{
  "data": {
    "Attestation": [
      {
        "id": "0x3a814ab20ac8c2e1c8d46c944c612722c6878a80cd823235afd2434de88796a0-211",
        "receiver": "0x0d69055c43eacb3b1ca687ca2263a049bc7eff04",
        "matched": true,
        "distance": 0,
        "recomputed": "0x000000000000000000000000000000000000000000000000233ccc7872442123",
        "at": "1788876281",
        "passport": {
          "id": "0x5f66c389c9561e05141dc6276b80d82dd1eb356984535b1bfd0a83c6ae1e54ed",
          "phash": "2539129107615326499",
          "generator": {
            "id": "10248",
            "trustScore": 67,
            "matchedCount": 1,
            "mismatchedCount": 0,
            "disputesUpheld": 0
          }
        }
      }
    ]
  }
}
```

That row is a real Chainlink CRE attestation. The `id` is the transaction hash plus the log index,
`receiver` is `MoolamReceiver`, and `distance` 0 means the fingerprint the Chainlink nodes
recomputed from the thumbnail matched the one the creator registered exactly. The generator's trust
score of 67 is `round(100 * (1 + 1) / (1 + 0 + 0 + 2))`, one matched recheck against the smoothing
prior.

## Curl

```bash
curl -s -X POST https://indexer.dev.hyperindex.xyz/a8a9316/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ GlobalStats { id passports creators generators attestations disputes } }"}'
```
