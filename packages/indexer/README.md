# @moolam/indexer

Turns Moolam's on-chain events into the data every screen and the verifier read:
passports, the edit tree, verification results, disputes, passkey bindings, what
each holder says AI may do with their picture, and the per-creator,
per-generator and per-day counters. Built on Envio HyperIndex V3 (`envio`
3.9.0), which syncs from HyperSync rather than an RPC node.

## Running it (Linux only)

`envio codegen` and the test indexer are Linux builds, so on this Windows machine
everything runs inside WSL2 Ubuntu with Node 22 from nvm, and `packages/indexer`
has its own Linux `node_modules` installed with `npm install --no-workspaces` so
it never disturbs the repo root install.

```sh
wsl -e bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd /mnt/d/Projects/Monad && npm run codegen:indexer'
wsl -e bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd /mnt/d/Projects/Monad && npm run test:indexer'
```

On a Linux or macOS machine the two `npm run` commands are all you need.

Codegen writes `.envio/types.d.ts`, which is git-ignored, and `envio-env.d.ts`,
which is committed and points TypeScript at it. Run codegen after any change to
`config.yaml` or `schema.graphql`, or the handler types go stale.

Thirty tests pass against the generated types with the live mainnet
addresses in `config.yaml`: twenty four drive the handlers through Envio's own
test indexer, and six are table tests over the consent mapping. One of the twenty four
replays every `ConsentSet` log Monad holds, read from the chain into
`test/fixtures/consent-events.json`. `proofs/indexer-tests.txt` holds an earlier
full run with the codegen version and the WSL command wrapper.

`envio dev`, which runs the whole indexer against Monad locally, needs Docker and
has not been run here. The Envio Cloud deployment below is the way this index
goes live.

## The entities

**Passport.** One row per registered image, keyed by the image's exact hash,
which is also the ERC-721 token id. It carries the fingerprint (`phash`,
`blockhash`, `manifestHash`, `fingerprintVersion`), where it came from
(`creator`, `generator`, `kind`), where it sits in its edit tree (`parent`,
`root`, `depth`, plus a derived `children` list), who holds it now (`owner`), the
first wallet its creator handed it to (`firstTransferTo`, with `firstTransferAt`
and `firstTransferBlock`), and the running verification tally
(`attestationCount`, `matchedCount`, `mismatchedCount`, `disputed`).

The three first handover fields are written once, by the first Transfer from the
creator to any other wallet, and never again: the mint, a creator sending to
itself, a resale and a passport that comes back to the creator and goes out a
second time all leave them as they were. A listed platform's credit rests on
them, because the person credited is the one the platform handed the picture to
first, never a later buyer. They stay null while the creator still holds it.

It also carries the statement that stands about AI use, flattened from the
newest `ConsentEntry` so a filter is one indexed query: `consentStated`,
`consentSummary` (`open`, `closed`, `ask`, `mixed` or `none`), the four numbers
`consentAiTraining`, `consentAiGenerativeTraining`, `consentAiInference` and
`consentDataMining`, the conditions in `consentInfo`, and who wrote it when in
`consentWriter` and `consentAt`. `consentCount` is how many statements the
passport has collected and `consentEntries` is the derived list of them.
`consentSummary` reads `none` for a passport nobody has spoken for as well as
for one whose holder wrote all four uses unspecified, so `consentStated` is what
separates silence from a holder who chose it.

**ConsentEntry.** One statement, keyed `<passportId>-<index>` from the event's
own index, never edited after it is written. It holds the four numbers, the
`summary`, the `constraintInfo`, the `writer`, the `at` the contract recorded and
the `txHash`. This is the table a reader quotes when they need what was allowed
on the day they used a picture, rather than what is allowed now. The writer comes
from the event and never from the transaction: a holder with a passkey wallet
writes through the ERC-4337 EntryPoint, so the transaction's sender is a bundler.

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

**CreatorDay.** A marker row per creator per UTC day, keyed `<day>-<creator>`,
with nothing in it but the key. It is what lets `DailyStats.uniqueCreators` count
distinct creators without reading the day's passports back.

**DailyStats** and **GlobalStats.** Counters for the charts. `registrations` is
every passport registered that day and `edits` is the subset of those that had a
parent, so edits are counted inside registrations, not beside them. `disputes`
counts challenges raised. `uniqueCreators` counts the distinct creators who
registered something that day, so a creator who posts five times counts once.
`consentStatements` counts statements written, on both rows.
`passportsWithConsent`, on the global row only, counts pictures that carry one:
the two differ because a holder can restate, and a chart that showed only the
total would make a few creators changing their minds look like new pictures
arriving.

Addresses are stored lowercase everywhere, including entity ids. Envio hands them
back EIP-55 checksummed, so the handlers lowercase them first: one casing rule
across the whole API means a caller can never miss a row by asking with the wrong
case. Query with lowercase addresses.

## Asking it about consent

The register was deployed months after the registry and the policy, so it
carries its own `start_block` in `config.yaml` and the sync skips 2.7 million
blocks it could find nothing in.

Every picture whose holder has opened it to AI, newest statement first. No screen
loops over the chain to build this: it is one indexed read.

```graphql
{
  Passport(
    where: { consentStated: { _eq: true }, consentSummary: { _eq: "open" } }
    order_by: { consentAt: desc }
    limit: 24
  ) {
    id
    owner
    consentAt
    consentWriter
    metadataURI
  }
}
```

One passport's whole history of statements, oldest first, with the conditions
each one carried.

```graphql
{
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

## The trust score

A generator's `trustScore` is
`round(100 * (matched + 1) / (matched + mismatched + 2 * disputesUpheld + 2))`,
a Laplace-smoothed hit rate so a brand new agent starts at a neutral 50 rather
than a meaningless 100, and an upheld dispute counts double against it because a
human resolver agreeing the record was wrong is far stronger evidence than one
verifier's hash missing by a few bits.

## Deploying on Envio Cloud

The operator's part, once the contract addresses are in `config.yaml` and the
repo is pushed:

1. Log in at https://envio.dev/app/login with GitHub and pick the organisation.
2. Install the Envio Deployments GitHub App on the Moolam repo.
3. Add Indexer, then set the root directory to `packages/indexer`, the config
   file to `config.yaml`, and the deployment branch.
4. No environment variables are needed on Cloud.

Envio Cloud builds with pnpm 10.32.0 and expects Node 24 or newer, and it needs a
`package.json` in that root directory with `envio` pinned in `dependencies`,
which `packages/indexer/package.json` has. Every import in `src` and `test`
resolves inside this folder, so the build does not need the rest of the monorepo.
No `pnpm-workspace.yaml` was added here, because that is a guess until a real
Cloud build runs: if the first Cloud build fails while installing, add a
`pnpm-workspace.yaml` in this folder containing `packages: []` and redeploy, and
tell the team it was needed.

The free development plan allows three indexers per organisation and three
deployments each, and deletes a deployment that has processed 100,000 events,
used 5GB, or served no requests for 7 days.

Run the tests with `npm test` from this folder inside WSL: the package script resolves the Linux vitest installed here, while a bare `npx vitest` from this folder picks the Windows install at the repo root and fails on its native binding.
