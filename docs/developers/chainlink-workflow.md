---
title: Chainlink CRE workflow
---

# Chainlink CRE workflow

Chainlink's network is the second opinion on every Moolam passport. When a creator registers an
image on Monad, this workflow wakes up, downloads the picture the passport points at, recomputes
the perceptual fingerprint itself, and writes the result back on chain as an attestation. Nothing
in that chain of steps trusts Moolam's own servers: the nodes fetch the image and do the maths
themselves. On Chainlink's network a quorum of nodes must produce the identical verdict before a
report is signed, and since 2026-10-02 the workflow's verdict step runs there: the first network
verdict is in "On Chainlink's network" below. Every re-check before it came from Chainlink's
simulator with `--broadcast`, which is one machine and no consensus, and the passport page labels
each one by the forwarder that delivered it. "What is on chain today" below has the transactions.

The workflow lives in `packages/workflow/moolam-verifier/`. A second workflow,
`moolam-sealed-verifier`, re-checks sealed pictures from a private copy through a second receiver.
It has its own section at the end of this page.

## What runs, in order

### 1. Trigger

An EVM log trigger on the registry, filtered to topic 0 of `PassportRegistered`, on `monad-mainnet`
(chain id 143). The address comes from `config.json`.

### 2. Read

The workflow calls `getPassport(bytes32)` on the registry at the block the trigger log came from,
and takes the stored fingerprint and the metadata URI from there. The event is only the alarm
clock. A forged log carries no weight, because every value used is read back out of the registry.
If that read comes back empty it is tried twice more, two seconds apart, and only then does the run
fail. Each attempt is logged.

Why that block and not the finalized one: a log trigger fires at Chainlink's default confidence of
`SAFE`, which is ahead of the last finalized block, so a read pinned to finality can go looking for
a registration the finalized state does not hold yet. Reading at the log's own block also means
every node reads the same state whatever height its own RPC has reached, which is what the retries
are for: a node a block or two behind, not a chain that has changed its mind.

### 3. Fetch

Inside node mode, each node reads the passport's metadata document, either an `ipfs://` file
through the gateway or an inline `data:application/json,` document, then downloads the thumbnail it
names. Two HTTP requests per run, against a limit of five.

Only pinned content is fetched. The document and the picture must each be `ipfs://` followed by a
content id and nothing else, and the URL is always built on the configured gateway, so an http(s)
address a registrant wrote on chain ends the run before any request is made. Only a 200 is read:
the HTTP capability fails on a redirect by itself and any other status is refused, so no redirect
is followed. The document is refused over 32,000 bytes and the picture over 60,000, the verify
service's own ceiling for a thumbnail. The rule is one function, `pinnedContentId` in
`moolam-verifier/pinned.ts`, shared by both workflows and copied byte for byte into the re-check
runner.

### 4. Fingerprint

`decode.ts` decodes the JPEG with `jpeg-js`, pure JavaScript because the sandbox is QuickJS on
WebAssembly with no native modules. `phash.ts` recomputes the same 64-bit fingerprint the verifier
stores: grey through linear light, 32 by 32, 2D DCT, the 8 by 8 block next to the DC term, one bit
per coefficient above that block's average. The DCT runs in its separable form, once along each
axis, which is 65,536 multiplications instead of 1,048,576 for the same result.

`packages/verifier/test/workflow-phash.test.ts` holds the two fingerprints against each other on 24
generated images: identical on 11 of them, never more than 2 bits apart, against a match threshold
of 10. The same test proves the separable DCT gives the same 64 bits as the plain double sum it
replaced.

### 5. Consensus

The node function returns only `{ recomputed, distance, matched }`, and
`consensusIdenticalAggregation` requires a quorum of nodes to have produced the identical verdict.
The image bytes never go through consensus, so a CDN serving a slightly different re-encode to one
node is fine as long as every node lands on the same answer.

### 6. Write

The verdict is ABI encoded, signed into a report, and delivered through a Chainlink forwarder to a
receiver, which calls `attest` on the registry. On Chainlink's network the forwarder is the Keystone
Forwarder, `0x76c9cf548b4179F8901cda1f8623568b58215E62`, and the receiver is `MoolamReceiver`,
`0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04`. In a run in Chainlink's simulator the forwarder is the
simulator's `MockKeystoneForwarder` and the receiver is the public `SimulationReceiver`,
`0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95`; "The receiver, and what a simulation needs" below says
why that needs a receiver of its own.

