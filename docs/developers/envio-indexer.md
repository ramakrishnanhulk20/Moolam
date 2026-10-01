---
title: Envio indexer
---

# Envio indexer

`@moolam/indexer` turns Moolam's on-chain events into the data every screen and the verifier read:
passports, the edit tree, verification results, disputes, passkey bindings, what each holder says
AI may do with their picture, and the per-creator, per-generator and per-day counters. It is built on Envio HyperIndex V3 (`envio` 3.9.0), which syncs
from HyperSync rather than an RPC node.

## The live endpoint

```
https://indexer.dev.hyperindex.xyz/a8a9316/v1/graphql
```

The verify service reads its passport index from there when `PASSPORT_SOURCE=envio` and
`ENVIO_GRAPHQL_URL` names that URL. Runnable example queries are on the
[GraphQL page](../api/graphql).

## What it watches

From `config.yaml`, chain 143, starting at block 103054771, which is the block the three contracts
were deployed in. Nothing this index cares about exists before it.

| Contract | Address | From block | Events |
| --- | --- | --- | --- |
| MoolamRegistry | `0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0` | 103054771 | `PasskeyBound`, `PassportRegistered`, `VerificationAttested`, `PassportFlagged`, `DisputeResolved`, `Transfer` |
| VerifierPolicy | `0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821` | 103054771 | `ReceiverAdded`, `ReceiverRemoved` |
| MoolamConsent | `0x1151E69a82947920546e779c4C8c785b2a3C1277` | 105828247 | `ConsentSet` |
| MoolamLookalikes | `0xC0f3984A8116dB8BE514F649e3605A2a3aCd454C` | 109555239 | `LookalikeChecked` |
| MoolamDecisions | `0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F` | 109555263 | `DecisionPublished` |

The consent register was deployed ten days after the other two, so it carries a `start_block` of
its own and the sync skips 2.7 million blocks it could find nothing in.

The two look-alike contracts start at the blocks they were deployed in on 2026-10-01. The live
endpoint gains them, and every field below that comes from them, at its next redeploy.

Every passport row records the transaction that created it, through `field_selection`, so the app
can link straight to the explorer without a second lookup. The same selection brings in each
transaction's `to`, which is how the index tells a write that came through Chainlink's forwarder
from one sent straight to a receiver.

## The entities

**Passport.** One row per registered image, keyed by the image's exact hash, which is also the
ERC-721 token id. It carries the fingerprint (`phash`, `blockhash`, `manifestHash`,
`fingerprintVersion`), where it came from (`creator`, `generator`, `kind`), where it sits in its
edit tree (`parent`, `root`, `depth`, plus a derived `children` list), who holds it now (`owner`),
and the running verification tally (`attestationCount`, `matchedCount`, `mismatchedCount`,
`disputed`).

It also carries the statement that stands about AI use, flattened from the newest `ConsentEntry` so
a filter is one indexed query: `consentStated`, `consentSummary` (`open`, `closed`, `ask`, `mixed`
or `none`), the four numbers `consentAiTraining`, `consentAiGenerativeTraining`,
`consentAiInference` and `consentDataMining`, the conditions in `consentInfo`, and who wrote it
when in `consentWriter` and `consentAt`. `consentCount` is how many statements the passport has
collected and `consentEntries` is the derived list of them. `consentSummary` reads `none` for a
picture nobody has spoken for as well as for one whose holder wrote all four uses unspecified, so
`consentStated` is what separates silence from a holder who chose it.

Two fields come from Chainlink's look-alike checks. `earlierFound` is true when this passport's own
newest `Lookalike` row is the network's, is valid, and names an earlier passport.
`laterLookalikeCount` is how many passports' newest such row names this one. A row that a newer
check replaced counts for nothing, so a later run that found no look-alike, or found a different
one, takes the mark off both passports.

**ConsentEntry.** One statement, keyed `<passportId>-<index>` from the event's own index, never
edited after it is written. It holds the four numbers, the `summary`, the `constraintInfo`, the
`writer`, the `at` the contract recorded and the `txHash`. This is the table a reader quotes when
they need what was allowed on the day they used a picture, rather than what is allowed now. The
writer comes from the event and never from the transaction: a holder with a passkey wallet writes
through the ERC-4337 EntryPoint, so the transaction's sender is a bundler.

**Creator.** One row per wallet that has registered something, with `passportCount` for everything
it registered and `editCount` for the subset that were edits of an existing passport.

**Passkey.** The WebAuthn public key currently bound to a wallet. Rebinding replaces the row,
because only the current key can sign a registration.

**Generator.** One row per ERC-8004 agent id that has generated a registered image, with its
recheck record and its trust score.

**Attestation.** One row per verification result written on chain, keyed by transaction hash plus
log index. `network` is true only when the result was written by the verdict receiver
`0x0d69055c43eacb3b1ca687ca2263a049bc7eff04`, in a transaction sent to Chainlink's forwarder
`0x76c9cf548b4179f8901cda1f8623568b58215e62`, at or after the moment Chainlink's network deployment
went live. That moment is `NETWORK_ACTIVATION_TIME` in `src/network.ts`, in unix seconds; while it
is zero, nothing is the network's. Simulator results, and anything sent to a receiver by whoever
holds its keys, stay false. The rule reads the transaction, never a receiver's settings, so a
receiver re-pointed at another sender cannot pass it. It does not cover the network itself writing a
wrong result.

