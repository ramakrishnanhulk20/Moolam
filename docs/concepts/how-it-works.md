---
title: How it works
---

# How it works

One passport, from the moment the picture exists to the moment a stranger can trust it. Each step
names the piece of Moolam that does it.

## 1. Made

The generator agent draws the picture. It is a language model with four tools in
`packages/agents/src/agent/tools.ts`, and `generate_image` is the one that produces the file. The
image bytes stay on this side of the model: they never travel through the conversation, so the
agent cannot register a picture it only imagined.

The agent's wallet is a Privy server wallet. Its key lives in Privy's enclave under a policy that
allows one function, `register`, on one contract, the Moolam registry on chain 143, carrying no
MON. That is what stops a hijacked prompt from spending anything.

## 2. Sealed

`prepareImage` in `packages/verifier/src/prepare.ts` turns the raw picture into everything a
passport needs. It signs a C2PA manifest into the JPEG carrying a soft binding, fingerprints those
signed bytes, takes the sha256 of the manifest store, and builds a thumbnail. It refuses to
continue if the signing moved the perceptual hash, because a manifest describing different pixels
than the registered ones is worse than no manifest at all.

Four files are pinned to IPFS through Pinata before any transaction is sent: the signed image, the
thumbnail, a readable copy of the manifest, and the metadata JSON pointing at the other three. A
failed upload costs no gas.

Then the two signatures. `hashPassport(input)` on the registry returns the EIP-712 digest, and that
digest is also the WebAuthn challenge. The creator's passkey signs it on their own device. The
agent owner's wallet signs the same digest inside Privy's enclave. `register(input, creatorAuth,
generatorSig)` checks both on chain: the WebAuthn assertion through OpenZeppelin's `WebAuthn`
library against Monad's P-256 precompile at `0x0100`, and the agent signature by recovering it and
comparing against `ownerOf(agentId)` on the ERC-8004 Identity Registry. Only then is the record
written and the ERC-721 minted, with the image hash itself as the token id.

Anyone may send that transaction. Authority comes from the two signatures, not from `msg.sender`,
which is what lets a relayer pay a creator's gas.

A photograph a person took goes the same way with two differences. The creator signs in with Privy,
which gives them an embedded wallet, and binds a passkey to that wallet once. Their browser then
sends the file to `POST /prepare` on the verify service, which signs the manifest, fingerprints the
signed bytes and pins the four files, because a serverless function cannot take a 20 MB upload. The
passkey signs the digest on their device and the embedded wallet sends `register` itself, with the
gas sponsored through Privy where the app has sponsorship enabled. That passport is Captured rather
than Generated: no generator agent, and one signature instead of two.

## 2b. Stated

The creator says, at the same moment, whether AI may use the picture. The studio offers three plates
before anything is signed, and saying nothing is a valid answer that sends nothing.

The words go two places. `packages/verifier/src/consent.ts` turns them into the assertion the C2PA
builder adds under the label `cawg.training-mining` and into the `training` object the metadata
carries, both written before the passport exists, because a manifest is signed once and cannot be
added to afterwards. Then, once the registration is confirmed on chain, a second sponsored transaction writes
the same words to `MoolamConsent`, the register whose only authority is what the passport registry
answers to `ownerOf` inside that same call.

The chain half is there because the file half can be taken out. The assertion lives in the manifest,
and the manifest is the first thing a platform throws away when it recompresses a JPEG. The register
does not care: it was never in the file.

What it buys is a question a label cannot answer. A statement is appended with the block's
timestamp, never edited and never removed, so `consentAt(passportId, someSecond)` returns the entry
that was in force on any past day rather than today's answer with an old date on it. Nobody can
backdate one, because the order the entries are written in is the order they are found in, and a
write is refused unless its timestamp is strictly later than the one before it.

It is cheap enough to be worth changing your mind about. A first statement measures 117,337 gas, a
later one 91,036, and stating one policy across 32 pictures in a single call is 2,371,445, which is
74,107 a picture. At the 102 gwei Monad was quoting when that was measured, one statement is about
0.014 MON and the batch is about 0.0077 MON a picture. Moolam sponsors the fee, so it costs the
creator nothing, and reading what a passport allowed on any date is an `eth_call` that costs nobody
anything at all.

Fifteen real pictures carry a statement, counted on 2026-09-25 at index block 107,961,293: the thirteen
below and two written on 2026-09-25. Eleven were written on 2026-09-18 in three sponsored
transactions, and two more on 2026-09-20 by a person signing with a real passkey: one from the
control on a passport page, and one from the studio at the moment of making, where the statement
landed 23 blocks and seven seconds after the registration. The transaction hashes and the reads back
are in [consent-statements.txt](../../proofs/consent-statements.txt).

What the choices mean, and what a statement does not do, is in
[Say how AI may use a picture](../guides/ai-use-statements).

## 3. Shared

The file leaves. It gets posted, re-encoded, resized, screenshotted, run through two rounds of
social platform resizing, and stripped of metadata on the way. Nothing about Moolam depends on any
of that being polite.

## 4. Degraded

The C2PA hard binding is a hash of the exact bytes, so it breaks the first time a platform
recompresses the file. The soft binding does not. `embedManifest` in the verifier writes the
fingerprint into the manifest as a `c2pa.soft-binding` assertion under the algorithm name
`com.moolam.phash-blockhash.v1`. Strip the manifest entirely and the fingerprint still matches
against the on-chain registry, which is the case C2PA 2.1 section 18.9 describes when it says a
manifest held elsewhere can be reunited with its asset through a soft binding.

## 5. Verified

Two things verify, and they answer different questions.

The verify service answers "which passport is this copy". Post any image to `POST /verify` and it
fingerprints the file three ways, builds all eight rotated and mirrored variants, searches the
registered passports by Hamming distance, and reads any C2PA manifest still attached. It returns
the best passport, the bit distances and a confidence number.

The Chainlink CRE workflow answers "does the registered fingerprint still describe the file the
passport points at". A log trigger on `PassportRegistered` wakes it, it reads the passport back out
of the registry rather than trusting the event, each node downloads the thumbnail and recomputes
the 64-bit hash inside the sandbox. The verdict is signed into a report and delivered by
Chainlink's simulation forwarder to a `SimulationReceiver`, which takes it only in a transaction
Moolam's CRE wallet signed and then calls `attest` on the registry. That attestation is public and
permanent.

The workflow is written so that on Chainlink's network a quorum of nodes must produce the identical
verdict before a report is signed. Every re-check on chain today came from Chainlink's simulator
with `--broadcast`, which is one machine and no consensus, and the passport page labels each one by
the forwarder that delivered it.

## 6. Trusted

The Envio indexer turns every event into rows. Per generator it keeps `matchedCount`,
`mismatchedCount`, `disputesUpheld` and a `trustScore`, which is
`round(100 * (matched + 1) / (matched + mismatched + 2 * disputesUpheld + 2))`. The smoothing means
a brand new agent starts at a neutral 50 rather than a meaningless 100, and an upheld dispute counts
double against it.

The verifier also writes each outcome to the ERC-8004 Reputation Registry on Monad mainnet at
`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, as feedback about the agent that generated the image.
That registry refuses feedback from the agent's own owner, which is what makes the record worth
reading, so the verifier signs with its own wallet.

Anyone who disagrees with a record can post a bond and call `flag`. The dispute resolver named by
`VerifierPolicy` settles it. An upheld challenge marks the passport disputed forever and returns
the bond; a rejected one sends the bond to the treasury.
