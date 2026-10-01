# Moolam verifier: the Chainlink CRE workflow

Chainlink's network is the second opinion on every Moolam passport. When a creator registers an
image on Monad, this workflow wakes up, downloads the picture the passport points at, recomputes
the perceptual fingerprint itself, and writes the result back on chain as an attestation. Nothing
in that chain of steps trusts Moolam's own servers: the nodes fetch the image and do the maths
themselves, and they have to agree with each other before anything is signed.

## Two handlers

`initWorkflow` returns two handlers, in this order, and the order matters: `--trigger-index 0` is
what the droplet's recheck runner and every command below simulate.

| Index | Trigger | What it does |
| --- | --- | --- |
| 0 | `PassportRegistered` on the registry | measures the new passport's picture, writes the match verdict to the verdict receiver, then the look-alike step writes to `MoolamLookalikes` |
| 1 | cron, `0 */10 * * * *` (every ten minutes, UTC) | the catch-up: asks the verify service for passports still missing a network record and writes only what is missing |

`backlogPerRun: 0` leaves the cron handler out entirely, so a config can turn the catch-up off
without moving index 0.

## What runs, in order

1. **Trigger.** An EVM log trigger on the registry `0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0`,
   filtered to topic 0 of `PassportRegistered`, on `monad-mainnet` (chain id 143).
2. **Read.** The workflow calls `getPassport(bytes32)` on the registry at the block the trigger log
   came from, and takes the stored fingerprint and the metadata URI from there. The event is only
   the alarm clock; a forged log carries no weight because every value used is read back out of the
   registry. If that read comes back empty it is tried twice more, two seconds apart, and only then
   does the run fail. Each attempt is logged.

   Why that block and not the finalized one: a log trigger fires at Chainlink's default confidence
   of `SAFE`, which is ahead of the last finalized block, so a read pinned to finality can go
   looking for a registration the finalized state does not hold yet. The EVM client takes the block
   height as `blockNumber(n)` for an exact block, or the constants `LATEST_BLOCK_NUMBER` and
   `LAST_FINALIZED_BLOCK_NUMBER`; `log.blockNumber` arrives as a protobuf big integer, so
   `protoBigIntToBigint` converts it first. Reading at the log's own block also means every node
   reads the same state whatever height its own RPC has reached, which is what the retries are
   for: a node a block or two behind, not a chain that has changed its mind.
3. **Fetch.** Inside node mode, each node reads the passport's metadata document (an `ipfs://` file
   through the gateway, or an inline `data:application/json,` document), then downloads the
   thumbnail it names. Two HTTP requests for the verdict, against CRE's limit of fifteen a run.

   A passport registered sealed names no picture, and its document can never be rewritten, so when
   the document says `sealed: true` with no `thumbnail` or `image` key the node asks the verify
   service once, `GET {verifierUrl}/unseal/{passportId}`. On a 200 the record must name the same
   passport id as the log (both lower-cased by one function in `picture.ts`), and its thumbnail must
   be `ipfs://` followed by a content id and nothing else; the URL is then built on the configured
   gateway, and the record's own https link is never used. A 404, any other status, a timeout or a
   body that is not JSON stops the run with no report, and the error names the status and the
   passport id, never a URL. That path is three HTTP requests per run: document, record, thumbnail.
   The record answer is about 1.6 KB.
