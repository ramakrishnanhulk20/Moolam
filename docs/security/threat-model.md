---
title: Threat model
---

# Moolam threat model

Every claim below has been attacked. The Proof column says what happened and
names the file the output is saved in: an attack sent against the live contracts
on Monad mainnet where that is possible, and a Foundry test where mainnet cannot
reach the code path. `npm run prove` runs the whole set again. Weaknesses we did
not fix are listed last, on purpose.

## What Moolam promises

1. A passport, once registered, cannot be altered or removed by anyone.
2. A passport carries a creator signature made by a passkey the creator bound,
   and, for generated images, a signature by the generator agent that the
   ERC-8004 registry says owns that agent id.
3. An edit can only be appended by the current owner of the parent passport.
   ERC-721 approvals and operators are refused; a marketplace listing grants no authoring power.
4. Only receivers listed by the policy can attest, and the list changes only
   through a public 24-hour delay.
5. Any copy of the image that survives as a picture (re-encoded, resized,
   re-uploaded, rotated, mirrored, metadata stripped) resolves to its passport.
6. Nobody can take money out of the registry except the person it is owed to.
7. A statement about how AI may use a picture is written only by the address the registry says
   holds that passport, is never edited or removed, and answers truthfully for any past day.

## Who attacks, and what they want

| Attacker | Wants |
|---|---|
| Impostor creator | To register someone else's image as their own, or to attach their name to a popular image |
| Rogue generator | To claim an image was made by a reputable agent, or to hide that it was AI-generated |
| Compromised editing app | To use a session signer beyond the edit permission, or after revocation |
| Fake verifier | To attest false matches, or to spam attestations |
| Griefer | To flood disputes, oversized uploads, or the paid API |
| Platform | To break provenance by re-encoding, cropping or stripping metadata |
| Model trainer | To make an earlier "not for AI training" disappear, or look later than it was, so a picture reads as free on the day it was taken |
| Statement griefer | To speak for a passport they do not hold, poison a reader's parser through the conditions text, or turn sponsored writes into Moolam's bill |
| Us | A judge must be able to check that the operators cannot rewrite records |

## Entry points and what stops each attack

| Entry point | Attack | What stops it | Proof |
|---|---|---|---|
| `register` | Replay a valid registration on another contract or chain | EIP-712 domain includes chain id and contract address | refused, `MoolamRegistry.t.sol` test_theSameInputOnAnotherContractCannotBeReplayed |
| `register` | Reuse the same signatures for a second passport | exactHash is the id; duplicates revert | refused on mainnet, PassportAlreadyExists, section 4 of the `npm run prove` output |
| `register` | Forge the creator signature | WebAuthn assertion verified against the bound P-256 key; the digest is the challenge | refused on mainnet, InvalidPasskeySignature, `attacks/passkey-replay.txt` |
| `register` | Forge the generator signature | ECDSA recovery must equal `ownerOf(agentId)` on the ERC-8004 registry | refused on mainnet, InvalidGeneratorSignature, `attacks/generator-signature-forged.txt` |
| `register` | Point at a nonexistent agent | `ownerOf` reverts; wrapped and turned into UnknownAgent | refused on mainnet, UnknownAgent, `attacks/unknown-agent.txt` |
| `register` | Use a stale signature | deadline in the signed struct | refused on mainnet, SignatureExpired, `attacks/expired-deadline.txt` |
| `bindPasskey` | Bind a key the caller does not hold | the assertion signs the wallet, key and nonce | refused, `MoolamRegistry.t.sol` test_bindPasskeyRejectsASignatureOverTheWrongDigest and test_bindPasskeyNonceStopsAnOldAssertionBeingReplayed |
| `appendEdit` | Append an edit to someone else's passport | caller must own the parent; approvals and operators are refused | refused on mainnet, NotParentOwner, `attacks/edit-by-non-owner.txt` |
| `appendEdit` | Use a revoked session signer | Privy refuses the signature server-side; the chain sees no transaction. Proof shows the refusal | refused by Privy, no transaction, `attacks/revoked-session-signer.txt` |
| `attest` | Attest from a random address | policy.isReceiver check | refused on mainnet, NotReceiver, `attacks/attest-from-stranger.txt` |
| `attest` | Attest through the receiver from a fake forwarder | ReceiverTemplate checks msg.sender is the forwarder. The simulation receivers trust Chainlink's public mock forwarder, which anyone can call, so they also require the transaction to be signed by Moolam's CRE wallet (see "Simulator-fed receivers" below) | refused on mainnet, InvalidSender, `attacks/report-from-fake-forwarder.txt`; through the mock from any other wallet, WrongSendingWallet, `SimulationReceiver.t.sol` and `SimulationReceiver.fork.t.sol` |
| `attest` | Spam attestations | 64 per passport cap | refused at 64, `MoolamRegistry.t.sol` test_attestStopsAtTheCap |
| Receiver `onReport` | Replay a report whose first transmission reverted, or replay it on another chain | the report carries the chain id and a per-passport monotonic timestamp; the receiver rejects a repeat, an older one, or a foreign chain. The simulation receivers also refuse a timestamp more than an hour ahead of the block, and refuse every replay not signed by the CRE wallet before reading it | refused, StaleReport and WrongChain, `attacks/receiver-replay-and-wrong-chain.txt`, proved by `MoolamReceiver.t.sol` and `SimulationReceiver.t.sol`, because on mainnet only the forwarder (production receivers) or the CRE wallet (simulation receivers) can reach the check |
| `flag` / `resolve` | Take the bond without resolving | resolver-only, pull payments, balance invariant | refused on mainnet, InvalidBond and NotResolver, `attacks/dispute-money-rules.txt` |
| `withdraw` | Reentrancy | ReentrancyGuard and checks-effects-interactions | no reentrancy path found: testFuzz_withdrawNeverPaysTwice and invariant_balanceCoversEveryLiability; the live refusal with nothing owed is NothingToWithdraw in `attacks/dispute-money-rules.txt` |
| `rescueNative` | Owner drains bonds | rescue amount excludes totalBonds and totalOwed | refused, `MoolamRegistry.t.sol` test_rescueNativeCannotTouchBondsOrCredits |
| VerifierPolicy | Add a receiver instantly after bootstrap | 24-hour queue; only removal is instant | refused, `VerifierPolicy.t.sol` test_queueAddReceiverWaitsTheFullDelay and test_finalizeBootstrapClosesTheWindowForGood |
| Verifier API | Oversized or non-image upload | 20 MB cap, schema validation, 400 | refused live, 413 and 400, `attacks/verifier-api-limits.txt` |
| Verifier API | Request floods | 60 per minute per caller, read from the hop named in `TRUST_PROXY` rather than the socket, 429 | refused live, 429 on the 61st request, `attacks/verifier-api-limits.txt` |
| Image itself | Re-encode, resize, re-upload, strip metadata | perceptual fingerprints, which describe the picture rather than the bytes | matched on mainnet: six mangled copies at 0 to 2 bits of 64 and the stripped copy at 0, sections 2 and 3 of [prove-it.txt](../../proofs/prove-it.txt); 360 copies of 24 pictures, 0 false positives, in [robustness.txt](../../proofs/robustness.txt) |
| Image itself | Rotate or mirror | eight dihedral fingerprints at query time | matched on mainnet: the rotated and the mirrored copy at 0 bits of 64, section 2 of [prove-it.txt](../../proofs/prove-it.txt); rotate-90, rotate-180 and mirror 0% direct and 100% through the eight variants, in [robustness.txt](../../proofs/robustness.txt) |
| `setConsent` | Speak for a passport you do not hold | `ownerOf` is read from the registry inside the same call and compared with `msg.sender`; approvals and operators are refused, and a passport nobody minted is refused too | refused live, `NotPassportHolder`, `attacks/consent-from-stranger.txt` |
| `setConsent` | Say conditions apply without saying what they are | the text is required exactly when a use is `Constrained`, and refused otherwise | refused live, `ConstraintInfoRequired`, `attacks/consent-text-rules.txt` |
| `setConsent` | Poison a reader's parser through the conditions text | one predicate over every byte: printable ASCII, 0x20 to 0x7E, capped at 256 bytes | refused live, `ConstraintInfoNotPrintable` and `ConstraintInfoTooLong`, `attacks/consent-text-rules.txt` |
| `setConsentBatch` | Make one call walk an unbounded list | `MAX_BATCH` is 32, checked before any passport is looked at; an empty list is refused too | refused live, `BatchTooLarge` and `EmptyBatch`, `attacks/consent-batch-limits.txt` |
| `MoolamConsent` | Send it money, or find something to steal | no `receive`, no `fallback`, no payable function, no owner, no upgrade path | refused live, empty revert data, `attacks/consent-no-money.txt` |

