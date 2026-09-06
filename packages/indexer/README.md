# @moolam/indexer

Turns Moolam's on-chain events into the data every screen and the verifier read:
passports, the edit tree, verification results, disputes, passkey bindings, and
the per-creator, per-generator and per-day counters. Built on Envio HyperIndex V3
(`envio` 3.9.0), which syncs from HyperSync rather than an RPC node.

## Nothing here has been run yet

`envio codegen` only runs on Linux, and WSL2 is still being installed on the
build machine. So the handlers, the tests and this README were written against
Envio's published API, not against generated code, and none of it has executed.
What that means in practice:

- `src/generated-shape.d.ts` is a hand-written stand-in for the types codegen
  will emit. It is what lets the handlers and tests type-check today:
  `npx tsc --noEmit -p packages/indexer` reports 0 errors with it and 50 without
  it, the first of which is envio's own "Run 'envio codegen' to generate handler
  types from config.yaml". **Delete the stand-in the first time `envio codegen`
  runs.** It declares the `envio` module ambiently,
  and an ambient declaration wins over the real package in `node_modules` and
  hides every export it does not list. That was measured, not assumed; the
  commands and the exact TypeScript error are in
  `kitchen/reports/WO-3b-notes.txt`, section 5.
- The first `envio codegen` and `vitest run` may still turn up mismatches
  between the stand-in and the real generated types. Treat the first green test
  run as the proof, not this file.
- `config.yaml` still points at placeholder addresses
  `0x...0001` and `0x...0002`. Swap in the real ones from
  `packages/contracts/deployments/` and set `start_block` to the deploy block
  before deploying the index, or it will sync nothing.

## Commands

Run from the repo root:

```sh
npm run codegen:indexer   # envio codegen, writes .envio/types.d.ts
npm run test:indexer      # vitest run, the handler tests
```

## The entities

**Passport.** One row per registered image, keyed by the image's exact hash,
which is also the ERC-721 token id. It carries the fingerprint (`phash`,
`blockhash`, `manifestHash`, `fingerprintVersion`), where it came from
(`creator`, `generator`, `kind`), where it sits in its edit tree (`parent`,
`root`, `depth`, plus a derived `children` list), who holds it now (`owner`), and
the running verification tally (`attestationCount`, `matchedCount`,
`mismatchedCount`, `disputed`).

**Creator.** One row per wallet that has registered something, with
`passportCount` for everything it registered and `editCount` for the subset that
were edits of an existing passport.

**Passkey.** The WebAuthn public key currently bound to a wallet. Rebinding
replaces the row, because only the current key can sign a registration.

**Generator.** One row per ERC-8004 agent id that has generated a registered
image, with its recheck record and its trust score.

**Attestation.** One row per verification result written on chain, keyed by
transaction hash plus log index.

**Dispute.** One row per challenged passport, keyed by the passport id. `status`
mirrors the contract's `DisputeStatus` enum: 1 open, 2 upheld, 3 rejected.

**Receiver.** The verifier addresses the policy contract allows to write results.
`since` is when the current active or inactive state started, so it moves on
every change.

**DailyStats** and **GlobalStats.** Counters for the charts. `registrations` is
every passport registered that day and `edits` is the subset of those that had a
parent, so edits are counted inside registrations, not beside them. `disputes`
counts challenges raised. `uniqueCreators` counts creators whose very first
passport landed that day (see the known gap below).

Addresses are stored lowercase everywhere, including entity ids. Envio hands them
back EIP-55 checksummed, so the handlers lowercase them first: one casing rule
across the whole API means a caller can never miss a row by asking with the wrong
case. Query with lowercase addresses.

## The trust score

A generator's `trustScore` is
`round(100 * (matched + 1) / (matched + mismatched + 2 * disputesUpheld + 2))`,
a Laplace-smoothed hit rate so a brand new agent starts at a neutral 50 rather
than a meaningless 100, and an upheld dispute counts double against it because a
human resolver agreeing the record was wrong is far stronger evidence than one
verifier's hash missing by a few bits.

## Known gap

`DailyStats.uniqueCreators` currently counts creators whose first ever passport
landed that day, not distinct creators active that day. Counting the second one
properly needs a small marker entity in `schema.graphql`, something like
`type DailyCreator { id: ID! }` keyed `<day>-<creator>` and written with
`getOrCreate`, and `schema.graphql` was out of scope for this work order.

## Deploying on Envio Cloud

Ram's part, once the contract addresses are in `config.yaml` and the repo is
pushed:

1. Log in at https://envio.dev/app/login with GitHub and pick the organisation.
2. Install the Envio Deployments GitHub App on the Moolam repo.
3. Add Indexer, then set the root directory to `packages/indexer`, the config
   file to `config.yaml`, and the deployment branch.
4. No environment variables are needed on Cloud.

Envio Cloud builds with pnpm 10.32.0 and expects Node 24 or newer, and it needs a
`package.json` in that root directory with `envio` pinned in `dependencies`,
which `packages/indexer/package.json` has. The free development plan allows three
indexers per organisation and three deployments each, and deletes a deployment
that has processed 100,000 events, used 5GB, or served no requests for 7 days.
