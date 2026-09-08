# @moolam/indexer

Turns Moolam's on-chain events into the data every screen and the verifier read:
passports, the edit tree, verification results, disputes, passkey bindings, and
the per-creator, per-generator and per-day counters. Built on Envio HyperIndex V3
(`envio` 3.9.0), which syncs from HyperSync rather than an RPC node.

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

Nine handler tests pass against the generated types with the live mainnet
addresses in `config.yaml`. The full output, with the codegen version and every
test name, is in `kitchen/reports/WO-3c-tests.txt`.

`envio dev`, which runs the whole indexer against Monad locally, needs Docker and
has not been run here. The Envio Cloud deployment below is the way this index
goes live.

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

**CreatorDay.** A marker row per creator per UTC day, keyed `<day>-<creator>`,
with nothing in it but the key. It is what lets `DailyStats.uniqueCreators` count
distinct creators without reading the day's passports back.

**DailyStats** and **GlobalStats.** Counters for the charts. `registrations` is
every passport registered that day and `edits` is the subset of those that had a
parent, so edits are counted inside registrations, not beside them. `disputes`
counts challenges raised. `uniqueCreators` counts the distinct creators who
registered something that day, so a creator who posts five times counts once.

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
which `packages/indexer/package.json` has. Every import in `src` and `test`
resolves inside this folder, so the build does not need the rest of the monorepo.
No `pnpm-workspace.yaml` was added here, because that is a guess until a real
Cloud build runs: if the first Cloud build fails while installing, add a
`pnpm-workspace.yaml` in this folder containing `packages: []` and redeploy, and
tell the team it was needed.

The free development plan allows three indexers per organisation and three
deployments each, and deletes a deployment that has processed 100,000 events,
used 5GB, or served no requests for 7 days.
