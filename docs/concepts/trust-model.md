---
title: Trust model
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
6. Every statement about AI use was written by the address the registry said held that passport at
   that moment, and carries the block timestamp it was written at.

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
signatures that matter. [Rules and standards](rules-and-standards) sets this beside what the C2PA
specification and the EU texts actually ask for.

## Statements about AI use

A statement in `MoolamConsent` is evidence of one narrow thing: that the address the registry said
held this passport at that second wrote these words. The contract reads `ownerOf` inside the same
call and compares it with `msg.sender`, so an ERC-721 approval, an operator, or a passport nobody
minted are all refused. Every entry is appended with the block's timestamp and never edited, so the
history is what was said and when, and `consentAt` answers for any past day.

What it is not evidence of:

**It does not prove the holder owns the copyright.** It records what the passport's holder stated.
Moolam does not check who owns the rights to a picture, and a passport proves who registered first
rather than who created, which the section above states narrowly.

**It does not bind anyone.** Nothing in the contract can stop a crawler that never reads it. The
claim is smaller and more useful: a company that trains on a picture whose holder wrote "not for AI
training" on a public chain, with a date, cannot say it did not know.

**It is only as fine as the chain's clock.** The timestamp is the block's, so a time query answers
to the second the block was sealed and no finer.

**A transfer carries the right to change it.** The statement stands until the new holder changes it,
and the history names who wrote each one, so a reader can tell a statement made by the person who
held it then from one made by the person who holds it now.

**Read it beside the dispute status.** A statement on a passport whose record is under challenge
should not be relied on: the registry's design says that record is in question, and the holder's
word about AI use rests on that record. The consent register knows nothing about disputes, which is
deliberate, so a reader takes the dispute status from the registry. The verify service returns both
facts together for exactly that reason, and it returns "could not find out" rather than a guess when
either read fails. Neither is permission.

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

`attest` is callable only by an address `VerifierPolicy.isReceiver` returns true for. Today that is
three receivers: the two `SimulationReceiver` contracts, listed since 2026-09-27, and the public
`MoolamReceiver` (0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04), which went back on the list on
2026-10-02 at 07:08:18 UTC in
[transaction 0x446c3051…ff9f](https://monadvision.com/tx/0x446c3051322060339d8e95bcc2938ca6db6692e8d583d360ebab6e626ea1ff9f),
block 109,830,535. Its sealed twin, 0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A, has been off the list
since 2026-09-26. A passport holds at most 64 attestations. Attestations stay open while the registry
is paused, so a verification already in flight can still land.

An attestation is a signal, not a verdict. It says a Chainlink CRE workflow downloaded the file the
passport points at and got a fingerprint this far from the recorded one. It sits next to the
signatures rather than above them. Every attestation written before 2026-10-02 came from a simulation
run of that workflow, one machine and no node consensus, and the passport page labels each one a test
run. Since 2026-10-02 07:09 UTC Chainlink's network runs the verdict step too, and its first verdict
is on chain: ten nodes recomputed the fingerprint, distance 0, matched, written in
[transaction 0x760dcb5e…2882](https://monadvision.com/tx/0x760dcb5e1b83929201d8fe299ce9c3be2cf8981502117c5288386d7da3438882)
at 07:23:42 UTC, 16 seconds after the passport was registered. Only a verdict from Chainlink's
network, where a quorum of nodes has to agree, can turn on a passport's trust mark: one written by
`MoolamReceiver` in a transaction sent to Chainlink's forwarder. The live site's index cannot tell
those from test runs until its rebuild on push day, 2026-10-12. What each mark means, and what
lights it, is in [The trust mark](trust-mark).

## Disputes and bonds

Anyone can challenge a passport by calling `flag(passportId, evidenceURI)` with exactly the bond
`VerifierPolicy.disputeBond()` names. The bond is held by the registry, and only the keccak256 hash
of the evidence URI is stored, so the URI cannot be swapped for something else later.

The resolver named by the policy settles it. Upheld marks the passport disputed and credits the
bond back to the challenger, and the passport's trust mark becomes "Challenge upheld" for good.
Rejected credits the bond to the policy's treasury, which since 2026-10-02 is the burn address
0x000000000000000000000000000000000000dEaD
([transaction 0x45700954…371d](https://monadvision.com/tx/0x457009544b51c256c130534b76cd7c3052e3f8299984b54d78037d21fb5d371d),
block 109,834,440, 07:27 UTC). Rejected bonds are burned: nobody holds a key for that address, so
nobody can ever withdraw a rejected bond and Moolam gains nothing from a rejection. How the mark reads
during and after a challenge is in [The trust mark](trust-mark). A passport whose challenge
was upheld cannot be flagged again, because the record already says disputed and a second bond
would be burned for nothing. One whose challenge was rejected can be flagged again with new
evidence.

Money is pulled, never pushed. `withdraw` and `withdrawTo` zero the caller's credit before sending,
both are behind a reentrancy guard, and both keep working while the registry is paused so a pause
can never trap someone's money. `rescueNative` computes its amount as the balance minus
`totalBonds` minus `totalOwed`, so the owner cannot sweep an open bond or an unclaimed credit.

## Who can change what

`MoolamRegistry` is immutable. `MoolamConsent` is immutable and has no owner at all: no pause, no
upgrade, nobody to impersonate. `VerifierPolicy` is the only moving part: the receiver list, the
dispute resolver, the treasury and the bond size. Every change that widens trust is queued and
executes 24 hours later in the open. Removing a receiver is the one exception and is immediate,
because a compromised verifier has to stop writing in the same block someone notices.