## The consent register

`MoolamConsent` is where a passport's holder states whether their picture may be used to train AI.
It is read by AI companies and their crawlers, by indexers, and by anyone taking a commercial or
legal decision on what it says, so every value it stores is live input to somebody's parser. It
holds no money and has no owner. The full reference is in [MoolamConsent](../api/consent).

The write is authorised by a second contract's answer, so every ambiguity in "who holds it" applies
to it: a passport that does not exist, a passport transferred a moment ago, an ERC-721 approval, an
operator. The product's claim is "what was allowed on the day you took it", which makes the history
the asset: any path that edits, reorders or deletes an entry breaks it. And because Moolam sponsors
the fee on statements made through the app, a holder's writes are Moolam's bill.

Reentrancy, signature replay, upgrade and admin abuse do not apply here. The only external call is a
view on a fixed, immutable contract; there are no signatures, no owner, no proxy and no funds. They
stay not applicable only while that remains true, which the last invariant pins.

These eight are the definition of done, each with what proves it.

| Invariant | What proves it |
| --- | --- |
| **Holder only.** Consent changes only in a call whose sender equals what the registry's `ownerOf` returns during that same call. Approvals and operators are refused. A passport that does not exist can never be written | refused live, `NotPassportHolder`, `attacks/consent-from-stranger.txt`; `MoolamConsent.fork.t.sol` test_aStrangerCannotSpeakForARealPassport, test_anAddressApprovedOnTheRealRegistryIsStillRefused and test_aPassportTheRealRegistryHasNeverMintedIsRefused, all against live mainnet state |
| **Append only.** No function modifies or removes an existing entry, and for one passport the timestamps strictly increase | `MoolamConsent.invariants.t.sol` invariant_anEntryOnceWrittenNeverChanges, invariant_historyOnlyGrows and invariant_timestampsStrictlyIncrease, held over 256 runs and 8,192 calls with the single write and the batch competing for the same passports while they changed hands |
| **True time queries.** `consentAt(id, t)` returns exactly the last entry at or before `t`, and "not stated" before the first. `consentOf` returns the last entry | `MoolamConsent.fuzz.t.sol`, which checks both against a plain reference model over 512 runs rather than by examples, and invariant_theLatestEntryIsTheOneInForce |
| **Bounded writes per writer.** The same writer cannot change the same passport twice within `MIN_INTERVAL`, ten minutes. A different holder after a transfer is not made to wait, so a seller cannot lock a buyer out | `MoolamConsent.t.sol`, the `TooSoon` tests. Not in the live attacks, because proving it needs two writes ten minutes apart, which means two real transactions |
| **Bounded, inert text.** At most 256 bytes, every byte printable ASCII, required when a use is constrained and refused otherwise, stored exactly as validated. One predicate over the bytes, not a list of bad strings | refused live, `ConstraintInfoRequired`, `ConstraintInfoNotPrintable` and `ConstraintInfoTooLong`, `attacks/consent-text-rules.txt`; `ConstraintInfoNotAllowed` in `MoolamConsent.t.sol` |
| **One event per write, complete.** Every successful write emits exactly one `ConsentSet` carrying everything stored: passport, writer, index, the four uses, the text and the timestamp | `MoolamConsent.t.sol`, the event tests, and the batch tests that check one event per passport in the order given |
| **Reads never fail.** Every view answers for any id and any timestamp, unknown ids as "not stated", a page capped at 64 and an empty page past the end | read live against the deployed contract: an unknown id answers `false` with an empty entry, and `historyPage` past the end answers `[]`, both in [MoolamConsent](../api/consent) |
| **Nothing to steal, nobody in charge.** No owner, no upgrade path, no delegatecall, no selfdestruct, no payable function, no receive or fallback: a transfer of MON reverts | refused live, empty revert data, `attacks/consent-no-money.txt`; invariant_theContractHoldsNothing, driven by a handler that tries to pay the contract 1,652 times |

Eight refusals were executed against the live contract on 2026-09-21 and saved in
[consent-attacks.txt](../../proofs/consent-attacks.txt), with a valid statement from the real holder
as the control that passes. They are `cast call` simulations rather than transactions, which is how
the exact custom error is decoded, and they are reads only on purpose: writing the control would put
a real statement on a real passport and change what the demo shows.

### What the consent register deliberately does not do

- It does not prove the holder owns the copyright. It records what the passport's holder states.
- A transfer carries the right to change a statement. The old one stands until the new holder
  changes it, and the history shows who wrote what and when.
- It knows nothing about disputes. A disputed passport's statement must not be relied on, so a
  reader takes the dispute status from the registry, and the verify service returns both together.
- The clock is the block timestamp, so a time query is only as fine as the chain's clock.
- No gasless relay and no signatures: a write is a plain call from the holder's wallet.
- It cannot stop anyone from ignoring a statement. It makes ignoring it provable.
- The text rule bounds the bytes and judges nothing else. It does not know what the text says or
  where a link inside it points, so a reader that follows one still owes its own check. That is
  written into the contract's own comment so the next reader does not assume more.

## Sealed pictures

A creator can register a picture without publishing it. The passport id on Monad is the SHA-256 of
the exact file, so the chain commits to those bytes without showing them. Moolam pins one small JSON
document and no picture, no thumbnail and no manifest. The verify service signs the file, hands it
straight back to the creator's browser and keeps nothing, so the creator holds the only copy. Later
the holder may unseal: the service takes that file and publishes it only if its SHA-256 is the
passport id and its fingerprint is the one on chain. Unsealing publishes exactly the registered bytes
or nothing. The routes are described in [Verifier endpoints](../api/verifier-endpoints).