4. **Fingerprint.** `decode.ts` decodes the JPEG with jpeg-js, pure JavaScript because the sandbox
   is QuickJS on WebAssembly with no native modules. `phash.ts` recomputes the same 64-bit
   fingerprint the verifier stores: grey through linear light, 32 by 32, 2D DCT, the 8 by 8 block
   next to the DC term, one bit per coefficient above that block's average. The DCT is run in its
   separable form, once along each axis, which is 65,536 multiplications instead of 1,048,576 for
   the same result. `packages/verifier/test/workflow-phash.test.ts` holds the two fingerprints
   against each other on 24 generated images: identical on 11 of them, never more than 2 bits
   apart, against a match threshold of 10. The same test proves the separable DCT gives the same
   64 bits as the plain double sum it replaced.

   `blockhash.ts` recomputes the 256-bit block hash the same way: it is blockhash-core's
   `bmvbhash` at 16 bits a row, the function imghash runs for the verify service, copied step for
   step. `dihedral.ts` then turns and mirrors the decoded picture into the same eight variants the
   service's `src/dihedral.ts` builds, same names, same order, and takes both hashes of each.
   `packages/verifier/test/workflow-blockhash.test.ts` holds this against the service: on the same
   pixels the block hash is imghash's exactly; on the network's thumbnails of the robustness corpus
   (24 pictures and their 15 copies each, all eight variants, 3,072 in all) it stays within 28 block
   hash bits and 6 pHash bits of the service. All of that gap is the two JPEG decoders (jpeg-js here,
   libjpeg in sharp) rounding pixels differently, and 28 is inside the 36 bits of headroom the live
   measure left (`kitchen/reports/fingerprint-measure-2026-10-01.md`: the stored block hash and the
   thumbnail's are at most 4 bits apart on all 39 checkable passports, against a threshold of 40).
5. **Consensus.** The node function returns `{ recomputed, distance, blockhashDistance, matched }`
   and the eight fingerprint pairs, and `consensusIdenticalAggregation` requires a quorum of nodes
   to have produced the identical answer. The image bytes never go through consensus, so a CDN
   serving a slightly different re-encode to one node is fine as long as every node lands on the
   same fingerprints.
6. **Write.** A passport matches when the upright picture's pHash is within 10 bits of the stored
   one and its block hash within 40 bits of the stored one (both numbers from `lookalike-rule.ts`;
   the config's `matchThreshold` must equal the shared 10 or the config is refused). A passport
   whose stored block hash is not this picture's no longer matches on an honest pHash alone. The
   verdict is ABI encoded as
   `(uint256 chainId, uint64 executedAt, bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed)`,
   signed into a report, and delivered to a receiver that calls `attest` on the registry. A
   simulator run goes through Chainlink's mock forwarder to the public `SimulationReceiver`
   `0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95` (see "Where a broadcast lands" below). The workflow
   deployed to Chainlink's network goes through the production KeystoneForwarder to
   `MoolamReceiver` `0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04` (see "Two targets"). `chainId` and
   `executedAt` are inside the signed payload because Chainlink's own guidance says a report can be
   replayed later or on another chain; the receiver rejects a wrong chain id and any timestamp that
   is not newer than the last one for that passport.

   The write answers with two statuses, and the run only succeeds when both say success. The
   forwarder's transaction can succeed while the receiver inside it refuses the report, and then no
   attestation exists, so a receiver status of reverted, unknown or missing fails the run with
   `the receiver refused the report, so no attestation was written (receiver status ...)`, and a
   failed transaction fails it with `the report transaction did not succeed (status ...)`. Both
   statuses are logged with the receiver, as `write to 0x..: transaction X, receiver Y`, before the
   check. A failed run never prints `report tx`, which is the line the recheck runner reads as a
   verdict that landed.
   Chainlink's docs say the receiver status is always success in a simulation, which matches the
   mock forwarder swallowing a refusal (below), so only a deployed run can show one here.
7. **The look-alike step.** Only after the verdict has landed, so nothing here can hold it back,
   and only for an original (no parent); an Edited passport skips it. A passport whose own picture
   did not match its stored fingerprints skips it too, since a run that cannot vouch for the
   picture cannot say what it looks like.
   - One `POST {verifierUrl}/lookalikes/candidates` with this run's eight fingerprint pairs and
     `asOf` set to the new passport's `registeredAt`. The service may name up to three earlier
     passports. A status other than 200, `not-ready`, or a body that is not exactly
     `{"status":"ok","candidates":[...]}` with up to three distinct lower case ids is "no answer":
     nothing is written and the run fails, naming the verdict transaction that did land. A route
     that is down or rate limited can never be read as "none found".
   - Each named id is read with `getPassport`. It is kept only when the registry knows it, its
     `registeredAt` is strictly before the new passport's (the same second is never earlier, by
     `registeredBefore` in `lookalike-rule.ts`, the file the verify service keeps byte for byte),
     its creator is someone else, and one of this run's eight variants sits within 10 pHash bits
     and 40 block hash bits of its stored fingerprints. A read that fails writes nothing.
   - The earliest kept one is written, with both distances and whether its picture is kept from
     view: its document, read by the same pinned rule as the new passport's, says `sealed: true`, or
     cannot be read at all, which counts as sealed. None kept writes the zero id, which means "none
     among the candidates Moolam's search proposed", never "original".
   - The report is `(bytes32 kind = keccak256("moolam.lookalike.v1"), uint256 chainId,
     uint64 executedAt, bytes32 passportId, bytes32 earlierId, uint16 phashDistance,
     uint16 blockhashDistance, bool earlierSealed)`, 256 bytes, to `lookalikeReceiver` with a gas
     limit of 400,000. A refused write fails the run like a refused verdict does. A write that
     landed logs `look-alike written in tx 0x..`, worded apart from the verdict's `report tx` line
     so the recheck runner never mistakes one for the other.

   Worst case for one log-trigger run: 3 registry reads, 3 picture calls, 1 candidates call, 3
   candidate reads and 1 document, so 5 of CRE's 15 HTTP calls and 6 of its 15 contract reads.

## The catch-up (index 1, every ten minutes)

Chainlink's log trigger drops events over its quota, and passports registered before activation
were never run by the network at all. The cron handler fills both gaps.

1. `GET {verifierUrl}/lookalikes/backlog?asOf=<run time less 10 minutes>&n=<backlogPerRun>`. The
   service names up to seven passports, oldest first. No answer, in the same sense as above, writes
   nothing and fails the run.
2. For each id: `getPassport`, the verdict receiver's `lastExecutedAt(id)`, and for an original
   `MoolamLookalikes.originOf(id).executedAt`. A floor counts as the network's only at or after
   `activationTime`; verdicts the simulator wrote to `0x0d69` before 2026-09-26 sit below it and
   so count as missing.
3. Only what is missing is written: the verdict, the look-alike record, or both, by the same code
   as index 0. The service only chooses which ids to look at; the chain decides what is missing and
   the run measures the picture itself.

Budget, by design: 1 HTTP call for the backlog; per passport 2 or 3 reads for the floors, and only
when something is missing 3 calls for the picture, plus 2 calls and 3 reads for a missing look-alike.
A passport is started only when its worst case still fits in 15 calls and 15 reads, so at least two
passports fit in the worst case and four when only verdicts are missing. The rest wait, and the next
run is offered them again. Look-alike writes per run are capped at this run's share of
`lookalikesPerDay` (1,000 a day is 7 for the first 136 runs of the UTC day and 6 after), so the
catch-up never writes more than that in a day. The workflow keeps no count between runs, so the
log trigger's one write per registration is bounded by Chainlink's log-trigger quota and by the
verify service's own ceiling on its routes, not by this number.

## Config fields for the look-alike work

In `config.network.json` only. `config.json`, which the droplet runner simulates, has none of
them, so the look-alike step is off there and its runs are as before.

| Field | Now | Meaning |
| --- | --- | --- |
| `lookalikeReceiver` | `0xC0f3984A8116dB8BE514F649e3605A2a3aCd454C` | `MoolamLookalikes`. Absent turns the step off; the zero address runs every read and call and writes nothing (a dry run). Must not be the verdict receiver. |
| `activationTime` | `0` | Unix seconds when the network deploy went active. `0` means not set, and the catch-up then writes nothing. |
| `backlogPerRun` | `7` | Passports asked for per catch-up run, 1 to 7. `0` leaves the cron handler out. |
| `lookalikesPerDay` | `1000` | Look-alike reports the catch-up may write a day. `0` turns the look-alike step off in both handlers. |

Receiver addresses and the activation time come only from this file, never from the service.

## Tomorrow, in this order

1. `MoolamLookalikes` deployed (WO-273): done 2026-10-01 at `0xC0f3984A8116dB8BE514F649e3605A2a3aCd454C`,
   pins read back, ownership renounced, and set as `lookalikeReceiver`.
2. The verify service's two routes live on Railway (WO-275a). Until then every log-trigger run's
   look-alike step finds no route, writes nothing and fails after its verdict lands.
3. The receiver listing on the policy executed (after 2026-10-02 05:35 UTC), then the network
   deploy. Ram's yes.
4. `activationTime` set to the moment that deploy went active, then a redeploy, which gives a new
   workflow id. Ram's yes again. Until this step the catch-up writes nothing.

## Reading the look-alike records

Each record is the newest per passport. From this folder, with the RPC URL from the root `.env`:

```bash
cast call 0xC0f3984A8116dB8BE514F649e3605A2a3aCd454C \
  "originOf(bytes32)((bytes32,uint16,uint16,bool,uint64,uint64))" <passport id> \
  --rpc-url "$MONAD_MAINNET_RPC_URL"
```

The answer is `(earlierId, phashDistance, blockhashDistance, earlierSealed, executedAt, writtenAt)`.
`executedAt` zero means the network has never checked that passport. An `earlierId` of zero with a
non-zero `executedAt` means Chainlink found no earlier passport by someone else among the candidates
Moolam's search proposed, which is not proof that nobody registered it first. Every record is also a
`LookalikeChecked(passportId, earlierId, phashDistance, blockhashDistance, earlierSealed,
executedAt)` event on the explorer, in a transaction sent to the forwarder `0x76c9...5E62`.

## Private re-checks: `moolam-sealed-verifier`

A creator who seals a picture can ask for a private Chainlink re-check. The verify service then
keeps one 512 px thumbnail on Pinata's private network, where no public gateway serves it. The
public workflow above cannot reach that file, so a second workflow does the job, using Chainlink's
Confidential Workflows: the handler is registered with `handlerInTee(...)`, so it runs inside an
enclave, and only the verdict leaves it.

1. **Trigger.** The same `PassportRegistered` log trigger as the public workflow, registered with
   `handlerInTee(trigger, handler, {})`: any registered enclave, any region.
2. **Read.** `getPassport` at the log's block, with the public workflow's fallback to the latest
   block, made through `runtime.usingTheDons()`. Chain reads never run inside the enclave; the only
   thing sent out is the passport id, which is public.
3. **Document.** Read through the configured gateway from an `ipfs://` content id and nothing else.
   An http(s) address, a data URI or anything after the content id ends the run with no report.
4. **The predicate.** `privatelyRecheckable` in `private-copy.ts`, a byte for byte copy of the verify
   service's, held to it and to the shared fixture set by
   `packages/recheck-runner/test/sealed-private-copy.test.ts`. False ends the run with no report.
5. **The link.** The secret `SEALED_LINK_TOKEN` from the runtime, then one POST to
   `{verifierUrl}/sealed/link`. The service answers with a link only while the runner holds a claim
   on that passport in the re-check queue. The link is opened only if it reads as `https://` on the
   configured private gateway host, checked by hand because the sandbox has no URL parser.
6. **The bytes.** One GET on the link, ten seconds. A status other than 200, an empty body or a body
   over 60,000 bytes is refused before the decoder sees it. This fetch is the sealed workflow's own:
   its errors name the status and the passport id, never the link or the token.
7. **Fingerprint.** `../moolam-verifier/decode.ts` and `../moolam-verifier/phash.ts`, imported, not
   copied. Ten bits or fewer from the stored fingerprint is a match.
8. **The crossing.** `runtime.usingTheDons()`, one report over the same six fields, written to the
   sealed `SimulationReceiver` `0x52b8fE549B432920eeB061c26cAc5c2D527657f6` with a gas limit of
   1,000,000. That receiver is pinned to the name `moolam-sealed-verifier`, so the chain itself says
   which workflow wrote each verdict. It has taken the sealed workflow's reports since 2026-09-27; the
   first two private verdicts went to `0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A`, retired
   2026-09-26.

Three HTTP calls per run (document, link, bytes) against CRE's 15, and one to three contract reads.
The log lines keep the public workflow's shapes, `recomputed 0x.. distance N matched true` and
`report tx 0x..`, so the runner reads both. The folder holds `workflow.ts` (the handler),
`private-copy.ts` (the predicate, the link host check, the size cap and every refusal text, with no
imports so the runner's suite tests it under Node) and `secrets.yaml` (the name
`CRE_SEALED_LINK_TOKEN`, never a value).

Dry run on 2026-09-23, no `--broadcast`, against the unsealed passport's registration (tx
`0x789afc2f...b8b8`, event index 1). Its document is sealed with no private re-check asked, so the
run stops at the predicate and nothing is reported:

