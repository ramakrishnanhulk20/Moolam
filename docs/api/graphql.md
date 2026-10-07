---
title: GraphQL
---

# GraphQL

The Envio indexer serves every passport, edit tree, attestation, dispute and counter over GraphQL.

```
{{INDEX_URL}}
```

The address is set by the deployment, so it always names the index the site itself reads. On GitHub
it shows as a placeholder: the endpoint is the one on moolam.vercel.app/en/docs/api/graphql.

Each entity is a query field named exactly as it is in `schema.graphql`, taking `where`,
`order_by`, `limit` and `offset`. Addresses are stored lowercase, including entity ids, so query
with lowercase addresses or you will miss rows.

## The entities

| Entity | Keyed by | Holds |
| --- | --- | --- |
| `Passport` | The image's exact hash, which is also the token id | The fingerprint, where it came from, where it sits in its edit tree, who holds it now, the running verification tally, and the statement that stands about AI use |
| `ConsentEntry` | `<passportId>-<index>` from the event's own index | One statement about AI use, exactly as it was written, never edited afterwards |
| `Creator` | Wallet address | `passportCount` for everything it registered, `editCount` for the subset that were edits |
| `Passkey` | Wallet address | The WebAuthn public key currently bound. Rebinding replaces the row |
| `Generator` | ERC-8004 agent id | Its recheck record and its trust score |
| `Attestation` | Transaction hash plus log index | One verification result written on chain, and `network`: whether Chainlink's network wrote it |
| `Lookalike` | Passport id | Chainlink's newest look-alike check of that passport, with `network` and `valid` |
| `Decision` | `<passportId>-<openedAt>` | The reasons the resolver published for one settled challenge |
| `Dispute` | Passport id | `status` mirrors the contract enum: 1 open, 2 upheld, 3 rejected |
| `Receiver` | Verifier address | Whether the policy currently allows it, and since when |
| `CreatorDay` | `<day>-<creator>` | A marker row so `DailyStats.uniqueCreators` can count distinct creators |
| `DailyStats` | UTC day | `registrations`, `edits`, `attestations`, `disputes`, `uniqueCreators`, `consentStatements` |
| `GlobalStats` | `global` | `passports`, `creators`, `generators`, `attestations`, `networkAttestations`, `disputes`, `consentStatements`, `passportsWithConsent` |

`networkAttestations` is the part of `attestations` Chainlink's network wrote, counted from the same check that sets `Attestation.network`, so simulator runs never reach it.

`edits` is a subset of `registrations`, not a figure beside it. `BigInt` fields come back as
strings, which is why `phash` and `registeredAt` are quoted in the output below.

`consentStatements` counts statements written and `passportsWithConsent` counts pictures that carry
one. The two differ because a holder can restate: a counter that showed only the total would make a
few holders changing their minds look like new pictures arriving.

## The statement on a passport

The newest statement is flattened onto the passport itself, so narrowing the registry by what
holders have said is one indexed read rather than a walk through every statement ever written.

| Field | Type | Holds |
| --- | --- | --- |
| `consentStated` | `Boolean` | Whether a statement has ever been written for this picture |
| `consentSummary` | `String` | `open`, `closed`, `ask`, `mixed`, or `none` |
| `consentAt` | `BigInt` | When the newest statement was written, in whole seconds |
| `consentWriter` | `String` | The address that held the passport when it was written |
| `consentCount` | `Int` | How many statements this passport has collected |
| `consentAiTraining` | `Int` | 0 unspecified, 1 allowed, 2 not allowed, 3 conditions apply |
| `consentAiGenerativeTraining` | `Int` | The same four values |
| `consentAiInference` | `Int` | The same four values |
| `consentDataMining` | `Int` | The same four values |
| `consentInfo` | `String` | The conditions in the holder's own words, empty unless a use carries some |
| `consentEntries` | `[ConsentEntry]` | Every statement this passport has collected |

`consentSummary` reads `none` both for a picture nobody has spoken for and for a statement whose
holder named no use at all, so `consentStated` is what separates silence from a choice. Ask for
both together, the way the Explore filter does.

## Look-alikes and Chainlink's network

These fields are live from 2026-10-07: the hosted index is rebuilt with them, and the live endpoint
serves them.

On `Passport`:

| Field | Type | Holds |
| --- | --- | --- |
| `earlierFound` | `Boolean` | This passport's own newest `Lookalike` row is the network's, valid, and names an earlier passport |
| `laterLookalikeCount` | `Int` | How many passports' newest network, valid `Lookalike` row names this one |

On `Attestation`, `network` (`Boolean`) is true only for a result written by the verdict receiver
`0x0d69055c43eacb3b1ca687ca2263a049bc7eff04` in a transaction sent to Chainlink's forwarder
`0x76c9cf548b4179f8901cda1f8623568b58215e62`, at or after the network went live, 1790924898
(2026-10-02 07:08:18 UTC). Simulator results stay false.

`Lookalike`, one row per passport, the newest check only:

| Field | Type | Holds |
| --- | --- | --- |
| `passport` | `Passport` | The passport that was checked |
| `earlier` | `Passport` | The earlier passport it looks like, null when none was found |
| `earlierId` | `String` | The id the record named, all zeros for none found |
| `phashDistance` | `Int` | Perceptual hash distance, in bits of 64 |
| `blockhashDistance` | `Int` | Block hash distance, in bits of 256 |
| `earlierSealed` | `Boolean` | Whether the earlier passport's picture is sealed |
| `executedAt` | `BigInt` | When the workflow run that wrote it started; the newest wins |
| `blockNumber`, `blockTimestamp`, `txHash` | | Where it landed |
| `network` | `Boolean` | Written by `MoolamLookalikes` through Chainlink's forwarder after the network went live |
| `valid` | `Boolean` | Both passports are in the index, different, in a strictly earlier second, and the distances fit |