### What is public by design

Sealed hides the picture, not the passport. These are public from the moment of registration:

- the passport id, which is the file's hash
- the title the creator typed
- the two fingerprints: a 64-bit perceptual hash, and a 256-bit block hash that is a 16 by 16 sketch
  of light and dark squares and shows the rough layout of the picture
- the creator's wallet and the date
- the statement on how AI may use the picture, when the creator made one
- the fact that it is sealed
- for a picture the agent drew, the agent's id and the model's name. The prompt is left out

The sealed plate on the passport page is drawn from exactly those 256 bits. What a visitor sees there
is what anyone can already read from the chain, so nobody is surprised by it.

### What sealed promises

1. Moolam stores nothing of a sealed picture: no file pin, and no file left on disk.
2. Moolam publishes nothing of it: the one document it pins has no image, thumbnail, manifest or
   prompt in it.
3. The creator holds the signed file before the chain holds the passport. The studio will not open
   the passkey prompt until the browser has the file and its SHA-256 equals the passport id.
4. No answer on the sealed routes is cached, refusals included, and no log line carries the picture.
5. Only the wallet the registry names as holder, read at that moment, can unseal through Moolam.
6. Unsealing publishes exactly the registered bytes, or nothing.
7. Sealed is said in words wherever a passport shows, and never reads as broken, as re-checked or as
   public.
8. The creator sees what becomes public before signing.

Promises 3 and 8 are the studio's own screens before the passkey prompt. The attack pass below does
not cover them, and this page does not claim it does. For promise 7, the verify answer and the
passport page are attacked below; Explore and the share card were read from outside on 2026-09-22
and are recorded in [sealed-passports.txt](../../proofs/sealed-passports.txt).

### Entry points and what stops each attack

Attack pass 3 ran on 2026-09-23 in two halves, both saved in
[pass-3.txt](../../proofs/attacks/pass-3.txt). The route half runs the real routes, the real C2PA
signer and the real schema, with Pinata, Privy and the registry reads stubbed so every pin can be
counted. The live half sends single requests to the hosted service and the live site, and reads the
chain. It sends no transaction and spends nothing.

| Entry point | Attack | What stops it | Proof |
|---|---|---|---|
| Sealed `/prepare` and `/generate` | Get the service to store or publish the picture anyway: a file pin, a thumbnail, or a field smuggled into the body (`image`, `thumbnail`, `manifest`, `prompt`, `animation_url`, `external_url`) | The sealed path pins one JSON document and calls no file pin. What is pinned is the strict schema's own output, so an unknown field is dropped, and a body with more than five text parts is refused before it is read | 1a: one pin and 0 files on each route; 1b: all six fields dropped, and all six at once refused `too-many-fields` with 0 pins; 1d: 0 files left on disk with the C2PA signer on. Not covered: a write by the signer outside the watched folders. [pass-3.txt](../../proofs/attacks/pass-3.txt) |
| Caching and logs | Read the picture, or a refusal that repeats a title, out of a proxy, a browser store or the service log | One hook sets `Cache-Control: no-store` on every answer from these routes, whatever the status. No log line carries a body | 2a: 14 of 14 answers no-store across 200, 400, 401, 413 and 429 on the three routes; 279 log lines scanned and no slice of the picture in them. Not covered: a proxy that ignores no-store, and the host's own request log. [pass-3.txt](../../proofs/attacks/pass-3.txt) |
| `/unseal` | A stranger opens someone else's passport; the holder sends different bytes; the bytes hash right but the chain's fingerprint differs; a picture too detailed for the re-check's thumbnail budget is published | The token names a Privy user whose wallets must include `ownerOf`, read from the chain at that moment. The upload's SHA-256 must be the passport id and its fingerprint the chain's. A picture whose thumbnail cannot fit in 60,000 bytes is refused, because it would be a passport that can never be re-checked. A refusal pins nothing | 3a: 403 `not-holder`; 3b: 400 `hash-mismatch`; 3c: 400 `fingerprint-mismatch`, three ways; 3d: 422 `thumbnail-too-large`; 0 pins on each. 3e, the control: the holder with the right file gets exactly four pins. [pass-3.txt](../../proofs/attacks/pass-3.txt) |
| `/verify` and `/recheck/request` | Make a sealed passport read as public or broken to an API caller, send the Chainlink runner after a picture that was never published, or keep an unsealed one out of the queue | Every match in a verify answer carries `picture`: public, sealed, or unsealed with the time its holder published it. The re-check queue refuses a sealed passport and takes an unsealed one | 4a: `{"state":"sealed"}` on the file and on a re-encode, with no image or thumbnail address in either answer; 4b: 409 `sealed` and nothing queued; 4c: `{"state":"unsealed"}` with the record's time, and the re-check answered 200 pending. [pass-3.txt](../../proofs/attacks/pass-3.txt) |
| The live service, from outside | Unseal with no token, a malformed token, a token signed by a key made on the spot, and an `alg none` token; a sealed prepare with no token; find the picture in the live sealed document or the live passport page | Tokens are checked against Privy's key set, issuer, audience, algorithm and expiry. The live document passes the service's own strict schema | 5a to 5d and 5f: 401 and no-store, and 5e shows nothing was published by them; 5h: 9 keys, 0 links, commitment equals the passport id; 5i: no IPFS address on the page that the chain and the unseal record do not name. [pass-3.txt](../../proofs/attacks/pass-3.txt) |

The pass found two gaps and both were fixed the same day. The verify answer did not say a match was
sealed (4a), and the re-check queue refused the one unsealed passport as sealed because it read only
the sealed document (5g). After commit d07df6e the route half shows both fixed, and the live service,
running that build since 07:37 UTC, answered 200 pending for the same passport. The section "After
the fixes" at the end of [pass-3.txt](../../proofs/attacks/pass-3.txt) holds that run.

### The first unseal on mainnet