```
[USER LOG] passport 0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c stored phash 0x1f1fc003fbef6f47
✗ workflow execution failed: passport 0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c is not privately re-checkable: its document does not ask for a private re-check or names a public picture, so there is no private copy to open
```

```bash
export CRE_SEALED_LINK_TOKEN=...   # the value set on the verify service, never written to a file here
cre workflow simulate moolam-sealed-verifier --target monad-mainnet --non-interactive \
  --trigger-index 0 --evm-tx-hash <tx> --evm-event-index <n> -e ../../.env
```

What it does not prove:

- **The simulator is one machine, not an enclave.** It says so itself: "The simulator is not a real
  TEE, and is meant to debug. Do not use it for sensitive information." So a run proves the shape of
  the code and that the capability accepts it. It does not prove hardware isolation, and there is no
  node consensus behind the verdict either.
- **Deploying it needs access Moolam does not have.** Confidential Workflows is a private beta,
  invite only, separate from ordinary CRE deploy access.
- **The logic is public, only the data is private.** The workflow binary handed to the enclave is
  revealed. What the enclave keeps from the machine's operator is the token, the link, the bytes and
  the values made from them.
- **The logs would have to go.** The handler logs the stored fingerprint, the size of the copy and
  the verdict, which the runner reads in simulation. A deployed confidential handler should log
  nothing, because a log leaves the enclave.