Filter on `network` and `valid` together: a row missing either is kept for the record and shown
nowhere. A row whose `earlier` is null means Chainlink found no earlier look-alike among the
candidates Moolam's search proposed, which is not proof that the picture is original.

```graphql
query RegisteredAfterALookalike {
  Lookalike(
    where: { network: { _eq: true }, valid: { _eq: true }, earlier_id: { _is_null: false } }
    order_by: { executedAt: desc }
    limit: 3
  ) {
    passport { id registeredAt }
    earlier { id registeredAt laterLookalikeCount }
    phashDistance
    blockhashDistance
    earlierSealed
    executedAt
    txHash
  }
}
```

`Decision` holds `passport`, `openedAt`, `upheld`, `reasonsURI` (always `ipfs://` and a content
id), `resolver`, `blockTimestamp` and `txHash`, exactly as `MoolamDecisions` emitted them. The
contract accepts a decision only from the policy's resolver once the registry shows that challenge
settled, and reads `upheld` and `openedAt` from the registry itself.

```graphql
query PublishedDecisions {
  Decision(
    where: { passport_id: { _eq: "0x<passport id, lowercase>" } }
    order_by: { openedAt: desc }
  ) {
    openedAt
    upheld
    reasonsURI
    resolver
    txHash
  }
}
```

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

`kind` is 0 for Generated, 1 for Captured, 2 for Edited. When this answer was captured, agent 10249
showed a trust score of 50 because nothing it made had been re-checked yet, which is what the
Laplace smoothing is for: a new agent starts neutral rather than perfect.

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

Run against the live endpoint when this was the only re-check on chain, so it is one row rather than five:

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

That row is a real Chainlink CRE attestation, the first one, written on 2026-09-08. The `id` is the
transaction hash plus the log index, `receiver` is `MoolamReceiver` (rows from simulator runs since
2026-09-27 name a `SimulationReceiver`; a verdict from Chainlink's network names `MoolamReceiver`
again), and `distance` 0 means the fingerprint the Chainlink nodes recomputed from the thumbnail
matched the one the creator registered exactly. The generator's trust
score of 67 is `round(100 * (1 + 1) / (1 + 0 + 0 + 2))`, one matched recheck against the smoothing
prior.

## Example: pictures open to AI use

Every picture whose holder allows all four uses in the standard, newest statement first. This is
the query behind the "Open to AI use" chip on [Explore](../guides/explore.md), and the whole answer
is one indexed read: nothing loops over the chain to build it.

```graphql
query OpenToAiUse {
  Passport(
    where: { consentStated: { _eq: true }, consentSummary: { _eq: "open" } }
    order_by: { consentAt: desc }
    limit: 3
  ) {
    id
    consentSummary
    consentAt
    consentWriter
    consentCount
  }
}
```

Run against the live endpoint:

```json
{
  "data": {
    "Passport": [
      {
        "id": "0x3dae5ee9d854d6af49857150873cefbe2df2a585e35ea86d34f0f47cb3b6403d",
        "consentSummary": "open",
        "consentAt": "1789885758",
        "consentWriter": "0xbb4eb7bf3e4e4960ee0c2f535bd31c84df35b6b2",
        "consentCount": 1
      },
      {
        "id": "0x5b3856dc4765c629e82f65ff920f13543f7c1ef818b52252d55b488387fe65b1",
        "consentSummary": "open",
        "consentAt": "1789717122",
        "consentWriter": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6",
        "consentCount": 1
      },
      {
        "id": "0x01f9243e5dafb9364ff4819c4f55379d5366acd37af2466ff69500ceb8438ed5",
        "consentSummary": "open",
        "consentAt": "1789717122",
        "consentWriter": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6",
        "consentCount": 1
      }
    ]
  }
}
```

Swap `"open"` for `"closed"` to get the pictures whose holders have refused, or drop
`consentSummary` and ask for `consentStated: { _eq: false }` to get the ones nobody has spoken for.

## Example: one passport's statement history

`ConsentEntry` is the table a reader quotes when they need what was allowed on the day they used a
picture rather than what is allowed now. Nothing in it is ever edited, so the oldest row is still
the first thing that holder said.

```graphql
query StatementHistory {
  ConsentEntry(
    where: { passport_id: { _eq: "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" } }
    order_by: { index: asc }
  ) {
    index
    summary
    aiTraining
    aiGenerativeTraining
    aiInference
    dataMining
    constraintInfo
    writer
    at
    txHash
  }
}
```

Run against the live endpoint:

```json
{
  "data": {
    "ConsentEntry": [
      {
        "index": 0,
        "summary": "closed",
        "aiTraining": 2,
        "aiGenerativeTraining": 2,
        "aiInference": 2,
        "dataMining": 2,
        "constraintInfo": "",
        "writer": "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6",
        "at": "1789717128",
        "txHash": "0x79d4de54855e958cd54cbecda3cc8ad734adfb24ffbfc4e6ef126191b4ad4b61"
      }
    ]
  }
}
```

`writer` comes from the event and never from the transaction: a holder on a passkey wallet writes
through the ERC-4337 EntryPoint, and the transaction's sender there is a bundler.

## Curl

```bash
curl -s -X POST {{INDEX_URL}} \
  -H 'content-type: application/json' \
  -d '{"query":"{ GlobalStats { id passports creators generators attestations networkAttestations disputes consentStatements passportsWithConsent } }"}'
```
