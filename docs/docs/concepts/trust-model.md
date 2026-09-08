---
title: Trust model
sidebar_label: Trust model
sidebar_position: 3
---

# Trust model

What a Moolam passport actually proves, stated narrowly, and what it does not.

## What a passport proves

1. The record, once written, cannot be altered or removed by anyone. `MoolamRegistry` has no
   upgrade path. Records, edits and attestations are only ever added. The owner can pause new
   writes and rescue tokens sent by mistake, and cannot edit or delete a passport.
2. A specific passkey signed these exact bytes at this exact moment. The creator's WebAuthn
   assertion is verified on chain against the P-256 key they bound to their wallet, and the EIP-712
   digest it signs covers every field of the record.
3. For a Generated image, the wallet that owns a specific ERC-8004 agent id signed the same digest.
   `register` recovers the ECDSA signature and compares it against `ownerOf(agentId)` on Monad's
   canonical Identity Registry. An id nobody registered reverts `UnknownAgent`, and a signer who
   does not own the id reverts `InvalidGeneratorSignature`.
4. Every edit descends from a parent that exists, and was written by the wallet that held the
   parent at the time.
5. Every attestation came from an address the policy contract listed.

## What it does not prove

**It does not prove who made the picture.** A passport proves who registered first. For AI output
the two are the same moment, because the generator registers before publication. For a human photo
it is a timestamped claim and nothing stronger.

The prove-it run puts a number on this rather than arguing about it. An impostor tried to register
the same bytes again and the chain refused with `PassportAlreadyExists`. The impostor then
re-encoded the image and registered that as a fresh original, which the chain accepted, because
different bytes are a different image as far as a hash is concerned. A third copy handed to the
verify service returned both records, and the older one was the first creator's, registered 14
seconds earlier.

**It does not prove the person behind the key.** A passport says which key signed and when. It says
nothing about the identity of whoever is holding that key.

**It does not prove the C2PA manifest is trustworthy.** The development manifests are signed with a
throwaway certificate, so every reader marks them untrusted. The chain record carries the
signatures that matter.

## The creator passkey

`bindPasskey(qx, qy, auth)` attaches a P-256 key to the calling wallet. The wallet has to prove it
holds the key by signing the bind digest with it, so a stolen public key cannot be parked on
someone else's wallet. Each bind consumes a nonce, so an old bind assertion can never be replayed.

Rotating a key needs the wallet plus an assertion from the new key, not from the old one. Whoever
controls the wallet therefore controls the binding. That is a deliberate trade: a lost passkey does
not strand the account. Passports already registered keep their original signatures either way.

## The generator agent

An agent's identity is an ERC-8004 token, not a Moolam record. Moolam reads
`ownerOf(agentId)` and nothing else, so an agent's history is portable and Moolam cannot mint,
revoke or edit an identity.

`register` demands a generator signature exactly when `kind` is `Generated`, and refuses one when
it is not: a Captured passport with an agent id set reverts `InvalidAgentId`, and a Captured
passport carrying a signature reverts `InvalidGeneratorSignature`. On `appendEdit` the agent
signature is required only when `generatorAgentId` is non-zero, so a human edit needs no agent at
all.

## Edits

Only the current owner of the parent token may call `appendEdit`. An ERC-721 approval and an
operator approved for all are both refused. Approval is permission to move a token, granted to
marketplaces and escrows, and it must never become permission to write history under the owner's
name. A Privy session signer works because it signs from the owner's own wallet rather than as an
approved third party.

There is no passkey prompt on an edit. Holding the parent token is the authority, which is what
lets one editing session write ten edits.

## Attestations

`attest` is callable only by an address `VerifierPolicy.isReceiver` returns true for, which in
practice is `MoolamReceiver`. A passport holds at most 64 attestations. Attestations stay open
while the registry is paused, so a verification already in flight can still land.

An attestation is a signal, not a verdict. It says a quorum of Chainlink nodes downloaded the file
the passport points at and got a fingerprint this far from the recorded one. It sits next to the
signatures rather than above them.

## Disputes and bonds

Anyone can challenge a passport by calling `flag(passportId, evidenceURI)` with exactly the bond
`VerifierPolicy.disputeBond()` names. The bond is held by the registry, and only the keccak256 hash
of the evidence URI is stored, so the URI cannot be swapped for something else later.

The resolver named by the policy settles it. Upheld marks the passport disputed and credits the
bond back to the challenger. Rejected credits the bond to the treasury. A passport whose challenge
was upheld cannot be flagged again, because the record already says disputed and a second bond
would be burned for nothing. One whose challenge was rejected can be flagged again with new
evidence.

Money is pulled, never pushed. `withdraw` and `withdrawTo` zero the caller's credit before sending,
both are behind a reentrancy guard, and both keep working while the registry is paused so a pause
can never trap someone's money. `rescueNative` computes its amount as the balance minus
`totalBonds` minus `totalOwed`, so the owner cannot sweep an open bond or an unclaimed credit.

## Who can change what

`MoolamRegistry` is immutable. `VerifierPolicy` is the only moving part: the receiver list, the
dispute resolver, the treasury and the bond size. Every change that widens trust is queued and
executes 24 hours later in the open. Removing a receiver is the one exception and is immediate,
because a compromised verifier has to stop writing in the same block someone notices.