- Moolam's operator, the Pinata account holder and the machine running the simulator can all see the
  thumbnail.

## Files

| File | What it holds |
| --- | --- |
| `moolam-verifier/workflow.ts` | Both handlers: the triggers, the reads, the fetches, the consensus wrappers and the writes |
| `moolam-verifier/phash.ts` | The pure TypeScript fingerprint, matched to sharp-phash |
| `moolam-verifier/blockhash.ts` | The pure TypeScript block hash, blockhash-core's `bmvbhash` as imghash runs it |
| `moolam-verifier/dihedral.ts` | The eight turns and mirrors and both hashes of each, as the verify service builds them |
| `moolam-verifier/lookalike.ts` | The look-alike decisions with no SDK: reading the service's answers, judging candidates, the run's budget and the daily share |
| `moolam-verifier/lookalike-rule.ts` | The 10 and 40 bit thresholds and `registeredBefore`, byte for byte the verify service's copy; never edited here alone |
| `moolam-verifier/decode.ts` | JPEG decoding inside the sandbox |
| `moolam-verifier/picture.ts` | Which picture a run fingerprints, including an unsealed passport's, with no network so it is tested from `packages/recheck-runner/test/workflow-picture.test.ts` |
| `moolam-verifier/config.json` | Chain name, registry, receiver, IPFS gateway, verify service, match threshold, for the simulator (`monad-mainnet`) |
| `moolam-verifier/config.network.json` | The same, with the network receiver `0x0d69...Eff04` and the look-alike fields, for the deployed workflow (`monad-network`) |
| `moolam-verifier/workflow.test.ts` | Whole runs of both handlers through the CRE SDK's test runtime: a write only counts when the transaction and the receiver both say success, and one named test for each look-alike and catch-up rule |
| `spike/decode-spike.ts` | The throwaway run that proved a JPEG can be decoded in the sandbox at all |
| `../verifier/test/workflow-phash.test.ts` | Holds this fingerprint against the verifier's sharp based one |
| `../verifier/test/workflow-blockhash.test.ts` | Holds the block hash and the eight variants against the verifier's own |

