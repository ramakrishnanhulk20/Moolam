---
title: How it works
sidebar_label: How it works
sidebar_position: 1
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

`prepareImage` in `packages/agents/src/media/prepare.ts` turns the raw picture into everything a
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
the 64-bit hash inside the sandbox, and a quorum has to produce the identical verdict. The verdict
is signed into a report, delivered by Chainlink's KeystoneForwarder to `MoolamReceiver`, which
calls `attest` on the registry. That attestation is public and permanent.

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
