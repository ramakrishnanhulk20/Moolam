# Moolam verifier: the Chainlink CRE workflow

Chainlink's network is the second opinion on every Moolam passport. When a creator registers an
image on Monad, this workflow wakes up, downloads the picture the passport points at, recomputes
the perceptual fingerprint itself, and writes the result back on chain as an attestation. Nothing
in that chain of steps trusts Moolam's own servers: the nodes fetch the image and do the maths
themselves, and they have to agree with each other before anything is signed.

## What runs, in order

1. **Trigger.** An EVM log trigger on the registry `0xeBeeD7A422531789aa009a9c45CC10C84dF12119`,
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
   thumbnail it names. Two HTTP requests per run, against a limit of five.
4. **Fingerprint.** `decode.ts` decodes the JPEG with jpeg-js, pure JavaScript because the sandbox
   is QuickJS on WebAssembly with no native modules. `phash.ts` recomputes the same 64-bit
   fingerprint the verifier stores: grey through linear light, 32 by 32, 2D DCT, the 8 by 8 block
   next to the DC term, one bit per coefficient above that block's average. The DCT is run in its
   separable form, once along each axis, which is 65,536 multiplications instead of 1,048,576 for
   the same result. `packages/verifier/test/workflow-phash.test.ts` holds the two fingerprints
   against each other on 24 generated images: identical on 11 of them, never more than 2 bits
   apart, against a match threshold of 10. The same test proves the separable DCT gives the same
   64 bits as the plain double sum it replaced.
5. **Consensus.** The node function returns only `{ recomputed, distance, matched }`, and
   `consensusIdenticalAggregation` requires a quorum of nodes to have produced the identical
   verdict. The image bytes never go through consensus, so a CDN serving a slightly different
   re-encode to one node is fine as long as every node lands on the same answer.
6. **Write.** The verdict is ABI encoded as
   `(uint256 chainId, uint64 executedAt, bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed)`,
   signed into a report, and delivered by Chainlink's KeystoneForwarder to `MoolamReceiver`, which
   calls `attest` on the registry. `chainId` and `executedAt` are inside the signed payload because
   Chainlink's own guidance says a report can be replayed later or on another chain; the receiver
   rejects a wrong chain id and any timestamp that is not newer than the last one for that passport.

## Files

| File | What it holds |
| --- | --- |
| `moolam-verifier/workflow.ts` | The trigger, the read, the fetch, the consensus wrapper and the write |
| `moolam-verifier/phash.ts` | The pure TypeScript fingerprint, matched to sharp-phash |
| `moolam-verifier/decode.ts` | JPEG decoding inside the sandbox |
| `moolam-verifier/config.json` | Chain name, registry, receiver, IPFS gateway, match threshold |
| `spike/decode-spike.ts` | The throwaway run that proved a JPEG can be decoded in the sandbox at all |
| `../verifier/test/workflow-phash.test.ts` | Holds this fingerprint against the verifier's sharp based one |

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

### Before and after a broadcast: switch the receiver's forwarder

Simulation signs reports with a local mock forwarder, while the live network uses the production
one, and they are different addresses on Monad mainnet. `MoolamReceiver` only accepts calls from
the forwarder it is pointed at, so the owner has to move it for the duration of the run. Both
commands are sent by the deployer wallet, which owns the receiver.

```bash
# before the simulate --broadcast run: point the receiver at the simulation forwarder
cast send 0xcDf8698F8bdE1818E91f40cc011CB049833Ae0a4 "setForwarderAddress(address)" \
  0x9eF6468C5f37b976E57d52054c693269479A784d \
  --rpc-url $MONAD_MAINNET_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY

# after the run: put the production forwarder back
cast send 0xcDf8698F8bdE1818E91f40cc011CB049833Ae0a4 "setForwarderAddress(address)" \
  0x76c9cf548b4179F8901cda1f8623568b58215E62 \
  --rpc-url $MONAD_MAINNET_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY
```

Leaving the receiver on the simulation forwarder would let anyone holding that mock forwarder push
an attestation, so the second command is not optional. The registry's `VerifierPolicy` is the
second lock: it only accepts `attest` from receivers on its list, so even a forwarder mistake
cannot forge a passport record.

## What this does not prove

- The gateway is a trust point we name out loud. The workflow asks
  `https://gateway.pinata.cloud/ipfs/<cid>` for the bytes behind a content id. The content id is
  the hash of the content, so a gateway that serves the wrong bytes would produce a fingerprint
  that disagrees with every honest node and consensus would fail, but the workflow does not verify
  the CID itself, and a gateway that is down means no attestation rather than a wrong one.
- Only JPEG thumbnails are decoded. A PNG or WebP thumbnail needs another decoder.
- The fingerprint catches re-encodes, resizes and metadata strips. It does not catch crops,
  rotations or mirrors, which sit 21 to 32 bits away, well past the threshold of 10.
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