## Running it

The private key and the RPC URL come from the repository root `.env`
(`CRE_ETH_PRIVATE_KEY`, `MONAD_MAINNET_RPC_URL`). Nothing sensitive is written inside this package.

Dry run, no transaction sent, against a real past registration:

```bash
cre workflow simulate moolam-verifier --target monad-mainnet --non-interactive \
  --trigger-index 0 --evm-tx-hash <tx that emitted PassportRegistered> --evm-event-index 0 \
  -e ../../.env
```

Add `--broadcast` to send the attestation for real. The transaction is paid for by the CRE wallet
`0xC79620AF233a4434b03f6B57239F8A9E71B3C178`.

The workflow's own tests run under Bun, through the CRE SDK's test runtime, with no network:

```bash
cd moolam-verifier && bun test
```

### Two targets

| | `monad-mainnet` | `monad-network` |
| --- | --- | --- |
| what runs it | the CRE simulator, on the droplet's recheck runner and on this machine | Chainlink's network, once deployed to the private registry |
| config | `moolam-verifier/config.json` | `moolam-verifier/config.network.json` |
| forwarder | the mock, `0x9eF6468C5f37b976E57d52054c693269479A784d` | the KeystoneForwarder, `0x76c9cf548b4179F8901cda1f8623568b58215E62` |
| receiver | `SimulationReceiver` `0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95` | `MoolamReceiver` `0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04` |
| author the receiver expects | `0xaAaA...aAaA`, what the simulator stamps | `0xf072a8c620bfc818875736e3f2d3a2a339c06584`, the organisation's derived owner |
| who pays the write | the CRE wallet, on `--broadcast` | a Chainlink node; CRE credits per run |