```
(uint256 chainId, uint64 executedAt, bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed)
```

`chainId` and `executedAt` are inside the signed payload because Chainlink's own guidance says a
report can be replayed later or on another chain. The receiver rejects a wrong chain id and any
timestamp that is not newer than the last one it recorded for that passport.

## Configuration

`moolam-verifier/config.json`:

| Key | Value |
| --- | --- |
| `chain` | `monad-mainnet` |
| `registry` | `0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0` |
| `receiver` | `0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95` |
| `gateway` | `https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/` |
| `matchThreshold` | `10` |

The private key and the RPC URL come from the repository root `.env` (`CRE_ETH_PRIVATE_KEY`,
`MONAD_MAINNET_RPC_URL`). Nothing sensitive is written inside the package.

## Files

| File | What it holds |
| --- | --- |
| `moolam-verifier/workflow.ts` | The trigger, the read, the fetch, the consensus wrapper and the write |
| `moolam-verifier/pinned.ts` | The fetch rule both workflows share: `ipfs://<cid>` only, through the gateway, under a byte cap |
| `moolam-verifier/phash.ts` | The pure TypeScript fingerprint, matched to the verifier's |
| `moolam-verifier/decode.ts` | JPEG decoding inside the sandbox |
| `moolam-verifier/config.json` | Chain name, registry, receiver, IPFS gateway, match threshold |
| `spike/decode-spike.ts` | The throwaway run that proved a JPEG can be decoded in the sandbox at all |

## Simulating a run

Dry run, no transaction sent, against a real past registration:

```bash
cre workflow simulate moolam-verifier --target monad-mainnet --non-interactive \
  --trigger-index 0 --evm-tx-hash <tx that emitted PassportRegistered> --evm-event-index 0 \
  -e ../../.env
```

Add `--broadcast` to send the attestation for real. The transaction is paid for by the CRE wallet
`0xC79620AF233a4434b03f6B57239F8A9E71B3C178`.

### The receiver, and what a simulation needs

Chainlink's simulator does not deliver a report the way Chainlink's network does. A
`cre workflow simulate --broadcast` run sends it through Chainlink's `MockKeystoneForwarder` at
`0x9eF6468C5f37b976E57d52054c693269479A784d`, which checks no signature and builds the workflow
metadata (id, owner, name) from bytes the caller supplied. The id and owner the simulator stamps are
the same for everyone who runs this public workflow. A receiver that trusted the forwarder and the
metadata alone would trust anyone with the CLI.

Since 2026-09-26 simulated reports have their own receivers, one per workflow, both
`SimulationReceiver`, and both listed in the policy since 2026-09-27 14:18 UTC. Each workflow's
`config.json` sends its reports to its own:

| Workflow | Receiver | Listed in the policy |
| --- | --- | --- |
| `moolam-verifier` | [`0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95`](https://monadvision.com/address/0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95) | [`0xac642cc5…0bfb`](https://monadvision.com/tx/0xac642cc5c89290a2659e0ee7aaa78d7b729643f22138725815590dd2abbc0bfb), block 108,487,207 |
| `moolam-sealed-verifier` | [`0x52b8fE549B432920eeB061c26cAc5c2D527657f6`](https://monadvision.com/address/0x52b8fE549B432920eeB061c26cAc5c2D527657f6) | [`0x0e1e2937…457d`](https://monadvision.com/tx/0x0e1e2937ee4593cb8aad78d4bb6696b14584080b216d4c3c028f0c32eecf457d), block 108,487,216 |

Both listen to the mock forwarder, both carry the simulator's own stamps as their pins (author
`0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa`, workflow id `0x11..11` and the workflow's name), which
keep the other workflow out and nothing else, and both are bound to one sending wallet.

**The sending-wallet rule.** Each receiver holds `SENDING_WALLET`, the CRE wallet
`0xC79620AF233a4434b03f6B57239F8A9E71B3C178`, set in the constructor with no setter. The first check
in `_processReport` is `tx.origin == SENDING_WALLET`, and anything else reverts `WrongSendingWallet`
before a byte of the report is read. It reads `tx.origin`, the wallet that signed the transaction,
because the mock adds a hop: `msg.sender` at the receiver is always Chainlink's public mock
contract, and the metadata is whatever the caller typed. The signing wallet is the one value on
that path an outsider cannot produce, so a copy of this workflow run from someone else's machine
cannot write a verdict. The CRE wallet signs nothing but reports, because a contract it called could
reach the receiver inside the same transaction and borrow that authority.

**The mock never reverts.** When a receiver refuses a report, the mock catches the refusal: the
transaction succeeds with status 1 and its `ReportProcessed` event carries `false`. A report
transaction's status therefore says nothing about whether a verdict landed. Success is judged by the
registry's `VerificationAttested` log for that passport in the same receipt. The re-check runner
checks for that log before it tells the queue a run is done, and the website shows a finished
request as done only when the registry holds a re-check written at or after the request.

**The one hour bound.** A report's `executedAt` must be newer than the last one the receiver
accepted for that passport, and at most one hour past the block's time (`MAX_FUTURE_SKEW`, 3,600
seconds). Without the upper bound, one report stamped far in the future would set a floor the honest
workflow could never pass again. With it, the most any accepted report can do is hold a passport for
an hour.

**The kill switch.** Taking a receiver off `VerifierPolicy` takes effect at once, with no wait:

```bash
cast send 0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821 'removeReceiver(address)' <receiver>   --rpc-url "$MONAD_MAINNET_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
```

Only the policy's owner, the deployer wallet, can send it, and that key is never on the re-check
machine. The registry refuses the removed receiver as soon as that transaction lands. Listing one
again goes through the policy's public 24 hour queue.

**Where it stands.** Both were deployed on 2026-09-26 in blocks 108,102,667 and 108,102,676,
verified through Sourcify, and put in the policy's queue. The listing ran on 2026-09-27 at 14:18 UTC,
after the policy's public 24 hour wait, in the two transactions in the table above. The two
`MoolamReceiver` contracts came off the policy on 2026-09-26, in the deploy run, and every verdict
they wrote stays on chain under their addresses. The public one was listed again on 2026-10-02, as
the receiver for Chainlink's network (see "On Chainlink's network" below). Both workflow configs name
the new receivers for simulator runs. A receiver for Chainlink's network is a separate contract, which
is why `MoolamReceiver` is the one back on the list: a `SimulationReceiver` has no switch that turns
the sending-wallet rule off. The deploy record is
[simulation-receivers.txt](../../proofs/simulation-receivers.txt), and the addresses and
transactions are in `packages/contracts/deployments/simulation-receivers-monad-mainnet.json`.

**Before 2026-09-26.** The first two receivers, both `MoolamReceiver`, listened to Chainlink's
production forwarder and were pinned to the workflow author and name. A simulated report cannot pass
that pin, so every broadcast run took four steps from the deployer wallet: clear the pin, point the
receiver at the mock forwarder, run the simulation, then put the production forwarder
`0x76c9cf548b4179F8901cda1f8623568b58215E62` back and pin again. While a run was open, anyone with the
simulator could have driven the receiver. Every verdict written that way stays on chain under the old
receiver's address, and the passport page still names it.

A broadcast run on 2026-09-08 recomputed `0x233ccc7872442123` at distance 0 and wrote the report in
transaction `0x3a814ab20ac8c2e1c8d46c944c612722c6878a80cd823235afd2434de88796a0`. Reading the
registry afterwards showed `attestationCount` of 1 for that passport, with the receiver, `matched`
true and distance 0.

## On Chainlink's network

Since 2026-10-02 `moolam-verifier` also runs on Chainlink's network, where a quorum of nodes has to
agree before a report is signed. The deployment of 2026-10-02 held the verdict step only: the fetch, the
fingerprint, the consensus and the write. The look-alike step is in it from 2026-10-07.

| What | Value |
| --- | --- |
| Workflow | `moolam-verifier`, deployed to Chainlink's network: the verdict step on 2026-10-02, the look-alike step added on 2026-10-07 |
| Workflow ID | `0031b78176458a823e3930d4efe7d5b6a45807964dac463e9551b49e28e3fe21` since 2026-10-07; `00c4dd797775bb465fff638ab5171b19a35ed11d4513eb4890661935d4801890` before |
| Owner | `0xf072a8c620bfc818875736e3f2d3a2a339c06584` |
| Active from | about 07:09 UTC on 2026-10-02 |
| Writes through | the Keystone Forwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62`, to `MoolamReceiver` `0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04` |
| Listed in the policy | 2026-10-02 at 07:08:18 UTC, block 109,830,535, transaction [`0x446c3051…ff9f`](https://monadvision.com/tx/0x446c3051322060339d8e95bcc2938ca6db6692e8d583d360ebab6e626ea1ff9f) |
| Counted as the network's from | 1790924898, which is 07:08:18 UTC. The index and the workflow both count network writes from that second |

The first verdict from the network:

| What | Value |
| --- | --- |
| Passport | `0x793a540e287cbdfc6cb680c42b553641fa504afebcce6fd5f035e5e600f15782` |
| Registered | 07:23:26 UTC, transaction [`0x162c97a7…feaa`](https://monadvision.com/tx/0x162c97a70e53441e16633250e1cf96d695b01939d10625bf29248a9c01e3feaa) |
| Checked by | ten Chainlink nodes, each recomputing the fingerprint |
| Result | distance 0, matched |
| Verdict | transaction [`0x760dcb5e…2882`](https://monadvision.com/tx/0x760dcb5e1b83929201d8fe299ce9c3be2cf8981502117c5288386d7da3438882), block 109,833,597, 07:23:42 UTC |
| Delivered by | the Keystone Forwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62` |
| Time | 16 seconds from registration to the network's verdict |

To check it yourself, open the verdict transaction on MonadVision: its `to` is the Keystone
Forwarder, not the simulator's mock, and the passport page says the same under the verdict.

Live from 2026-10-07:

- The look-alike step in the network workflow.
- The verify service's look-alike routes and its Google web check on the hosted service.
- The hosted index rebuild that lets the live site's marks and counts see the network flag. Before
  that rebuild the live site's index could not tell network verdicts from test runs.

## What is on chain today

The seventeen re-checks on the seventeen real pictures, counted on 2026-09-25 at index block 107,960,831 (seven on 2026-09-14, seven on 2026-09-17, one on 2026-09-23, and two on 2026-09-25, one of them by the private workflow through its own receiver, described below), were all written this way: `cre workflow simulate
--broadcast`, the receiver pointed at the simulation forwarder `0x9eF6468C5f37b976E57d52054c693269479A784d`
for the run and put back on the production forwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62` after it,
by the four steps above. They are real transactions with real gas, and they prove the workflow code and
every check the receiver makes. They are not runs on Chainlink's network: the workflow ran on one
machine and no quorum of nodes agreed on the answer. The first network run came later, on 2026-10-02,
and is described in "On Chainlink's network" above.

Since 2026-09-27 the re-checks after those come from the re-check runner, still `cre workflow simulate
--broadcast`, through the two `SimulationReceiver` contracts and with no owner step at all. Its first two,
written with nobody pressing anything, are
[`0x37717b0c…abe24b`](https://monadvision.com/tx/0x37717b0c067afcc65bf79d036de55c2bcc1b22b08143b3ac28c3320bd3abe24b)
in block 108,499,297 and
[`0x35c1302e…4c1a`](https://monadvision.com/tx/0x35c1302e7d190ef0f02e21432b483d47ef803edc13cf5fe88d00c116f3574c1a)
in block 108,505,240, both matched.

The passport page does not take this on trust either. It reads the `to` address of each report transaction
and prints which forwarder delivered it, so a simulation run says so under the verdict and a network run
says so too, as the first one does. The transactions are listed in `proofs/rechecks.txt`.

## What this does not prove

- The gateway is a trust point, named out loud. The workflow asks the gateway for the bytes behind
  a content id. The content id is the hash of the content, so a gateway serving the wrong bytes
  would produce a fingerprint that disagrees with every honest node and consensus would fail, but
  the workflow does not verify the CID itself, and a gateway that is down means no attestation
  rather than a wrong one.
- Only JPEG thumbnails are decoded. A PNG or WebP thumbnail needs another decoder.
- The fingerprint catches re-encodes, resizes and metadata strips. It does not catch crops,
  rotations or mirrors, which sit 21 to 32 bits away, well past the threshold of 10. The verify
  service handles those with its eight variants; this workflow does not.
- A passport whose metadata names no image gets no attestation. The workflow refuses rather than
  guessing.

## Cost

One attestation is one Monad transaction from the CRE wallet: about 267,000 gas measured on the
receiver path in the contract tests, with `attest` itself at most 154,000 of that. The gas limit is
capped at 1,000,000 in `workflow.ts`. The workflow's own compute, one JPEG decode and a 32 by 32
DCT, took about 550 ms in the simulator when the DCT still summed over both axes, so that figure is
now an upper bound. Either way it is well inside the five minute execution budget, and the three
retry attempts on the registry read can add at most four seconds to it.

## Private re-checks: `moolam-sealed-verifier`

A sealed picture is never published, so the workflow above has nothing to download. A creator who
seals a picture can ask for a private re-check instead. The verify service then keeps one 512 pixel
copy on Pinata's private storage, where no public gateway serves it, and a second workflow opens it.
The second workflow uses Chainlink's Confidential Workflows: its handler is registered with
`handlerInTee(trigger, handler, {})`, which on Chainlink's network would run it inside an enclave so
that only the verdict leaves. Today it runs only in Chainlink's simulator, which says of itself
"The simulator is not a real TEE". So every private re-check on chain so far ran on one machine, with
no enclave and no network consensus.

The workflow lives in `packages/workflow/moolam-sealed-verifier/`. What it defends and how it was
attacked is in the [Threat model](../security/threat-model), section "The private re-check".

### What it reads and writes

1. **Trigger.** The same `PassportRegistered` log trigger as the public workflow.
2. **Read.** `getPassport` at the log's block, through `runtime.usingTheDons()`, with the same
   retries. Chain reads never run inside the enclave, and the only thing sent out is the passport
   id, which is public.
3. **Document.** The passport's public document, read through the configured gateway from an
   `ipfs://` address and nothing else. An http(s) address or a data URI ends the run with no report.
4. **The rule.** `privatelyRecheckable` in `private-copy.ts`: sealed, asks for the private re-check,
   names no picture. It is the verify service's rule byte for byte. False ends the run.
5. **The link.** The secret `SEALED_LINK_TOKEN` is read from the runtime and sent in one POST to the
   verify service's `/sealed/link` with the passport id. The link that comes back is opened only if
   it is `https://` on the configured private gateway host.
6. **The bytes.** One GET on the link. A status other than 200, an empty body, or a body over 60,000
   bytes is refused before the decoder sees it. Its errors name the passport and a status, never the
   link or the token.
7. **Fingerprint.** The public workflow's `decode.ts` and `phash.ts`, imported rather than copied.
   Ten bits or fewer from the stored fingerprint is a match.
8. **Write.** One report over the same six fields, through `usingTheDons()`, to the sealed
   `SimulationReceiver`, with a gas limit of 1,000,000.

On chain it writes nothing else: the same six fields the public workflow writes, and no part of the
picture.

### The second receiver

The receiver `moolam-sealed-verifier` sends to now:

| What | Value |
| --- | --- |
| Address | [`0x52b8fE549B432920eeB061c26cAc5c2D527657f6`](https://monadvision.com/address/0x52b8fE549B432920eeB061c26cAc5c2D527657f6) |
| Deployed | block 108,102,676, the same `SimulationReceiver` code as the public one |
| Forwarder | Chainlink's `MockKeystoneForwarder` `0x9eF6468C5f37b976E57d52054c693269479A784d` |
| Sending wallet | the CRE wallet `0xC79620AF233a4434b03f6B57239F8A9E71B3C178`, fixed in the constructor with no setter |
| Pinned author and workflow id | the simulator's own stamps, `0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa` and `0x11..11` |
| Pinned workflow name | `moolam-sealed-verifier`, stored as `0x64323036636163326334`, which is how Chainlink's template keeps a name: the first ten hex characters of its SHA-256, as text |
| Listed by the policy | on 2026-09-27 at 14:18 UTC, after the policy's public 24 hour wait, transaction [`0x0e1e2937...`](https://monadvision.com/tx/0x0e1e2937ee4593cb8aad78d4bb6696b14584080b216d4c3c028f0c32eecf457d), block 108,487,216 |

Before it, private verdicts went through the older sealed `MoolamReceiver`
[`0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A`](https://monadvision.com/address/0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A)
(off the policy since 2026-09-26): deployed in block 107,265,126, pinned to Chainlink's production forwarder, the
CRE wallet as author and the same workflow name, listed on 2026-09-25 in transaction
[`0x79d34b81...`](https://monadvision.com/tx/0x79d34b81ce94d4a21b10277a70d656b4588360e232839e0e25a16edf91687380),
and taken off the policy on 2026-09-26. The first two private verdicts carry its address.

Why a second receiver rather than a second name on the first: the registry stores the receiver with
every attestation. With one receiver per workflow, the chain itself says which workflow wrote each
verdict, and neither receiver's pin has to be widened. The passport page reads that field to label a
private verdict. The deploy record is `packages/contracts/deployments/simulation-receivers-monad-mainnet.json`,
and the older receiver's is `packages/contracts/deployments/sealed-receiver-monad-mainnet.json`.

`moolam-sealed-verifier/config.json`:

| Key | Value |
| --- | --- |
| `receiver` | `0x52b8fE549B432920eeB061c26cAc5c2D527657f6` |
| `gateway` | `https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/` |
| `privateGatewayHost` | `lavender-personal-grasshopper-978.mypinata.cloud` |
| `verifierUrl` | `https://verifier-production-d76f.up.railway.app` |
| `secretId` | `SEALED_LINK_TOKEN` |
| `matchThreshold` | `10` |

The token's value is never in the package. `secrets.yaml` names `CRE_SEALED_LINK_TOKEN`, and the
simulator reads it from the env file it is handed.

### The three HTTP calls and their limits

| Call | Limits on the workflow's side | Limits on the other side |
| --- | --- | --- |
| GET the public document | `ipfs://` only, through the gateway; 10 seconds; at most 32,000 bytes; up to three tries | none beyond the gateway's own |
| POST `/sealed/link` | 10 seconds; one try; the answer must be a link on the private gateway host | the token, compared in constant time; a claim on this passport less than ten minutes old; five links per passport an hour; a daily ceiling for the whole service, 100 by default, where 0 turns links off; the link lives 120 seconds and the caller cannot change that |
| GET the private copy | 10 seconds; up to three tries of the same link; status 200 and 1 to 60,000 bytes | the link's own 120 second life |

That is three calls a run, and at most seven with every retry, against CRE's limit of 15. The
retries are there because Pinata's private gateway answered the first request on a fresh link in 6
to 12 seconds on 2026-09-25, past the 10 second limit per call, and every repeat in about one second.
A retry is made only when a call does not answer at all; a status the server sends back is never
retried into a different answer.

### How a run is driven today

Since 2026-09-26 nobody opens or closes a receiver around a run. Both `SimulationReceiver`
contracts listen to the simulation forwarder `0x9eF6468C5f37b976E57d52054c693269479A784d` all the
time and accept a report only in a transaction signed by the CRE wallet
`0xC79620AF233a4434b03f6B57239F8A9E71B3C178` ("The sending-wallet rule" above), so there is no
window to open and no owner transaction per run. The policy has listed both since 2026-09-27 14:18
UTC, and both workflow configs send their reports to them.

The re-check runner in `packages/recheck-runner` drives the runs, on a small Linux machine that
holds the CRE wallet's key and never the owner key. It is live, and passes every two minutes: its first verdict, for a picture drawn on 2026-09-27, landed through the public simulation receiver in [block 108,499,297](https://monadvision.com/tx/0x37717b0c067afcc65bf79d036de55c2bcc1b22b08143b3ac28c3320bd3abe24b) a few minutes after the picture was registered. For a
passport whose document asks for a private re-check, one run is four steps:

1. **Claim.** A queued passport is claimed with the runner's token (`POST /recheck/claim`); one the
   sweep found gets a request of its own first (`POST /recheck/request`). The verify service mints a
   link only under that claim.
2. **Check the copy.** `GET /sealed/status/<id>` is read just before the spend. Kept goes on;
   unknown means try again next pass with nothing spent.
3. **Simulate.**

   ```bash
   cre workflow simulate moolam-sealed-verifier --target monad-mainnet --non-interactive \
     --trigger-index 0 --evm-tx-hash <registration tx> --evm-event-index <n> -e <env file> --broadcast
   ```

   The env file carries `CRE_SEALED_LINK_TOKEN` beside the CRE wallet's key. The run is stopped
   after ten minutes, the same window the claim allows.
4. **Answer.** The run counts as done only when its receipt carries the registry's
   `VerificationAttested` log for that passport, and the claim goes back with `POST /recheck/done`
   whatever happens.

Every run is counted against the runner's caps before it spends: 40 reports a day, 5 a pass, and a
1.5 MON floor on the CRE wallet (`packages/recheck-runner/README.md`, "The guards"). If that machine or its key is ever in doubt, the owner sends "The kill switch" above
from the deployer wallet and both receivers stop at once; the runner itself stops with
`systemctl stop moolam-recheck-runner` on its machine.

The first two private re-checks, below, ran before this change, from a launch script on the
operator's machine that opened and closed the older sealed `MoolamReceiver` around each run.

### The first run

On 2026-09-25, for the sealed passport
`0x864c33c6806185d4dc7acd65f465fc4c3cb6b8faaa157c32880cbef9dd93fc09`, which has never been
published:

| What | Value |
| --- | --- |
| Private copy | 25,349 bytes, opened through one link minted under the queue claim |
| Recomputed | `0x2ac1e07e3e80c4e6` against the stored `0x2ac1e07e3ea0c4e6` |
| Verdict | distance 1, matched |
| Report | [`0xdc1834ea...`](https://monadvision.com/tx/0xdc1834ea3d801fd965433dfefe02a70e7f06889655dceb7934d4668f9b790bef), block 107,817,793, status 1 |
| Delivered by | the simulation forwarder: one machine, no network consensus, not a real enclave |
| Written by | the older sealed `MoolamReceiver` (off the policy since 2026-09-26), which the attestation names |

Afterwards the receiver read back on the production forwarder, pinned to the workflow author and
`moolam-sealed-verifier`. The records are in [sealed-passports.txt](../../proofs/sealed-passports.txt)
and [rechecks.txt](../../proofs/rechecks.txt), and attack pass 4 reads the row back from the chain in
[pass-4.txt](../../proofs/attacks/pass-4.txt), attack 8d.

The second run, the same afternoon, was on
[Kanchipuram Silk Loom at First Light](https://moolam.site/en/passport/0xe83680b22c24e491f91077162804b862a6b821ac74f49b9b2d21a04864c485e4), a picture agent 10249
drew and its creator registered sealed with the private re-check: the 35,599 byte private copy
recomputed to `0x85c0d272787e6e77`, the stored fingerprint exactly, distance 0, matched, report
[`0xa38fd971...`](https://monadvision.com/tx/0xa38fd971c8ac0303f4e787e45f1b2b3203ffc8a01c864ffa50843d8fbd72c954), block 107,834,613.

### What the private re-check does not prove

- **No enclave, no consensus.** The simulator is one machine and not a real TEE. A run proves the
  code's shape, that the confidential capability accepts it, and every check the receiver makes. It
  does not prove hardware isolation.
- **It has not run on Chainlink's network.** Only the public `moolam-verifier` has, since 2026-10-02,
  and only its verdict step. Deploying a confidential workflow needs access Moolam does not have.
- **The logic is public, only the data is private.** The workflow's code is in this repository. What
  an enclave would keep from its operator is the token, the link, the bytes and the values made from
  them.
- **The handler logs.** It logs the stored fingerprint, the size of the copy and the verdict, which
  the runner reads in simulation. A deployed confidential handler should log nothing, because a log
  leaves the enclave.
- **Who can see the copy.** Moolam's operator, Pinata as the storage provider and the machine
  running the simulator can all see the 512 pixel copy.
- **The open window is closed, the key is not.** Until 2026-09-26 the sealed receiver was pointed
  at the simulation forwarder for each run, and any simulator user could have driven it in that
  window. The sealed `SimulationReceiver` never opens: a report from any wallet but the CRE wallet
  reverts `WrongSendingWallet`. What is left is the key itself. Whoever holds the CRE wallet's key
  can write a verdict until the owner takes the receiver off the policy with "The kill switch"
  above, which takes effect at once.