**Lookalike.** Chainlink's newest look-alike check of one passport, keyed by the passport id; a
newer record replaces the row, and an older one arriving later changes nothing. It holds `passport`,
`earlier` (null when the record named no earlier passport), the raw `earlierId` it named (all zeros
for none found), `phashDistance` out of 64 bits, `blockhashDistance` out of 256, `earlierSealed`,
the workflow run's `executedAt`, and `blockNumber`, `blockTimestamp` and `txHash`. `network` is the
same rule as on `Attestation`, with `MoolamLookalikes` as the writer. `valid` is true only when the
checked passport is in the index, both distances fit their fingerprints, and any earlier passport
is in the index, is a different passport, and was registered in a strictly earlier second. A tie
in the same second is never "earlier". A row with all-zero `earlierId` is "none found", never a
match, and never proof of originality: it means no earlier look-alike among the candidates Moolam's
search proposed. Only a row with `network` and `valid` both true is Chainlink's word about two real
passports in the right order; the rest stay in the table and are shown nowhere.

**Decision.** The reasons Moolam's resolver published for one settled challenge, keyed
`<passportId>-<openedAt>`, because a passport whose challenge was rejected can be challenged again.
It holds `passport`, `openedAt`, `upheld`, `reasonsURI`, `resolver`, `blockTimestamp` and `txHash`,
exactly as `MoolamDecisions` emitted them. That contract accepts a decision only from the policy's
resolver, only once the registry shows that challenge settled, and takes `upheld` and `openedAt`
from the registry, so the reasons are bound to the decision they explain on chain. `reasonsURI` is
always `ipfs://` and a content id; a page fetches it only through the pinned-content rule.

**Dispute.** One row per challenged passport, keyed by the passport id. `status` mirrors the
contract's `DisputeStatus` enum: 1 open, 2 upheld, 3 rejected.

**Receiver.** The verifier addresses the policy contract allows to write results. `since` is when
the current active or inactive state started, so it moves on every change.

**CreatorDay.** A marker row per creator per UTC day, keyed `<day>-<creator>`, with nothing in it
but the key. It is what lets `DailyStats.uniqueCreators` count distinct creators without reading
the day's passports back.

**DailyStats** and **GlobalStats.** Counters for the charts. `registrations` is every passport
registered that day and `edits` is the subset of those that had a parent, so edits are counted
inside registrations, not beside them. `disputes` counts challenges raised. `uniqueCreators` counts
the distinct creators who registered something that day, so a creator who posts five times counts
once. `consentStatements` counts statements written, on both rows. `passportsWithConsent`, on the
global row only, counts pictures that carry one: the two differ because a holder can restate, and a
chart that showed only the total would make a few holders changing their minds look like new
pictures arriving.
`networkAttestations`, on the global row only, counts the attestations Chainlink's network wrote, from the same check that sets `Attestation.network`, so a simulator run never reaches it.

Addresses are stored lowercase everywhere, including entity ids. Envio hands them back EIP-55
checksummed, so the handlers lowercase them first: one casing rule across the whole API means a
caller can never miss a row by asking with the wrong case. **Query with lowercase addresses.**

## The trust score

A generator's `trustScore` is

```
round(100 * (matched + 1) / (matched + mismatched + 2 * disputesUpheld + 2))
```

a Laplace-smoothed hit rate, so a brand new agent starts at a neutral 50 rather than a meaningless
100, and an upheld dispute counts double against it because a human resolver agreeing the record
was wrong is far stronger evidence than one verifier's hash missing by a few bits.

## Running it, on Linux only

`envio codegen` and the test indexer are Linux builds. On the Windows machine this was built on,
everything runs inside WSL2 Ubuntu with Node 22 from nvm, and `packages/indexer` has its own Linux
`node_modules` installed with `npm install --no-workspaces` so it never disturbs the repo root
install.

```bash
wsl -e bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd /mnt/d/Projects/Monad && npm run codegen:indexer'
wsl -e bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd /mnt/d/Projects/Monad && npm run test:indexer'
```

On a Linux or macOS machine the two `npm run` commands are all you need.

Codegen writes `.envio/types.d.ts`, which is git-ignored, and `envio-env.d.ts`, which is committed
and points TypeScript at it. Run codegen after any change to `config.yaml` or `schema.graphql`, or
the handler types go stale.

Twenty-six tests cover the handlers and the consent mapping against the generated types. They drive events through
Envio's `simulate`, and every simulated event has to sit at or after the `start_block` in
`config.yaml`. An event below that block is filtered out before it reaches a handler, and the test
fails with "items you passed to simulate never reached a handler" rather than an assertion error.

`envio dev`, which runs the whole indexer against Monad locally, needs Docker.

## Deploying on Envio Cloud

Envio Cloud builds with pnpm 10.32.0 and expects Node 24 or newer. It needs a `package.json` in the
root directory it is pointed at with `envio` pinned in `dependencies`, which
`packages/indexer/package.json` has. Every import in `src` and `test` resolves inside that folder,
so the build does not need the rest of the monorepo. No environment variables are needed.

Set the root directory to `packages/indexer`, the config file to `config.yaml`, and pick the
deployment branch. The free development plan allows three indexers per organisation and three
deployments each, and deletes a deployment that has processed 100,000 events, used 5GB, or served
no requests for 7 days.