The droplet's recheck runner always uses `monad-mainnet` (`CRE_WORKFLOW_TARGET` is unset there and
defaults to it), so nothing about the deployed workflow can change what the runner simulates. Both
targets carry `deployment-registry: "private"`: without it the CLI falls back to the onchain
Ethereum registry and tries to bond a wallet key to the organisation forever.

`MoolamReceiver` `0x0d69...Eff04` was re-pinned on 2026-10-01 to the author `0xf072...` and the name
`moolam-verifier`. Its return to the VerifierPolicy's list is queued (change id
`0x1f6c7d19619a5be01e970dc82888fddfa5381339ac6739c3ee51d58b468694ce`) and can be executed after
2026-10-02 05:35 UTC. Until that executes, the registry refuses every report the receiver passes on.

Dry run of the network target, no transaction sent. It compiles the same code with the network
config and shows the write it would make to `0x0d69`:

```bash
cre workflow simulate moolam-verifier --target monad-network --non-interactive \
  --trigger-index 0 --evm-tx-hash <tx that emitted PassportRegistered> --evm-event-index <n> \
  -e ../../.env
```

The workflow id the network will know it by (it changes with any change to the code or the
config): `cre workflow hash moolam-verifier --target monad-network -e ../../.env`.

**Deploying is Ram's yes, every time.** Do it only after the receiver's listing has executed and
`isReceiver(0x0d69...Eff04)` reads true, or every new registration triggers a run whose report the
registry refuses. From this folder:

```bash
cre whoami                                   # Deploy Access: Enabled
cre workflow deploy moolam-verifier --target monad-network -e ../../.env
```

It sends no transaction and costs no gas: the private registry is off chain. Check that the output
says `Owner Address: 0xf072a8c620bfc818875736e3f2d3a2a339c06584 (derived)` and `Status: Active`.
From then on every new `PassportRegistered` runs on the network and spends CRE credits. A
passport registered before activation is never run by the network.

Reading what it did:

```bash
cre workflow get moolam-verifier --target monad-network -e ../../.env   # health and last run
cre execution list moolam-verifier                                      # recent runs, newest first
cre execution list moolam-verifier --status FAILURE
cre execution status <execution-uuid>                                   # the error of a failed run
cre execution events <execution-uuid>                                   # each capability call
cre execution logs <execution-uuid>                                     # the workflow's own log lines
```

A run that landed logs `write to 0x0d69...: transaction SUCCESS, receiver SUCCESS` then `report tx 0x..`,
and on Monad that transaction to the forwarder carries a `VerificationAttested` log from `0x0d69`.

Stopping it, free and immediate for new triggers (a trigger that fires while paused is never run
later):