Passport `0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c`, "Old but strong", was
registered sealed from the live studio on 2026-09-22 at 12:23:50 UTC. Its holder published it at
12:27:28 UTC, four minutes later, through the unseal route with the file the studio had handed back.
The sealed document on chain is unchanged, because the registry cannot rewrite it. A record pinned
beside it says the picture is public since, and the passport page reads the two together (5e and
5i). On 2026-09-23 the Chainlink workflow re-checked it through that record: distance 2, matched,
report transaction
[0x48aa7543...](https://monadvision.com/tx/0x48aa75431f6f564ad8dd53806d7723ec397adca25ddb21f5e8e3eb0888f96ce0),
a simulation run on one machine like every re-check on chain today. The addresses are in
[sealed-passports.txt](../../proofs/sealed-passports.txt) and the row in
[rechecks.txt](../../proofs/rechecks.txt).

## The private re-check

A creator who seals a picture may also ask for a private Chainlink re-check. Moolam then keeps one
512 pixel copy of the picture on Pinata's private storage. Nobody can open it from the web; Moolam's
operator and the storage provider can. A Chainlink CRE confidential workflow, `moolam-sealed-verifier`,
whose handler is registered with `handlerInTee`, opens that copy through a read link the verify
service mints only while the re-check runner holds a claim on that passport. It recomputes the
fingerprint, compares it with the one on chain and writes only the verdict, through a second
receiver, so the registry's own record says which workflow wrote it. Today it runs in Chainlink's
simulator with `--broadcast`: one machine, no network consensus, and the simulator is not a real
enclave. The workflow is described in [Chainlink CRE workflow](../developers/chainlink-workflow) and
the routes in [Verifier endpoints](../api/verifier-endpoints).

"Nobody can open it from the web" rests on Pinata not serving a private file through any public
gateway. That is Pinata's promise, and no attack here can test it.

### What the private re-check promises

The ids are the ones attack pass 4 uses, so every promise can be followed into
[pass-4.txt](../../proofs/attacks/pass-4.txt). Where an attack cannot reach the code that keeps a
promise, the test that holds it is named instead.

| Promise | What holds it |
|---|---|
| **B1. The chain names the file.** The private file's name is built from the passport id the caller sent, after the registry says that passport exists, and the public document's commitment must name that same id. No field of any document chooses which file is listed, linked or deleted | 1e, 1f, 1g (the other passport's file is never even listed), 7a (the live commitment equals the id) |
| **B2. A private file is only the thumbnail of the bytes its name commits to.** Only the prepare route writes one, from the signed file whose SHA-256 is the passport id, after the duplicate check. If that check cannot reach the chain, no copy is made | 4b, 4e; `private-copy.test.ts` "B2: a second prepare of the same bytes uploads nothing once the chain holds the passport" |
| **B3. A lookup matches the whole name.** A name with anything added is not the file. A listing that fails is "cannot tell", never "none" | 1h, 1i, 2a, 3b, 3c |
| **B4. A link only for a passport that asked and still has its copy.** The chain holds the passport, its document asks for the private re-check and names no picture, and exactly one file carries its name. Anything else is a refusal with no link. The token is compared in constant time | 1a to 1i, and 6a to 6c on the live service |
| **B5. The link is a secret until it expires.** No answer, error or log line carries the link or the token | 1j (no link and no host in the refusal), 1m (the whole log scanned, 0 of 12 secrets); the workflow's own error lines: `sealed-private-copy.test.ts` "name the passport and never a URL, a host or the token" |
| **B6. The workflow opens only what the service named.** A link is opened only if it is `https://` on the configured private gateway, and a body over 60,000 bytes is refused before it is decoded. The public document is read only from an `ipfs://` address through the gateway | 1j on the service's side; the workflow's side: `sealed-private-copy.test.ts`, "the link host check", "the metadata address" and "the private file's size cap" |
| **B7. One rule says "privately re-checkable".** Sealed, asks for the private re-check, names no picture. The verify service, the runner and the workflow run the same rule, byte for byte | 1f, 2b, 4e; `sealed-private-copy.test.ts` "is the service's predicate byte for byte, in the workflow and in the runner" |
| **B8. The public document stays strict.** It gains one field, `privateRecheck`, and never the file's id, its content id or a link | 4e (0 of 6 leaks), 7a (the live document: 10 keys, 0 links) |
| **B9. Nothing is deleted on a doubt, and a delete takes everything under the name.** For a registered passport, only the wallet the registry names as holder, read at that moment, can have the copy deleted. The sweep deletes only when the chain answers that the passport was never registered | 3a, 3b, 3c, 5a to 5e |
| **B10. "Gone" is said only from a fresh listing.** The status has three answers, kept, gone and unknown, and unknown is never shown as either of the others | 2a, 2b, 6f, 6g |
| **B11. No spend without a file.** The queue takes a private re-check only while the copy reads kept, and the runner reads it again before it spends | 6f; `sealed-routes.test.ts` "B11: refuses a passport whose copy is gone"; the runner: `runner.test.ts` "treats a copy that is gone exactly as a plain sealed passport: refused, nothing spent" |
| **B12. A private verdict says what it is.** The passport page calls it a private re-check run in Chainlink's simulator, which is not a real enclave, and it reads that from the receiver that wrote the row | 8d shows the fact the page reads; the words: `private-recheck-card.test.ts` "wears the private re-check badge and says where the workflow really ran" |
| **B13. No receiver is opened for a run.** Once its listing runs on 2026-09-27, a private re-check writes through the sealed `SimulationReceiver`, which accepts a report only in a transaction signed by the CRE wallet, fixed when it was deployed with no setter, so there is nothing to open before a run and nothing to close after it. The older sealed receiver, which was opened and closed around each run, came off the policy on 2026-09-26 and keeps the verdicts it wrote | For the older receiver while it was listed: 8a, 8b, 8c. For the new one: `SimulationReceiver.t.sol` test_aReportFromAnyOtherOriginIsRefused and test_noFunctionChangesTheSendingWallet, and the live read-back of `SENDING_WALLET` in [simulation-receivers.txt](../../proofs/simulation-receivers.txt) |
| **B14. The private path makes the thumbnail the public path would.** A picture the public path refuses is refused here too, and the workflow's fingerprint of the copy lands within 10 bits of the chain's | 4d, 8d (the live run: distance 1); `private-copy.test.ts` "B14" |
| **B15. Everything is bounded.** A link lives 120 seconds and the caller cannot choose that. Five links per passport an hour, a daily ceiling for the whole service with 0 as the off switch, a 10 second timeout on every Pinata call, and at most 200 rows read by the sweep | 1k, 1l; the rest in `sealed-routes.test.ts`, `pinata.test.ts` and `sweep.test.ts` |
| **B16. The private copy is private or it does not exist.** If Pinata answers an upload with a public file it already held, the registration is refused and nothing is pinned | 4c, 4e |
| **D3. A link only under a claim less than ten minutes old, and only for the claimed passport** | 1c, 1d (9 minutes mints, 11 refuses), 1e, 6c (the real token alone opens nothing on mainnet) |
| **D5. The sweep waits 48 hours, counts before it deletes, and never runs at boot** | 5a, 5b, 5d; `sweep.test.ts` "D5: does not run at boot" |

### Entry points and what stops each attack

Attack pass 4 ran on 2026-09-25 in two halves, both saved in
[pass-4.txt](../../proofs/attacks/pass-4.txt). The route half runs the real routes, the real Pinata
client, the real queue and the real sweep, 28 attacks. Pinata is a recording stub whose listing
matches on prefix, which is looser than any real filter; Privy tokens are signed by a key the test
makes; the chain and the gateway are stubbed; the claim window and the sweep's clock are moved with
fake timers. The live half sends single requests and `eth_call`s to the hosted service, the gateway
and the sealed receiver at block 107,820,614. It sends no transaction and spends nothing, and before
it sent the real link token it asked the queue whether a runner held the passport. Neither half
reaches the runner's or the workflow's own code, which their own suites cover.

No attack got through where it should have been refused. One landed as designed: 5b, the sweep
deleting a 49 hour old copy whose passport the chain says was never registered.

| Entry point | Attack | What stops it | Proof |
|---|---|---|---|
| `/sealed/link` | No token, or a wrong token of the right length | The token is checked first, in constant time, before the chain or Pinata is asked | 1a and 1b: 401, 0 chain reads, 0 Pinata calls; live, 6a and 6b: 401 and no-store. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| `/sealed/link` | The real token without a claim, with a claim 11 minutes old, or while the claim is on another passport | A link is minted only for a passport the runner claimed less than ten minutes ago | 1c, 1d and 1e: 409 `not-claimed`, 0 Pinata calls; the same claim at 9 minutes minted, so the window is what refused; live, 6c: the real token alone answered 409 on mainnet. Not covered: the claimed passport itself, which a stolen token can read for up to ten minutes and five links. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| `/sealed/link` | Point at another passport's copy through a document whose commitment names it, or ask for a passport whose document never asked | The file name comes from the id the chain holds, the commitment must equal it, and the rule in B7 runs before Pinata is asked | 1g: 409 `commitment-mismatch`, the other passport's file never listed; 1f: 404 `nothing-kept` for a plain sealed document and for one that also names a picture. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| `/sealed/link` | A file whose name only starts right, or two files under the exact name | Our code compares the whole name, and more than one match is refused rather than guessed | 1h: 404 `gone` for `.jpg.old`; 1i: 409 `ambiguous`; no link asked of Pinata in either. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| `/sealed/link` | Pinata answering with a link on another host | The link is parsed and its host compared before it is returned; a refusal carries no link and no host | 1j: 502 `link-unavailable`; 1m: every log line from 1a to 1l scanned, 6 minted links and 0 of 12 secrets found in 12,748 characters. Not covered: the host's own request log. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| `/sealed/link` | Ask again and again | Five links per passport an hour, and a daily ceiling for the whole service | 1k: five answered 200 and the sixth 429 `link-cap`, each from a different address; 1l: 429 `global-limit` with the ceiling at 0. Not covered: a redeploy, which resets the hourly count. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| `/sealed/status` | Read "kept" or "gone" while Pinata is failing, or spend Pinata's rate limit through passports that never asked | Unknown is its own answer and is not remembered; a document that never asked is answered from the document alone | 2a: `unknown` twice, no-store, Pinata asked both times; 2b: `gone` with 0 Pinata calls, even with a stray file under the name. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| `/sealed/forget` | A stranger deletes the copy; the holder deletes on a failed lookup; a lookalike file is deleted with the real one | `ownerOf` read at that moment must be one of the caller's wallets; no delete without a definite listing; the whole name must match | 3a: 403 `not-holder`, the file still kept; 3b: 503 `lookup-unavailable`, 0 deletes; 3c: both files under the exact name deleted, the `.old` file untouched. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| `/prepare` with the private re-check | Ask without sealing; make a copy when the chain cannot be reached; get Pinata's public duplicate kept as the private copy; send a picture whose thumbnail is too large; find the private file in the public document | Private re-check needs sealed; no copy without the duplicate check; the upload's answer must say private; the thumbnail budget of 60,000 bytes; the strict schema | 4a: 400 `private-recheck-needs-sealed`; 4b: 503 `chain-unreachable`, 0 Pinata calls; 4c: 409 `private-copy-not-private`, no document pinned; 4d: 422 `thumbnail-too-large`; 4e: 0 of 6 leaks in the document or the answer. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| The sweep | Delete a copy whose passport is only late, delete on a chain read that failed, delete in the dry pass, delete a lookalike name | 48 hours before anything is deleted, one failed read stops the run, the dry pass only counts, the whole name must match | 5a: 47 hours, kept; 5b: 49 hours and never registered, deleted as designed; 5c: stopped, 0 deletes; 5d: counted 1, deleted 0; 5e: counted as an odd name, 0 deletes. Not covered: a creator who signs more than 48 hours after preparing. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| The live service, from outside | Take a link or delete a copy on mainnet without the right token; find the private copy in the live document | The same checks as above, on the hosted build | 6a to 6e: 401 or 409 and no-store; 6f: `kept` for the private passport; 6g: `gone` for a public one; 7a: the live document passes the service's own strict schema, 10 keys, 0 links, commitment equals the passport id. [pass-4.txt](../../proofs/attacks/pass-4.txt) |
| The receivers on chain | A stranger calls the sealed receiver with a false verdict and the pinned name and author; a stranger calls `attest` directly | Attack pass 4 ran against the old sealed receiver, which accepted only the production forwarder. That receiver and the old public one come off the policy list when the simulation receivers are deployed. A simulation receiver accepts a report only through Chainlink's mock forwarder and only in a transaction signed by the CRE wallet. The registry accepts only receivers the policy lists | 8a: reverted `InvalidSender`; 8b: forwarder, author and name read back pinned to Chainlink's production forwarder, the workflow author and `moolam-sealed-verifier`; 8c: reverted `NotReceiver`. [pass-4.txt](../../proofs/attacks/pass-4.txt). For the simulation receivers: real report calldata replayed through the real mock on a fork lands only from the CRE wallet, and an old receiver reverts `NotReceiver` once removed, `SimulationReceiver.fork.t.sol` |

### The first private re-check on mainnet

Passport `0x864c33c6806185d4dc7acd65f465fc4c3cb6b8faaa157c32880cbef9dd93fc09` was registered sealed
with the private re-check on 2026-09-23 and has never been published. On 2026-09-25 the workflow
opened its 25,349 byte private copy through one link minted under a queue claim, recomputed the
fingerprint and landed 1 bit of 64 from the chain's: matched. The report transaction is
[0xdc1834ea...](https://monadvision.com/tx/0xdc1834ea3d801fd965433dfefe02a70e7f06889655dceb7934d4668f9b790bef),
block 107,817,793, delivered by the simulation forwarder, and the attestation it wrote names the
sealed receiver
[`0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A`](https://monadvision.com/address/0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A)
(attack 8d reads it back). The receiver was put back on the production forwarder and pinned again
afterwards. The details are in [sealed-passports.txt](../../proofs/sealed-passports.txt). A second
private re-check the same afternoon, on [Kanchipuram Silk Loom at First Light](https://moolam.vercel.app/en/passport/0xe83680b22c24e491f91077162804b862a6b821ac74f49b9b2d21a04864c485e4),
matched at distance 0 ([0xa38fd971...](https://monadvision.com/tx/0xa38fd971c8ac0303f4e787e45f1b2b3203ffc8a01c864ffa50843d8fbd72c954), block 107,834,613).

## Simulator-fed receivers and the re-check runner

Every re-check runs in Chainlink's CRE simulator with `--broadcast`, and a small machine, the
re-check runner, starts one within minutes of each new picture. A simulated report reaches Monad
through Chainlink's MockKeystoneForwarder, which checks no signature. So the verdicts land through
two receivers built for that path, `SimulationReceiver` (one for the public workflow, one for the
sealed one). Each accepts a report only when the transaction was signed by Moolam's CRE wallet, fixed
when the contract was deployed. The two receivers that came before are removed from the policy in the
same run that deploys these, and every verdict they already wrote keeps their address.

### A) What kind of system this is

Three systems in one: a privileged on-chain writer gated by who is calling, fed by a forwarder that
verifies nothing; an unattended bot that fetches addresses strangers wrote and spends money; and a
host holding credentials that outrank every user.

- **Writer authentication.** The mock forwarder calls `onReport` with metadata built from bytes the
  caller supplied. The simulator's stamps (workflow id `0x11..11`, owner `0xaAaA..`, a public workflow
  name) can be reproduced by anyone who reads this repo, so on chain the only value a stranger cannot
  forge is the wallet that signed the transaction. Applies to every report.
- **Replay and floors.** A report's calldata is public. Each receiver keeps its own per-passport
  timestamp floor starting at zero, so a new receiver would accept every old report once, and the
  floor is set from a value inside the report. Applies to both new receivers.
- **Configuration drift.** The forwarder and the pins are owner setters on a hot wallet, and one
  transaction could reopen the door. Applies.
- **Fetching what strangers name.** The runner follows the document address written into a passport,
  from inside the machine, and the simulator does the same for the picture. Applies.
- **Spend griefing.** Anyone may register passports and anyone may ask for a re-check, and each costs
  the CRE wallet about 0.1 MON. Applies, bounded by the caps.
- **Credential blast radius.** One file holds the CRE key, the runner token and the sealed link
  token, and the machine holds the Chainlink login. Applies.
- **Not applicable:** rendering user content (the runner draws nothing), storage shared between users
  (nothing per user on the machine), shell injection (the CLI is started with an argument list and no
  shell).

### B) Threat model

**Trust boundaries.** Any wallet to the mock forwarder to `onReport`, the one unsigned crossing on
chain; the receiver to `attest`, trusted because the policy lists it; the owner wallet to the receiver
setters and the policy; a registrant's document to the runner's and the simulator's fetch; the Envio
index to the runner; the public request route to the queue to the runner's spend; the runner's result
to the verify service's public status; IPFS and Pinata to the simulator; the public RPC to the runner;
the machine's disk to everything.

**What an attacker controls.** The raw report and its 109 byte header, through the mock; the chain
id, `executedAt`, passport id, match, distance and fingerprint, for whoever runs the CLI with the key;
the document address and every document field, the picture bytes and any redirect behind them, for
any registrant; the queued passport ids, through the public route; index rows and RPC answers; the
runner's saved counts after a restart; the CLI's output text, which becomes a published reason.

**What the privileged position holds.** The CRE key writes any verdict on any passport through both
new receivers and holds the wallet's MON. The policy list is the only thing the registry trusts. The
owner key re-points, unpins and unlists. The Chainlink login is Moolam's account. The runner token
claims and closes any request, and with the sealed link token and a claim it reads a private copy.

**What an attacker wants.** A false verdict on a passport or an agent's record; a passport frozen by
an `executedAt` of 2^64-1; the machine's secrets, taken by SSH, a poisoned install or a fetch pivot,
then used quietly; the wallet burned by junk registrations or request spam; the machine made to fetch
an internal address or an enormous body.

### C) The standards, and where each is held

These are the definition of done. R1 to R6 are the contracts and their launch; R7 to R11 are the
runner's and the web's.

| Invariant | Held by | What proves it |
|---|---|---|
| **R1 Sender-bound writes.** No attestation reaches the registry through a simulation receiver unless the transaction's signing wallet is that receiver's sending wallet, whatever the forwarder, metadata or payload say | `SimulationReceiver._processReport`, its first check, `tx.origin == SENDING_WALLET` | `SimulationReceiver.t.sol` test_aReportFromAnyOtherOriginIsRefused; `SimulationReceiver.fuzz.t.sol` testFuzz_anyOriginOtherThanTheSendingWalletIsRefused, 512 runs over every origin and caller; `SimulationReceiver.fork.t.sol`, where real report calldata sent through the real mock lands from the CRE wallet and writes nothing from any other wallet, the deployer included |
| **R2 Never open.** No state exists in which a report is accepted on the forwarder or pins alone: the sending wallet is fixed at construction, never zero, with no setter | `SENDING_WALLET`, an immutable set in the constructor, which refuses zero | test_noFunctionChangesTheSendingWallet reads every selector the deployed code answers against a reviewed list, then runs every owner setter to its widest and ownership away, and a stranger is still refused; test_constructorRefusesZeroAddresses |
| **R3 Listed only when locked.** The policy lists a receiver only after its forwarder, pins and sending wallet are read back from the chain and match the plan, and the workflow configs and runner point at it only after it is listed | `DeploySimulationReceivers.s.sol` reads every field back and stops before the queue on any mismatch; `FinalizeSimulationReceivers.s.sol` reads them again before the execute; the launch scripts read them from the chain after each broadcast | the fork rehearsal of both launch scripts, every field read back from the fork and matched |
| **R4 Monotonic and bounded time.** `executedAt` must be above the floor and at most the block time plus one hour, so no report can set a floor the honest workflow cannot pass | `SimulationReceiver._processReport` and `MAX_FUTURE_SKEW` | test_executedAtAtTheLargestUint64IsRefused; the edge test (one hour accepted, one hour and a second refused); test_theFloorIsStrictlyMonotonic; two fuzz tests over the whole range and around the edge |
| **R5 Replay is sender-bound.** Replaying old calldata to a new receiver needs the sending wallet too, so floors that differ between receivers are an insider matter | R1 | the fork replay from another wallet writes nothing |
| **R6 Kill switch.** `removeReceiver` is immediate, its command is published, and the owner key is never on the re-check machine | `VerifierPolicy.removeReceiver`; the deploy removed the two old receivers; the command is in [Chainlink CRE workflow](../developers/chainlink-workflow), "The kill switch" | `SimulationReceiver.fork.t.sol` test_theOldReceiversAreRefusedByTheRegistryAfterRemoval; on mainnet, `isReceiver` reads false for both old receivers after the deploy ([simulation-receivers.txt](../../proofs/simulation-receivers.txt)) |
| **R7 Fetch only pinned content.** The runner and the simulator fetch a document or picture only as a bare IPFS id through the configured gateway, never an http(s) address, never following a redirect, never past a fixed byte cap, with one predicate shared by both workflows and the runner. The one exception is the private copy, which the sealed workflow opens only by a link the verify service minted, on the configured private gateway host (B6) | `pinnedContentId`, `pinnedFetchUrl` and `pinnedBodyRefusal` in `packages/workflow/moolam-verifier/pinned.ts`, used by both workflows; the runner's `readDocument` in `packages/recheck-runner/src/document.ts`, which carries a byte for byte copy of `pinnedContentId`, fetches with redirects refused and reads through `cappedText`. A document carried inline as a data URI is read with no request at all | runner `document.test.ts` "fetching only pinned content (R7)": http, https, link-local, loopback and path-smuggling addresses refused with no request made, a redirect not followed, a body stopped at the cap; `workflow-picture.test.ts` "the workflows fetch only pinned content (R7)", including "is one predicate: the runner's copy is the workflow's text byte for byte" |
| **R8 Shape before spawn.** Every value handed to the CLI matches its shape by the predicate the queue uses for ids: a transaction hash is 0x and 64 hex characters, an event index a small integer | `argvProblem` in `packages/recheck-runner/src/simulate.ts`, run by `runSimulation` before the CLI starts; `isPassportId` and `isTxHash` in `src/queue.ts` on every id and hash read from the queue or the index | runner `simulate.test.ts` "the shape of every value handed to the CLI (R8)": twelve malformed values, each refused without starting the CLI; `queue.test.ts` "drops a row whose id is not a passport id, by the queue's own predicate (R8)" |
| **R9 Bounded spend.** A daily cap, a per-pass cap and a balance floor are counted before the spend and cover queued requests too, so a stranger can cost at most the cap times one report's gas a day | `onePass` in `packages/recheck-runner/src/runner.ts`, which writes the spend down before the simulator starts; the ledger in `src/state.ts`, which reads a count it cannot trust as the cap used up | runner `runner.test.ts` "the guards", the five tests marked (R9); `state.test.ts` "reads a day's count that is not a whole number as the cap used up, never as room to spend (R9)" |
| **R10 One blast radius per secret.** The wallet holds a few days of reports, not the treasury; every token rotates without a contract change; a result never decides what a screen shows unless its report transaction is on chain from the sending wallet | Operations: the CRE wallet is not the deployer wallet, and the runner token and the sealed link token are env values on the runner and on Railway (`packages/recheck-runner/README.md`) that no contract holds. The runner: `attestationLanded` in `src/chain.ts` calls a run done only when the receipt holds the registry's `VerificationAttested` log for that passport. The web: `confirmOnChain` in `packages/web/lib/recheck/state.ts`, with `newestChainlinkRecheck` in `lib/recheck/chain.ts`, shows a request as done only when the registry holds a Chainlink receiver's re-check written at or after it. A simulation receiver accepts a report only from the sending wallet (R1), so a row it wrote is that wallet's | The CRE wallet read 27.756 MON at block 108,104,923 on 2026-09-26, about seven days at the runner's daily cap of 40 reports; runner `chain.test.ts` "whether a report's verdict landed" and `runner.test.ts` "a report the forwarder refused"; web `recheck-hook.test.ts` "done is the chain's word, not the queue's (R10)". Not covered by a test: rotating a token, which is a change of its env value in those two places |
| **R11 Outputs validated like inputs.** Every reason is redacted before it leaves the process; no log line carries an env value; an attestation from a receiver the web does not know is labelled unknown, never dropped and never given a named label; both sides of every address comparison go through one normaliser | The runner: `redact` and `scrubList` in `src/simulate.ts`, which `onePass` puts in front of every log line and every posted reason. The web: `receiverRole` and `addressKey` in `packages/web/lib/chain/receivers.ts`, the one list of named receivers and the one normaliser, read by the passport card, the facts strip, the first screen, Explore and the story | runner `runner.test.ts` "nothing from the env file leaves the process (R11)" and `simulate.test.ts` "never carries an endpoint address or a bearer value into the reason it hands on"; web `receiver-labels.test.ts`: the four named receivers in any letter case, an unknown writer shown with its numbers and never called Chainlink, and every Chainlink count taking the four and never the unknown one |

Four general rules hold across all of it:

- **One rule, not a list.** The sender check is one equality on the signing wallet. It covers every
  caller path and does not cover the key holder. The web's list of receiver addresses is labels only;
  the trust rule is the registry's `isReceiver` at the moment of writing.
- **Compare after the same parser.** The workflow name pins and the simulator's stamps are both the
  first ten hex characters of a sha256, and a mismatch reverts. Passport ids are lowercased by one
  function on both sides; addresses in the web are compared after one normaliser, `addressKey`.
- **Fail closed.** A parse error, a wrong shape, an unknown copy state, an unreadable record, a missing
  token, a timeout or a cap: no report, no claim used up where that can be avoided, nothing written.
- **What this does not defend against.** The holder of the CRE key or the owner key. A verdict is one
  machine's word, with no consensus behind it. Smart-account and relayed senders are excluded on
  purpose, since only a plain wallet can sign a transaction. The CRE wallet must sign nothing but
  reports, because a contract it called would inherit its authority. A stolen machine means forgery
  until `removeReceiver` runs. The mock forwarder is Chainlink's contract and may change. How exposed
  the fetches are depends on where the machine sits on its network.

One behaviour of the mock matters to anyone reading the chain: when a receiver refuses a report, the
mock does not revert. The transaction succeeds and its `ReportProcessed` event carries `false`, and
nothing is written to the registry. A report transaction's status alone does not say a verdict landed.

### The deploy, 2026-09-26

One scripted run from the deployer wallet, rehearsed first on a local fork of Monad mainnet, sent
twelve transactions, all status 1. The full record is
[simulation-receivers.txt](../../proofs/simulation-receivers.txt).

| What | Value |
|---|---|
| Public receiver | [`0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95`](https://monadvision.com/address/0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95), block 108,102,667, Sourcify match |
| Sealed receiver | [`0x52b8fE549B432920eeB061c26cAc5c2D527657f6`](https://monadvision.com/address/0x52b8fE549B432920eeB061c26cAc5c2D527657f6), block 108,102,676, Sourcify match |
| Read back from both | forwarder `0x9eF6468C5f37b976E57d52054c693269479A784d` (Chainlink's MockKeystoneForwarder), `SENDING_WALLET` `0xC79620AF233a4434b03f6B57239F8A9E71B3C178`, `MAX_FUTURE_SKEW` 3600, owner the deployer, and a report from any other wallet reverting `WrongSendingWallet` |
| Policy | both queued in `VerifierPolicy` `0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821`; the listing can run from 2026-09-27 06:03:51 UTC (`executeAfter` 1790489031) |
| Old receivers | `0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04` and `0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A` removed from the policy in the same run; every attestation they wrote stays on chain under their address |

Until the listing runs, none of Moolam's four receivers is listed, so no new re-check can be written through them. The workflow configs
and the runner switch to the new receivers only after it has run (R3).

## What the screens promise

Two rules for what the web app draws, added after the code review of 2026-09-26. Both hold for
every visitor, whatever a registrant wrote into their document.

| Invariant | Held by | What proves it |
| --- | --- | --- |
| **Pictures are pinned.** Every picture address a screen draws is accepted only as `ipfs://<cid>`, or as the same file named on Moolam's own gateway, and is resolved through Moolam's gateway. A document address is held to the same rule before it is fetched. Anything else gets the seal plate, so a passport registered straight on chain cannot send a visitor's browser to a host its registrant chose | `packages/web/components/passport/art.ts`, `pinnedUri`, called by `readArt` for the document and by `pictureUri` for the image and thumbnail. The film reads its own pictures through `pictureFor` in `components/story/data.ts`, which takes `ipfs://` only | `test/pinned-pictures.test.ts`: other hosts, plain http, a query string, a look-alike host, dot segments, `data:` and `javascript:` refused; an https picture drawn as the seal plate; a document off IPFS never fetched. The census of 2026-09-26 read all 41 passports: every picture is `ipfs://<cid>`, and the 3 documents stored as `data:` name none. Not covered: an unsealed picture's address comes from Moolam's own unseal record (`lib/data/unseal.ts`), which this rule does not check |
| **Status is read.** Every status word on a screen is bound to a read that succeeded in that render, and a failed read is said in words on the same screen | `packages/web/components/home/Board.tsx`: `Evidence` draws the live mark only when the record and the copy were both read, and `Loose` draws no mark and says the passport could not be read. The reads come from `firstScreenData` in `components/home/read.ts`, where every one is either a reading or the reason it failed | `test/first-screen-dead-rpc.test.ts`, with the app's chain client pointed at a port nothing answers on: the line shows, the mark does not, the reason is kept. `test/first-screen-home.test.ts` for a copy or a statement that could not be read. Not covered: the rule is tested on the home page's first screen only |

## Weaknesses we did not fix, stated plainly

- **First registered wins.** A passport proves who registered first, not who
  created. For AI output the two are the same moment, because the generator
  registers before publication. For a human photo it is a timestamped claim.
- **Crops.** A crop of more than a few percent breaks both fingerprints. We
  publish the measured number rather than pretend otherwise.
- **Adversarial perturbation.** Someone who knows the algorithms can craft an
  image that fingerprints close to another. We do not defend against that; the
  exact hash and the signatures still separate the two records.
- **The verifier's fetch.** The Chainlink workflow fetches a downscaled copy
  through an image proxy because of its 100 KB response cap. If the proxy lies,
  the attestation is wrong. The attestation is one signal next to the
  signatures, not the source of truth.
- **A stolen wallet can rebind the passkey.** Rotating a passkey needs the
  wallet plus an assertion from the new key, not the old one, so whoever
  controls the wallet controls the binding. We chose that so a lost passkey
  does not strand the account. Passports already registered keep their
  original signatures either way.
- **Tunnelled IPv6 forms.** The fetch guard normalises IPv4-mapped IPv6 and blocks every private, loopback, link-local and metadata range, pinning the socket to the address it checked. It does not decode the IPv4 embedded in 6to4, NAT64 or Teredo addresses, so on a host with one of those tunnels configured they remain a path inward. The verifier is deployed without such tunnels.
- **Software keys.** The seed, agent and proof scripts sign with a software passkey (a P-256 key held in
  process memory on the operator machine) so they can run unattended; a creator in the studio signs with the
  passkey in their own device authenticator, which never leaves it. The verifier posts reputation feedback
  from a plain key in its host environment, so a compromised host could post feedback in its name.
- **IPFS liveness.** If the pinned files disappear, the on-chain record still
  proves the hashes but the image is gone from our storage. Anyone holding a
  copy can re-verify it.
- **The digest the passkey signs comes from the RPC.** Today the browser asks the
  registry for the EIP-712 digest of the passport it is about to register and
  hands that answer straight to the passkey. A hostile RPC endpoint, or anyone
  sitting between the browser and it, could return a digest for different bytes,
  and the creator's device would sign something they never saw. The damage is
  bounded, because the signed struct still names the creator as the signer and
  the registry mints to that address, so an attacker gets a passport written in
  the creator's name rather than one written in their own. The fix in flight
  derives the digest locally in the browser from the same struct, which turns the
  RPC answer into a cross-check instead of the source of truth.
- **The passkey's rpId is a deployment constraint, not a contract rule.** A
  passkey is scoped to a registrable domain, and any page served under that
  domain can ask the authenticator for an assertion from the same key. So the app
  must never share a registrable domain with a page we do not control, including
  anything user-generated. On vercel.app the public suffix list gives us that for
  free: each subdomain is its own registrable domain, so no other deployment can
  reach our keys. On a custom domain the rule has to be kept by hand, which means
  every subdomain under it stays ours.
- **The orphan pin of a sealed prepare.** The sealed document is pinned before the creator signs,
  because its address is part of what they sign. A creator who walks away leaves that document on
  IPFS for good, holding the title, the fingerprints and the hash, with no passport behind it. Attack
  1e shows it, and nothing tidies it up yet.
- **A title is the creator's own public words.** The title is published as typed, sealed or not, up
  to 120 characters. Someone who pastes a picture into it publishes at most 72 bytes of one, which is
  no picture (attack 1c).
- **The sketch is public.** The block hash is a 16 by 16 light and dark sketch of the picture. It
  shows the rough layout and nothing finer, and the passport page draws it large so nobody is misled.
- **Front-running a sealed registration.** The registry is immutable and first registered wins, so
  someone who copies the hash out of a pending transaction and lands first holds the passport. That
  is as true of public pictures. For a sealed one the dispute path is weaker, because a challenge is
  judged only on what each side chooses to reveal.
- **The image model's provider has seen a generated picture.** It drew the picture. Sealed keeps it
  from the public, not from them.
- **The creator holds the only copy.** Moolam keeps nothing of a sealed picture, so a creator who
  loses the signed file can never unseal that passport. Any copy of the picture still matches it in
  Verify, because matching runs on the public fingerprints, not on the file.
- **The picture passes through the service's memory.** To fingerprint and sign it, the verify service
  holds the picture in memory for the length of one request, about 100 MB at the peak for a 20 MB
  file, and Node does not wipe freed memory. Nothing is written to disk (attack 1d).
- **The private copy is private from the web, not from us.** Moolam's operator and Pinata, the
  storage provider, can both open the 512 pixel copy a creator asked Moolam to keep. The studio says
  so beside the switch, before the creator signs.
- **One shared token plus a live claim reads a copy.** Whoever holds the link token while the runner
  holds a claim can read that one passport's copy. The ten minute claim window and five links an
  hour bound it (attacks 1c to 1e and 1k), but the hourly count is held in memory, so a redeploy
  resets it.
- **The simulator is not an enclave.** Every private re-check so far ran in Chainlink's simulator on
  one machine, which says of itself that it is not a real TEE. That machine sees the token, the link
  and the picture, and no quorum of nodes stands behind the verdict.
- **The simulation receivers trust one wallet.** Re-checks run in Chainlink's simulator, so their
  reports come through Chainlink's mock forwarder, which checks no signature. The two simulation
  receivers accept such a report only when Moolam's CRE wallet signed the transaction. Whoever holds
  that key, which lives on the re-check machine, can write any verdict until the owner removes the
  receivers from the policy, which takes effect at once. Before this change the old receivers were
  opened to the mock for each operator run, and anyone with the simulator could write during that
  window.
- **The first fetch through a fresh private link is slow.** Pinata's private gateway took 6 to 12
  seconds to answer the first request on a new link, past the workflow's 10 second limit per call,
  so the workflow tries the same link up to three times inside its 120 second life.
- **Self-audited.** No third party has audited these contracts. The attack
  scripts and their outputs are the evidence, and they are in this repo.