```bash
cre workflow pause moolam-verifier --target monad-network -e ../../.env
cre workflow activate moolam-verifier --target monad-network -e ../../.env   # resume
```

The second stop is on chain and is the deployer's: `VerifierPolicy.removeReceiver(0x0d69...Eff04)`
takes effect at once. Never run `cre workflow delete` without Ram: it removes every version for
good.

### Where a broadcast lands

A simulated run's report goes through Chainlink's `MockKeystoneForwarder`
`0x9eF6468C5f37b976E57d52054c693269479A784d` to the receiver named in the workflow's `config.json`.
Since 2026-09-27 at 14:18 UTC those are two `SimulationReceiver` contracts
(`packages/contracts/src/SimulationReceiver.sol`), both on the policy's list. Nothing has to be
switched before or after a run. Pins as read back after the deploy, in
`proofs/simulation-receivers.txt`:

| | `moolam-verifier` | `moolam-sealed-verifier` |
| --- | --- | --- |
| receiver | `0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95` | `0x52b8fE549B432920eeB061c26cAc5c2D527657f6` |
| forwarder | the mock, `0x9eF6468C5f37b976E57d52054c693269479A784d` | the same |
| sending wallet, fixed with no setter | the CRE wallet, `0xC79620AF233a4434b03f6B57239F8A9E71B3C178` | the same |
| workflow author | `0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa`, what the simulator stamps | the same |
| workflow name | `0x34623863303364663034` | `0x64323036636163326334` |
| workflow id | `0x1111111111111111111111111111111111111111111111111111111111111111`, what the simulator stamps | the same |

A report is refused unless it came through the mock, carries those three stamps, sits in a
transaction signed by the CRE wallet, names chain 143, is newer than the last verdict that receiver
took for the passport, and is at most an hour ahead of the block. The mock does not pass a refusal
on: the transaction still succeeds, its `ReportProcessed` event says false, and no
`VerificationAttested` log appears. The registry's `VerifierPolicy` is the second lock: it only
accepts `attest` from receivers on its list.

Before 2026-09-27 both workflows wrote to `MoolamReceiver` contracts, and the deployer wallet
pointed the public one, `0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04`, at the mock forwarder before
each broadcast and back at the production one after. Both came off the policy's list on 2026-09-26,
and every verdict they wrote stays on chain under their addresses. The public one is now the
deployed workflow's receiver (see "Two targets").

## What this does not prove

- The gateway is a trust point we name out loud. The workflow asks
  `https://gateway.pinata.cloud/ipfs/<cid>` for the bytes behind a content id. The content id is
  the hash of the content, so a gateway that serves the wrong bytes would produce a fingerprint
  that disagrees with every honest node and consensus would fail, but the workflow does not verify
  the CID itself, and a gateway that is down means no attestation rather than a wrong one.
- Only JPEG thumbnails are decoded. A PNG or WebP thumbnail needs another decoder.
- The verdict catches re-encodes, resizes and metadata strips of the passport's own picture. It
  compares the upright picture only. The look-alike step tries all eight turns and mirrors, so a
  quarter-turned or mirrored copy of an earlier passport is found; neither catches crops, which sit
  21 bits and more away.
- The look-alike record proves order of registration, never authorship: a thief who registers
  first is the earlier passport. Its "none" depends on the candidates Moolam's search proposes; a
  candidate the service withholds is never checked.
- A passport whose metadata names no image gets no attestation. The workflow refuses rather than
  guessing, which is the right answer but means the demo needs a passport that points at a real
  thumbnail.

## Cost

One attestation is one Monad transaction from the CRE wallet: about 267,000 gas measured on the
receiver path in the contract tests, with `attest` itself at most 154,000 of that. The gas limit is
capped at 1,000,000 in `workflow.ts`. At Monad mainnet gas prices that is a fraction of a cent per
verified image. The workflow's own compute, one JPEG decode and a 32 by 32 DCT, took about 550 ms
in the simulator when the DCT still summed over both axes, so that figure is now an upper bound.
Either way it is well inside the five minute execution budget, and the three retry attempts on the
registry read can add at most four seconds of waiting to it.
