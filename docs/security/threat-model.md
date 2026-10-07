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
| Verifier API | Oversized or non-image upload | 20 MB cap, schema validation, 400. Every upload to the verify and studio routes takes a share of one 200 MiB ceiling before its body is read, and the next one past it is answered 503 busy; a blockhash worker is replaced once its decoder threw or its files pass 64 MiB | refused live, 413 and 400, `attacks/verifier-api-limits.txt`; the ceiling in `upload-ceiling.test.ts` "answers 503 busy at once past the ceiling, before a byte of the body is read" |
| Verifier API and re-check runner | Read an RPC endpoint's access key, which is its path, out of a log line or an error answer | Error text is cut to origins before it is logged or answered: every web address in it is cut to its origin, every `URL:` or `Request body:` line is dropped, and a chain library error is told by its name and short message only. `safeReason` in `packages/verifier/src/net/errorText.ts`, and the runner's own copy in `packages/recheck-runner/src/errorText.ts`, behind its `redact` | `error-text.test.ts`: a real viem error for a keyed endpoint goes through the sweep's log line with the key gone, and failed on the old code with the key in it. Not covered: the host's own request log, and an address written with no `http` or `https` in front of it |
| Verifier API | Request floods | 60 per minute per caller, read from the hop named in `TRUST_PROXY` rather than the socket, 429. An IPv6 caller is counted by its /64, so a host cannot take a fresh count for every address it holds; an IPv4 address written inside IPv6 counts as the plain IPv4. One caller may hold 40 MiB of the 200 MiB upload ceiling, and a share shrinks to the bytes actually read. A body that stops arriving is closed after 30 seconds idle and gives its share back, and every request must arrive within 180 seconds. Fair turns at the decode gate: three decodes at once, verifies hold two at most so one is always left for the studio routes, and one caller holds one turn at a time while other callers go ahead | refused live, 429 on the 61st request, `attacks/verifier-api-limits.txt`; the 61st request from one IPv6 host spread across its /64 refused, `rate-limit-key.test.ts`; `fair-limits.test.ts` "answers busy to a key past two uploads' worth while another key is served", "closes an idle upload socket after the idle limit and gives its share back", "lets one key sending many verifies hold one slot while a second key is served" and "runs a /prepare with both verify slots busy, and a third verify waits"; `studio-ceiling.test.ts` for `/prepare`, `/edit` and `/unseal` under the ceiling. Not covered: a host holding more than a /64 gets one count per /64, and Railway's edge handling of slow bodies was not measured |
| Verifier API `/verify/paid` | Make an old payment pay for a new file: a settlement is remembered for ten minutes, and after that its transaction, named by a facilitator or found in the pay asset's logs, would prove a repeat of the same authorisation | A transaction counts only when its block is not before the block read when this payment was first settled, less `HOLD_LOOKBACK_BLOCKS`. A receipt that names no block is "cannot tell" and the answer is held as unknown. `landed` in `src/routes/verifyPaid.ts` | `paid-proof.test.ts` "WO-317: an old settlement cannot pay for a new file", which failed on the old code with a 200 for the new file. Not covered: a payment held while the newest block could not be read, which has no block to compare with and keeps the search from the authorisation's validAfter |
| Verifier API `/prepare` and `/edit` | Publish a camera's location or serial inside a registered file, which is pinned to public IPFS for good | The byte path keeps only the segments that decode the pixels and drops every other application segment, comment and trailer, the upload's own C2PA store included. A camera's own C2PA record is kept only as the redacted parent of Moolam's manifest, and only when the signed file, read back, validates by the rule the verify answer uses (a camera certificate that expired or is on no trust list is not a fault, any integrity failure is), names that one parent and holds none of the record's place or serial text; otherwise it is dropped. No read or signing fetches a remote manifest, and each read gives up after five seconds | `intake-bytes.test.ts` "drops the review's GPS block, APP12, comment, trailer and second image" and "never requests the remote manifest a file names in its XMP"; `camera-record.test.ts` "are in the upload, and never reach the signed file, public or sealed", which failed on the old code with the GPS and serial in the signed bytes. Not covered: the camera's own signing certificate, which stays in a kept record and can name the unit, and a place or serial stored under a key whose name says neither |
| Verifier API `/prepare` and `/edit` | Hide a camera's place or serial as a number, or as a list the reader shows as an empty string or as base64, inside an assertion the standard never lets anyone redact (the actions, the hard bindings, the ingredients), where the text check after signing cannot see it | A value that is not text under a place or serial key in such an assertion, and any text under one that the upload does not hold as written, makes the store unusable before anything is signed: the camera's record is dropped and the picture is signed plain, public and sealed. `cameraRecordOf` and `unseenByByteCheck` in `src/c2pa.ts` | `camera-record.test.ts` "WO-317: a place or serial written as a number where nothing can be redacted", which failed on the old code with the record kept. Not covered: a number under a key whose name says neither a place nor a serial, and data nested past 32 levels inside such an assertion |
| Verifier API `/prepare`, `/generate` and `/edit` | Sign with a certificate that is expired, not yet valid, or paired with the wrong key, so every picture carries a manifest readers call broken; or be handed back an unsigned picture when the signer is the fault | At boot, `ensureSigner` loads the identity through `loadSigner`: the leaf, the first certificate in the file, must be inside its validity window and the key must be the leaf's own, or the three routes are left off and `/health` names the reason under `off`. On every signing the worker's `signerFor` checks the window again, and the pair when the identity is first loaded, so a leaf that expires while the host runs turns each signing into `502 sign-failed` with the reason in the log, never an unsigned file. A file just signed must read back valid with no certificate note, or it is refused the same way. `credentialProblem` in `src/c2pa.ts` and `signerFor` in `src/signingWorker.ts` | `signing-credentials.test.ts`: an expired and a not yet valid leaf refused at boot with the three routes off and `/verify` on; a leaf that expires between two signings making the next one `SignerUnavailable` on public and sealed prepares; a mismatched key stopped at load; a freshly signed file whose signature does not validate refused, never embedded. Not covered: a trusted timestamp, which Moolam does not use, and a revoked certificate |
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
| **Bounded writes per writer.** A write is refused `TooSoon` when the newest entry for that passport was written by the same address less than `MIN_INTERVAL`, ten minutes, earlier. The check compares the caller with the writer of the newest entry only. So it bounds one wallet writing back to back while the passport stays in that wallet. It does not bound how often a passport's consent can change: a holder with a second wallet can pass the passport over and back and write again after each round, as often as once a second, for two transfers of about 85,000 gas each (the ten minute wait item under "What the consent register deliberately does not do"). Every write in that loop still comes from whoever holds the passport at that moment. A different holder after a transfer waits only for the clock to move, so a seller cannot lock a buyer out | `MoolamConsent.t.sol`, the `TooSoon` tests. The two transfer round was run on 2026-09-26 in a Foundry test against the unmodified contract, kept out of the suite: A writes, A again is refused `TooSoon`, A passes to B, B writes a second later, B passes back, and A writes at two seconds and is accepted. Not in the live attacks, because proving the wait needs two writes ten minutes apart, which means two real transactions |
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
- The ten minute wait compares the caller with the writer of the newest entry only, so the "Bounded writes per writer" row above holds only while the passport stays in one wallet. A holder with a second wallet can pass the passport over and back and write again at once, as often as once a second, and each round costs two transfers of about 85,000 gas each, about 0.017 MON for the pair at 102 gwei (estimated against mainnet on 2026-09-26). It never lets anyone write for a passport they do not hold: the holder is read from the registry inside the same call, so the wallet that just gave the passport away is refused `NotPassportHolder`.
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
| `/unseal` | A stranger opens someone else's passport; the holder sends different bytes; the bytes hash right but the chain's fingerprint differs; a picture too detailed for the re-check's thumbnail budget is published | The token names a Privy user whose wallets must include `ownerOf`, read from the chain at that moment. The upload's SHA-256 must be the passport id and its fingerprint the chain's. A picture whose thumbnail cannot fit in 60,000 bytes is refused, because it would be a passport that can never be re-checked. Since review pass 8 a sealed prepare or drawing is held to that same thumbnail and refused before anything is pinned, so this refusal is left for a passport sealed before then or registered outside Moolam. A refusal pins nothing | 3a: 403 `not-holder`; 3b: 400 `hash-mismatch`; 3c: 400 `fingerprint-mismatch`, three ways; 3d: 422 `thumbnail-too-large` on the unseal in pass 3, and since pass 8 on the sealed `/prepare` itself, pins 0 (`attacks-sealed.test.ts` 3d, `sealed-thumbnail.test.ts`), with the unseal's own refusal in `unseal.test.ts`; 0 pins on each. 3e, the control: the holder with the right file gets exactly four pins. [pass-3.txt](../../proofs/attacks/pass-3.txt) |
| `/verify` and `/recheck/request` | Make a sealed passport read as public or broken to an API caller, send the Chainlink runner after a picture that was never published, or keep an unsealed one out of the queue | The three matches a verify answer reads facts for carry `picture`: the exact match, the best match and the first registration, each public, sealed, or unsealed with the time its holder published it. The other near matches in `matches` carry no `picture`, `consent` or `dispute` at all, so none of them is ever printed as public (review pass 11, V120). The re-check queue refuses a sealed passport and takes an unsealed one | 4a: `{"state":"sealed"}` on the file and on a re-encode, with no image or thumbnail address in either answer; 4b: 409 `sealed` and nothing queued; 4c: `{"state":"unsealed"}` with the record's time, and the re-check answered 200 pending. [pass-3.txt](../../proofs/attacks/pass-3.txt) |
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
a simulation run on one machine like every re-check on chain then. The addresses are in
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
| **B2. A private file is only the thumbnail of the bytes its name commits to.** Only two routes write one, `/prepare` and `/generate`, each from the signed file whose SHA-256 is the passport id, after the duplicate check and before the document is pinned. If that check cannot reach the chain, no copy is made | 4b, 4e; `private-copy.test.ts` "B2: a second prepare of the same bytes uploads nothing once the chain holds the passport" and "B2 on /generate: uploads nothing when the chain holds the passport or cannot be reached" |
| **B3. A lookup matches the whole name.** A name with anything added is not the file. A listing that fails is "cannot tell", never "none" | 1h, 1i, 2a, 3b, 3c |
| **B4. A link only for a passport that asked and still has its copy.** The chain holds the passport, its document asks for the private re-check and names no picture, and exactly one file carries its name. Anything else is a refusal with no link. The token is compared in constant time | 1a to 1i, and 6a to 6c on the live service |
| **B5. The link is a secret until it expires.** No answer, error or log line carries the link or the token | 1j (no link and no host in the refusal), 1m (the whole log scanned, 0 of 12 secrets); the workflow's own error lines: `sealed-private-copy.test.ts` "name the passport and never a URL, a host or the token" |
| **B6. The workflow opens only what the service named.** A link is opened only if it is `https://` on the configured private gateway, and a body over 60,000 bytes is refused before it is decoded. The public document is read only from an `ipfs://` address through the gateway | 1j on the service's side; the workflow's side: `sealed-private-copy.test.ts`, "the link host check", "the metadata address" and "the private file's size cap" |
| **B7. One rule says "privately re-checkable".** Sealed, asks for the private re-check, names no picture. The verify service, the runner and the workflow run the same rule, byte for byte | 1f, 2b, 4e; `sealed-private-copy.test.ts` "is the service's predicate byte for byte, in the workflow and in the runner" |
| **B8. The public document stays strict.** It gains one field, `privateRecheck`, and never the file's id, its content id or a link | 4e (0 of 6 leaks), 7a (the live document: 10 keys, 0 links) |
| **B9. Nothing is deleted on a doubt, and a delete takes everything under the name.** For a registered passport, only the wallet the registry names as holder, read at that moment, can have the copy deleted, and the holder's delete goes by the name alone, whatever the document says. The sweep deletes only when the chain answers that the passport was never registered, or that it is registered under a document that does not ask for a private re-check of it; a document that cannot be read keeps the file | 3a, 3b, 3c, 5a to 5e; `sealed-routes.test.ts` "deletes the copy D1 left for the holder of a passport registered with D2, which does not ask"; `sweep.test.ts` "deletes the copy D1 left under a passport registered with D2, and keeps one whose document asks or cannot be read" |
| **B10. "Gone" is said only from a fresh listing, or straight after this service deleted every file under the name.** The status has three answers, kept, gone and unknown, and unknown is never shown as either of the others. After a delete that removed every file, gone is held for a minute even while Pinata's listing still shows the file; a delete that failed part way drops the memory | 2a, 2b, 6f, 6g; `sealed-routes.test.ts` "reads gone right after the delete, while Pinata's listing still shows the deleted file" |
| **B11. No spend without a file.** The queue takes a private re-check only while the copy reads kept, and the runner reads it again before it spends | 6f; `sealed-routes.test.ts` "B11: refuses a passport whose copy is gone"; the runner: `runner.test.ts` "treats a copy that is gone exactly as a plain sealed passport: refused, nothing spent" |
| **B12. A private verdict says what it is.** The passport page calls it a private re-check run in Chainlink's simulator, which is not a real enclave, and it reads that from the receiver that wrote the row | 8d shows the fact the page reads; the words: `private-recheck-card.test.ts` "wears the private re-check badge and says where the workflow really ran" |
| **B13. No receiver is opened for a run.** Since its listing on 2026-09-27 at 14:18 UTC ([`0x0e1e2937...`](https://monadvision.com/tx/0x0e1e2937ee4593cb8aad78d4bb6696b14584080b216d4c3c028f0c32eecf457d)), a private re-check writes through the sealed `SimulationReceiver`, which accepts a report only in a transaction signed by the CRE wallet, fixed when it was deployed with no setter, so there is nothing to open before a run and nothing to close after it. The older sealed receiver, which was opened and closed around each run, came off the policy on 2026-09-26 and keeps the verdicts it wrote | For the older receiver while it was listed: 8a, 8b, 8c. For the new one: `SimulationReceiver.t.sol` test_aReportFromAnyOtherOriginIsRefused and test_noFunctionChangesTheSendingWallet, and the live read-back of `SENDING_WALLET` in [simulation-receivers.txt](../../proofs/simulation-receivers.txt) |
| **B14. The private path makes the public thumbnail plus a comment naming the passport.** The copy is the thumbnail the public path would make, with one JPEG comment carrying the passport id, so no two passports' copies share a content id and the pixels are unchanged. A picture the public path refuses is refused here too, and so is one whose marked copy would pass 60,000 bytes. The workflow's fingerprint of the copy lands within 10 bits of the chain's | 4d, 8d (the live run: distance 1); `private-copy.test.ts` "B14" |
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
| The receivers on chain | A stranger calls the sealed receiver with a false verdict and the pinned name and author; a stranger calls `attest` directly | Attack pass 4 ran against the old sealed receiver, which accepted only the production forwarder. That receiver and the old public one came off the policy list on 2026-09-26, when the simulation receivers were deployed (the old public one has been listed again since 2026-10-02, for Chainlink's network), and the policy has listed the two simulation receivers since 2026-09-27 14:18 UTC. A simulation receiver accepts a report only through Chainlink's mock forwarder and only in a transaction signed by the CRE wallet. The registry accepts only receivers the policy lists | 8a: reverted `InvalidSender`; 8b: forwarder, author and name read back pinned to Chainlink's production forwarder, the workflow author and `moolam-sealed-verifier`; 8c: reverted `NotReceiver`. [pass-4.txt](../../proofs/attacks/pass-4.txt). For the simulation receivers: real report calldata replayed through the real mock on a fork lands only from the CRE wallet, and an old receiver reverts `NotReceiver` once removed, `SimulationReceiver.fork.t.sol` |

### The first private re-check on mainnet

Passport `0x864c33c6806185d4dc7acd65f465fc4c3cb6b8faaa157c32880cbef9dd93fc09` was registered sealed
with the private re-check on 2026-09-23 and has never been published. On 2026-09-25 the workflow
opened its 25,349 byte private copy through one link minted under a queue claim, recomputed the
fingerprint and landed 1 bit of 64 from the chain's: matched. The report transaction is
[0xdc1834ea...](https://monadvision.com/tx/0xdc1834ea3d801fd965433dfefe02a70e7f06889655dceb7934d4668f9b790bef),
block 107,817,793, delivered by the simulation forwarder, and the attestation it wrote names the
sealed receiver
[`0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A`](https://monadvision.com/address/0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A)
(off the policy since 2026-09-26; attack 8d reads it back). The receiver was put back on the production forwarder and pinned again
afterwards. The details are in [sealed-passports.txt](../../proofs/sealed-passports.txt). A second
private re-check the same afternoon, on [Kanchipuram Silk Loom at First Light](https://moolam.vercel.app/en/passport/0xe83680b22c24e491f91077162804b862a6b821ac74f49b9b2d21a04864c485e4),
matched at distance 0 ([0xa38fd971...](https://monadvision.com/tx/0xa38fd971c8ac0303f4e787e45f1b2b3203ffc8a01c864ffa50843d8fbd72c954), block 107,834,613).

## Simulator-fed receivers and the re-check runner

Every re-check the runner starts runs in Chainlink's CRE simulator with `--broadcast`, and a small
machine, the re-check runner, starts one within minutes of each new picture. A simulated report reaches Monad
through Chainlink's MockKeystoneForwarder, which checks no signature. So the verdicts land through
two receivers built for that path, `SimulationReceiver` (one for the public workflow, one for the
sealed one). Each accepts a report only when the transaction was signed by Moolam's CRE wallet, fixed
when the contract was deployed. The policy has listed both since 2026-09-27 14:18 UTC. The two
`MoolamReceiver` contracts that came before came off the policy on 2026-09-26, in the run that
deployed these, and every verdict they already wrote keeps their address. The public one has been
listed again since 2026-10-02 at 07:08:18 UTC, as the door for Chainlink's network (see "Look-alikes,
the trust mark and challenges" below). This section is about the simulator path only.

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

These are the definition of done. R1 to R6 are the contracts and their launch; R7 to R18 are the
runner's and the web's. R12 and R13 were added after the code review of 2026-09-28, and R14 to R18
after the one of 2026-09-29.

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
| **R12 One report per passport.** A run whose report may have landed is looked for on chain before it is called failed, and a new picture is run only after the registry itself says it holds no verdict, so neither a slow block nor an index that is behind can buy a second report. The web links a report transaction only after reading its receipt | The runner: `findLandedReport` in `src/chain.ts`, read up to four times, five seconds apart, from the chain head noted before the run, says "not found" only after every log in the window was read, and a window or a log count past its cap throws; a read that throws leaves the passport undecided, never done and never failed. `attestationCount` is read from the registry before a new picture is run, and a failed read makes it wait. The web: `confirmedReport` in `packages/web/lib/recheck/chain.ts` reads the transaction the queue names: status 1, sent by the CRE wallet, carrying the registry's `VerificationAttested` for that passport from a Chainlink receiver. Only then is a request done, dated by that block, and its transaction linked | runner `runner.test.ts` "a report still being mined, and an index that is behind the chain" and "a broadcast run the CLI printed no report hash for"; `chain.test.ts` "finding a report the CLI printed no hash for"; web `recheck-report-confirm.test.ts`, including another sender, another passport and a failed transaction each left unconfirmed. Not covered: a requested re-check still trusts the index, so a request after the cooldown while the index is stalled could pay a second time, inside R9's cap |
| **R13 Reads a stranger can start are bounded.** Every server read keyed by something a caller sends is held per key and limited per caller, so a loop over fresh ids cannot spend the site's RPC allowance | `withinLimit` with `callerFromHeaders` in `packages/web/lib/api/limit.ts`, in front of `newestChainlinkRecheck` and `confirmedReport` in `lib/recheck/chain.ts` and of the picture route; a confirmed report is held for 30 days, a miss for 30 seconds | web `recheck-report-confirm.test.ts` "reads the 61st call in a minute from one address as a failed read, and leaves other callers alone". Not covered: the count lives in each server instance's memory, so a caller whose requests spread across instances gets more |
| **R14 An address starts only a read.** A query string may start only a read or a check on a passport the registry lists with a pinned public picture, never a write, and an id's shape is checked before any request is made for it | The web: `sampleAsked` in `packages/web/components/verify/ShareAnswer.tsx` takes `?sample=` only as a passport id, and the verify page then runs a check only when `matchedPassport` in `components/verify/lookup.ts` finds the passport on chain, public or unsealed, with a thumbnail that passed `pinnedUri`. The consent route checks `id` with `passportIdFrom` before it calls the chain. Explore's chips and the studio's `?mode=` only choose what is drawn | web `verify-features.test.ts` "a link to a sample's answer": an offered sample and a registered passport run, and a malformed id, a longer one and a passport Monad does not have fetch nothing and send nothing; `consent-scrubber.test.ts` "turns away an id that is not a passport id, without calling the chain"; `review-fixes.test.ts` step 7, where an unseal record naming another host gives no thumbnail, so the link has nothing to check |
| **R15 A receipt held in the tab is its earner's, or public.** A receipt kept for the visit is drawn only for the account that earned it, or holds only data the chain already shows to anyone | The unseal receipt: `keepReceipt` in `packages/web/components/passport/UnsealPanel.tsx` holds it, and `Unsealer` draws nothing unless `useUnsealPassport` in `lib/passport/unseal.ts` says the signed in wallet holds the passport (`isHolder`, through `ownsPassport`). The challenge receipt: `keepChallenge` in `components/passport/Challenge.tsx` holds the transaction hash and its block, nothing else | web `review-fixes.test.ts` step 10: the unseal receipt drawn for the holder and not after a sign out or for another account, and the challenge receipt holding exactly its hash and block |
| **R16 The one redirect keeps the origin.** The only redirect the web performs prefixes a language the site carries to the current path on the same origin, and never reads a destination from the address | `languageRedirect` in `packages/web/lib/i18n/redirect.ts`, written into the root not-found page twice (`app/not-found.tsx`); it leaves a path that already starts with a language, `_next` and `api` alone. The bare domain's `app/page.tsx` sends `/` to the default language, the same rule with a fixed path. Explore's proxy rewrites and never redirects | web `review-fixes.test.ts` step 9, with a stand-in location: `/verify`, `//evil.example/x`, `/\evil.example`, `/`, and a query and hash naming another host all land on `/` plus a carried language on the same origin, and `/en`, `/en/verify`, `/_next/x` and `/api/x` never move; `loading-language.test.ts` "send a bare address to the reader's language" |
| **R17 One predicate per question.** Every screen that asks "was this record read" asks one function, so no two screens can answer it differently for the same passport | `recordUnread` in `packages/web/components/passport/unread.ts`, which also takes a passport with no document, imported by Explore (`components/explore/plates.ts`, for the plates and the Pictures and Test images chips), the agents strip (`components/agents/strip.ts`), the lineage (`components/passport/family.ts`) and the poster (`components/passport/Poster.tsx`). The strip draws a tile only for a picture with a thumbnail | web `review-fixes.test.ts` steps 3 and 4: no document, nothing read, read with no name, and read with a name, through all four callers; agent 10248's two unreadable passports take no tile. On 2026-09-29 the chips counted 22 pictures and 21 test images of 43 passports under the old rule and the new one, with no passport moving |
| **R18 One cleaning for every failure text.** Every failure a screen prints is the translated sentence, with the service's or the browser's own words passed through the same cleaning and kept inside the folded Details | `reason` in `packages/web/lib/chain/client.ts` (first line only, every address taken out) and `FailureDetails` in `components/studio/FailureDetails.tsx`, used by the account's grid and its Load more in `components/studio/YourPassports.tsx`; Explore's sheet and counts, the Agents board, Verify's answer card, the re-check request, the private copy panel and the challenge print their reasons cleaned the same way | web `failure-lines.test.ts`, steps 2 and 3; `review-fixes.test.ts` step 4, where an index error naming its endpoint shows only the sentence, and the first line, with no address, inside the fold |

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
| Policy | both queued in `VerifierPolicy` `0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821` (`executeAfter` 1790489031, 2026-09-27 06:03:51 UTC), and listed on 2026-09-27 at 14:18 UTC: the public one in [`0xac642cc5...`](https://monadvision.com/tx/0xac642cc5c89290a2659e0ee7aaa78d7b729643f22138725815590dd2abbc0bfb), block 108,487,207, the sealed one in [`0x0e1e2937...`](https://monadvision.com/tx/0x0e1e2937ee4593cb8aad78d4bb6696b14584080b216d4c3c028f0c32eecf457d), block 108,487,216 |
| Old receivers | `0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04` and `0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A` removed from the policy on 2026-09-26, in the same run; every attestation they wrote stays on chain under their address. `0x0d69...` was listed again on 2026-10-02 at 07:08:18 UTC in [`0x446c3051...`](https://monadvision.com/tx/0x446c3051322060339d8e95bcc2938ca6db6692e8d583d360ebab6e626ea1ff9f), block 109,830,535 |

Between the deploy and the listing none of Moolam's four receivers was listed, so no new re-check
could be written. The workflow configs point at the new receivers since the listing ran (R3). The
runner names no receiver of its own: it runs the workflows with their own `config.json`, so it
sends to whatever the copy of the repository on its machine names.

## The platform kit and the MCP server

Two systems added on 2026-09-30. The platform kit lets an outside image generator give its pictures
Moolam passports: four routes on the verify service and the `@moolam/platform` package on the
platform's server ([For platforms](../developers/platform-kit)). The MCP server lets any AI agent read
passports and AI-use terms ([For AI agents](../developers/mcp)). Neither is live until the next deploy
of the verify service, and the live attack pass against them has not run yet, so every row below is
proven by the route, store and fork tests it names, and says so. The co-sign page and the connect
page in the web app are being built; where an invariant rests on them, the row says it is not built
yet.

### A) What kind of system this is

- **A signing broker for three parties who do not trust each other.** A company's server, a person's
  browser, and Moolam's certificate, pins and sponsored fees. The co-sign page asks a person to sign
  a digest another company's server started. The classic faults: the page shows one thing and the
  digest names another, a link made for one person is opened by another, a record changes between
  show and sign.
- **A credentialed machine API where one party holds every key.** In platform mode one server holds
  the agent's owner key and the passkey bound to its creator wallet. The chain record has exactly the
  shape of any other passport, so every word Moolam says about a passkey must be true of a server key
  too.
- **A vouching list.** "Registered by X through the Moolam platform kit" is a label Moolam issues
  from its own list. Anyone can mint an ERC-8004 agent with any name, so the list is the only thing
  behind the label. The credit for who imagined a platform picture ("Imagined by Y. Drawn on X")
  comes from the same list and one rule, `creditFor`, beside `platformLabel`. A platform is only
  where a picture was drawn and who holds it until the person claims it, never its maker. The
  classic fault is crediting on a platform's word as if the person had signed.
- **Spend by callers.** Each prepare costs a C2PA signing and four pins; a co-sign costs Moolam a
  sponsored registration. Without keys and ceilings it is a faucet.
- **Stored, then trusted.** A waiting co-sign keeps its fields, digest, files and signature on disk,
  and the service reads them back to decide what a person's passkey is asked to sign.
- **An unauthenticated reader that fetches what strangers name** and hands text strangers wrote to a
  model that acts on it. `check_picture` fetches a URL, `get_agent` a card at an address an agent's
  owner chose, and titles and conditions come back into a model's context.
- **A shared, rate-limited index.** The index behind lists allows about 100 queries a minute for
  everything, and Claude calls from one cloud address for all its users.
- **Not applicable:** SQL or shell injection (no database of our own, no shell, the index is queried
  by parameterised GraphQL); rendering user HTML (MCP returns JSON, text is drawn as text); contract
  changes (none; every on-chain check stays as attacked above).

### B) Threat model

**Trust boundaries.** Any MCP client to `/mcp`, with no sign-in; the MCP server to the hosts a call
names (a picture URL, an agent card address); a platform's server to the `/platform` routes, where
its key is the only credential and identifies without authorising; the person's browser to the
co-sign page, where the Privy token is the credential and the handle is not; the platform's site to
the co-sign and connect pages; the waiting-co-sign folder on disk to the service that reads it back;
Moolam's operator to the platform list; the ERC-8004 registry to the list, since an agent's owner
can change after onboarding; the RPC, the index, IPFS and the gateway to every reader; the MCP
server's answer to a model that acts on it.

**What an attacker controls.** The picture bytes and URL; the mode, title, nonce, `issuedAt`,
signature and terms of a prepare, and any creator, wallet or agent field in its body; an agent id,
including an agent they own with any name and card; a platform key's value; a handle in a URL or a
POST; the agent signature bytes; passport ids, agent ids, limits and times in MCP calls; MCP headers
and `Origin`. Indirectly: the redirects and addresses behind a URL, the body a host returns, the
card at an agent's address, a metadata document, the RPC's and the index's answers, every waiting
record read back after a restart, and a `to` address a person or a page gives a platform.

**What the privileged position holds.** Moolam's C2PA certificate, which says "AI-generated by agent
N" under Moolam's name; the Pinata account, where pins are permanent and paid; the Privy
sponsorship budget; the platform list and its keys' hashes; the waiting records, which decide what a
person's passkey is asked to sign; the Moolam origin a passkey answers to; the MCP server's voice,
which models trust.

**What an attacker wants.** A passport in a person's name over a picture, agent or terms they did not
see; to wear a listed platform's name, or make Moolam's certificate say a platform made a picture it
did not; to register a platform's picture first; to drain Moolam's pins, signing or sponsored fees;
to make Moolam's server fetch from inside its network; to steer a model through Moolam's answers, or
have "no match" read while the index was down; to make the site say a person signed what a server
signed.

### C) The standards, and where each is held

P1 to P25 are the platform kit's, M1 to M6 the MCP server's. Paths are under `packages/verifier`
unless they name another package. Web app rows name the files as they stand in the working tree.

| Invariant | Held by | What proves it |
|---|---|---|
| **P1 What is shown is what is signed.** The co-sign page builds the digest in the browser from the fields it drew plus the signed-in wallet, and compares it with the record's digest and the registry's `hashPassport` before any passkey prompt | Not built yet: it is the co-sign page's first rule. The service side it will compare against: every read of a record recomputes both digests from the record's own fields (`recordProblem` in `src/platform/pending.ts`) | The page's test comes with the page |
| **P2 One creator, set once, from a verified session.** The creator is written once, from the wallets of a Privy token the service verified; any other wallet is refused, with the picture and agent still named | `GET /platform/record/:handle` in `src/routes/platform.ts`: the first embedded wallet of the verified user, written by `pending.advance` from `awaiting-creator` only; `creator-mismatch` carries `named(record)`. The page side is not built yet | `platform-routes.test.ts` "co-sign mode pins nothing before /platform/sign, refuses a second wallet and a wrong signer, then pins under the computed ids" |
| **P3 Waiting records are write-once per field.** Fields are fixed at creation; creator, deadline, digest and signature are set once; a record that fails its schema, its digests or its step is dropped, never repaired | `pendingStore` in `src/platform/pending.ts`: one schema per state, `NEXT`, `FIXED_AT_CREATION`, `SET_ONCE`, `recordProblem` and `stepProblem`; `/platform/sign` rebuilds the digest from the fields before it trusts the stored one | `platform-routes.test.ts` "P3: a record edited on disk, or one whose state skipped a step, is refused and dropped"; `platform-state.test.ts` "lets each step set its own fields once and refuses a step that rewrites a fixed or set field" and "refuses a frozen file whose bytes changed on disk" |
| **P4 A handle is a capability.** 128 bits from the CSPRNG, stored only as its sha256, compared in constant time, dead with its deadline, in no log line | `newHandle`, `handleHash` and `recordProblem` in `src/platform/pending.ts`; the three handle routes at log level `silent` in `src/routes/platform.ts`; the co-sign link carries the handle after `#` | The route tests above use handles end to end. Not covered by a test: the silent log level, which the live pass will check against the host's log |
| **P5 An agent signature counts only if it recovers to the agent's owner now.** Over the digest rebuilt from the record, by the registry's own ECDSA rules | `POST /platform/sign/:handle`: `signingDigest`, then `signedByAddress` against `chain.agentOwner` read at that moment; `recoverLikeRegistry` in `src/platform/signatures.ts` refuses a high s or a v other than 27 or 28 | `platform-routes.test.ts`, the co-sign test above ("a wrong signer"); `platform-state.test.ts` "takes a low-s signature with v 27 or 28 and refuses the other forms the registry's ECDSA refuses" |
| **P6 No squatting window made silently.** In co-sign mode nothing is pinned until the creator is set and the agent has signed, and every returned content id must equal the one computed first. Platform mode pins at prepare, after the agent's signature, and the platform signs and sends in one pass | `buildFileSet` and `pinFileSet` in `src/platform/files.ts` (content ids computed first, `cidVersion` v1, each answer compared); the frozen files in `pendingStore`; `already-registered` at prepare. The page reading the chain before its prompt is not built yet | "co-sign mode pins nothing before /platform/sign" and "platform mode: the digest is the one hashPassport gives, and every pin is v1 under the id computed first" in `platform-routes.test.ts`. What stays open is stated under the weaknesses below |
| **P7 Nothing that costs Moolam runs for a caller without a key.** A per-key quota and a ceiling for every platform, which holds when a key leaks; keys stored hashed, compared in constant time, never in a URL, log or answer; the package never runs in a browser | `platformForKey` in `src/platform/key.ts`, first in every platform route; `dailyQuota` and `globalDay` in `src/platform/stores.ts`, from `PLATFORM_PREPARES_PER_KEY_PER_DAY` and `GLOBAL_PLATFORM_PREPARES_PER_DAY`; `callService` in `packages/sdk/src/service.ts` sends the key only in the header and refuses redirects. The MCP server has no tool that spends | "answers 401 to a request with no key or a key it never issued, and does no work" and "P7: the per-key quota and the ceiling for every platform stop a prepare before any work" in `platform-routes.test.ts`; SDK `guards.test.ts` "the platform key on the wire" |
| **P8 A relayer spends last.** | Nothing to hold: Moolam built no relayer. Platform mode sends from the platform's wallet, co-sign mode from the person's sponsored wallet | Not applicable while no relayer exists |
| **P9 One predicate for the terms.** Validated at prepare by the contract's rule and written unchanged into the manifest, the metadata and `setConsent` | `readTerms` in `src/platform/upload.ts`, through the consent schema, refusing a condition that trimming would change; `termsProblem` and `sameTerms` in `packages/sdk/src/terms.ts` | "P9: refuses a 257-byte, a non-ASCII or a padded condition at prepare, before anything is signed"; SDK `guards.test.ts` "the AI-use terms"; SDK `fork.test.ts` "registers a picture in platform mode against the live registry and states the same terms" |
| **P10 The co-sign page is a top-level Moolam page.** No frame, nothing from its opener changes what is drawn or signed, and anything it posts back goes to one named origin | The site sends `X-Frame-Options: DENY` on every page (`packages/web/next.config.ts`). The page itself, and the listed origins it posts to, are not built yet | The page's test comes with the page |
| **P11 No silent rebind.** Signing in never sends `bindPasskey` | Not built yet on the co-sign page. For platforms, `setupPlatform` refuses an existing binding without `rotate` (P20) | See P20 |
| **P12 Time comes from the chain.** Every window is read against the latest block; nothing moves after a deadline | `liveChain().now` in `src/platform/chain.ts`, `issuedAtProblem` in `src/platform/signatures.ts`, `expireIfDue` in `src/routes/platform.ts`; `chainNow` in `packages/sdk/src/chain.ts` before every signature | "P12: a passed deadline is refused, and the record never moves again" |
| **P13 Status is a chain read.** "registered" only when the registry holds this very passport | `GET /platform/status/:handle` compares creator, agent, metadata and manifest from `getPassport`; `waitForPassport` in `packages/sdk/src/cosign.ts` reads the registry itself; `registerAsPlatform` needs the `PassportRegistered` and `ConsentSet` logs in their receipts | SDK `fork.test.ts` "registers a picture the person co-signs with their own passkey" |
| **P14 Names are labelled self-declared.** The card's own name and the name Moolam lists are two facts | The passport page's agent part (`packages/web/components/passport/Facts.tsx`); `get_agent` answers `card` and `listedPlatform` apart (`agentFacts` in `src/mcp/facts.ts`) | web `platform-words.test.ts` "P14: the listed name and the card's own name are two facts" |
| **P15 The base claim is true without the list.** Every passport's words say a key bound to the creator wallet signed; the label is only an addition | `passkeyBound` in the web's message files; `heldPlatformList` and `labelFrom` in `packages/web/lib/data/platform-label.ts` give no label for a refused list; the platform-mode metadata's description, `platformDescription` in `src/routes/platform.ts` | web `platform-words.test.ts` "P15: without the list the base words stand and no label shows" |
| **P16 One predicate issues the label, and one rule the credit.** Creator, Generated kind, agent, a manifest and the entry's window; a listed wallet failing any reads "outside the kit". The credit is `held` (the platform's wallet never let it go, nobody named), `handed` (handed on, the first recipient has not confirmed, nobody named), `confirmed` or `passedOn` (the first recipient wrote their own terms, and is named whoever holds it now) or `cosigned` (the creator named), or none; it is never guessed and never names the platform as maker. P35 and P39 below define the first recipient and the words, and replace the older `unclaimed` and `claimed`, which are retired. What it does not prove: a `confirmed` credit rests on the platform's hand-over and the person's own statement, not on their key; only `cosigned` rests on a key bound to the person's own wallet | `platformLabel` in `src/platforms/platforms.ts`, copied byte for byte to `packages/web/lib/platforms`, used by `passportFacts` in `src/mcp/facts.ts` and by the web's `labelFrom`; `agentOwnerUnchanged` for the co-sign badge. `creditFor` beside it in the same file, built on `platformLabel` for the kit cases and on the co-sign badge's owner-unchanged rule for `cosigned`, used by `passportFacts` for `get_passport`'s `credit` | `platforms.test.ts` "gives the label before a rotation and not after it" and "reads a Captured passport from a listed wallet as outside the kit"; `platforms.test.ts` "creditFor": one test per case, a holder that was not read, an agent that changed owner, a picture outside the window or under a retired entry, and a checksum difference; `mcp-tools.test.ts` "P16", which reads the credit through `get_passport`; web `platform-words.test.ts` "P16: one predicate issues the label" |
| **P17 Membership is an operator act backed by key proofs.** Both signatures over one onboarding message, no route that writes the list, names bounded and unique | `loadPlatforms`, `recordProblem`, `listProblem`, `cleanName` and `nameKey` in `src/platforms/platforms.ts`; `scripts/platform-add.ts` is the only writer | `platforms.test.ts` "loadPlatforms": a signature from someone else, a name in two spellings, an uncleaned name and overlapping windows each refuse the list |
| **P18 In platform mode the request names only the key.** Creator and agent come from the key's entry | `crossedField` in `src/platform/upload.ts`; the fields built from `platform.creatorWallet` and `platform.agentId` | "P18: refuses a platform-mode body naming another creator or agent, and a co-sign body naming any creator" |
| **P19 The agent key authorises the manifest; the Moolam key only identifies.** A PlatformPrepare signed by `ownerOf(agentId)` read now, fresh and never replayed | `prepareDigest` and `signedByAddress` in `src/platform/signatures.ts`, run before any work; `nonceMemory` in `src/platform/nonces.ts`, kept on the volume | "P19: a valid key with no agent signature, or a stranger's, makes no manifest, no pin and no record" and "refuses a replayed PlatformPrepare and a second prepare of the same picture inside the window"; `platform-state.test.ts` "keeps the nonce memory, and refuses a replay after the restart"; SDK `prepare-message.test.ts` |
| **A prepare is accepted only once its nonce is saved.** A nonce held in memory only is forgotten by a restart inside its ten-minute window, and the same signed message would be accepted again | `nonceMemory` in `src/platform/nonces.ts`: a write that fails refuses the prepare as `closed` (503) and forgets it, and says so once in the log | `platform-state.test.ts` "WO-317: refuses a prepare whose nonce cannot be written, so a restart cannot replay it", which failed on the old code with the prepare accepted |
| **P20 Rotation with history intact.** Key, creator wallet and passkey can each rotate; earlier passports keep their label | `rotate` in `scripts/platform-add.ts` sets `validTo`; `setupPlatform` in `packages/sdk/src/setup.ts` reads `getPasskey` and `balanceOf` first; `rpIdProblem` in `packages/sdk/src/passkey.ts` | `platforms.test.ts` "gives the label before a rotation and not after it"; SDK `fork.test.ts` "refuses to overwrite the binding without rotate", "rotates the key of a platform wallet that holds a passport only with rotate, and refuses without it" and "is refused when the wallet holds a passport, since there is no key to rotate"; SDK `guards.test.ts` on the rpId |
| **P21 Keys stay where they were made.** The passkey's private key and the agent key never enter a Moolam request, store or log | `ServerPasskey` keeps the key in a private field and prints only the public half; the routes take signatures only | SDK `fork.test.ts` "never sent the passkey's private key anywhere, and sent the platform key only in the service's Authorization header"; `guards.test.ts` "keeps the private key out of JSON and console output" |
| **P22 A hand-over moves a token only to a checked address.** A hand-over credits nobody by itself: the passport reads `handed` until the first recipient confirms (P35, P39). The address a person's email claim gives is held by P31 | `checkedRecipient` and `transferPassport` in `packages/sdk/src/transfer.ts`: strict checksum, no zero address, own wallet or registry, `safeTransferFrom`, a receipt and a fresh `ownerOf`; the delivery worker and a `deliverNow` go through the same `checkedRecipient`. The connect page posts the address only to a listed origin after a click: `postAddress` in `packages/web/lib/cosign/opener.ts`, used by `packages/web/components/connect/ConnectPanel.tsx` | SDK `fork.test.ts` "refuses the zero address, the platform's own wallet, the registry and a bad address, sending nothing" and "moves the passport to a checked address and answers only from the receipt" |
| **P23 Holder and creator are two facts everywhere.** | `passportFacts` and `termsFacts` in `src/mcp/facts.ts` (`holderIsCreator`, `writer`, `writerIsHolder`); the passport page's "Registered by X. Now held by Y." | `mcp-tools.test.ts` "P23"; web `platform-words.test.ts` "P23: holder and creator are two facts" |
| **P24 The platform's terms are the platform's.** The chain statement is in force; the manifest's is shown as stated at generation, and a difference is shown | `statedAtGeneration` and `sameAsGeneration` in `termsFacts`; `fileTermsOf` and `termsDiffer` in `packages/web/lib/data/file-terms.ts` | `mcp-tools.test.ts` "P24"; web `platform-words.test.ts` "P24" |
| **P25 Nobody is labelled a maker by holding.** A held passport is listed apart, never as made. The one exception is the `confirmed` case for this wallet as the first recipient, listed as imagined by them and drawn on the platform (P39); a `handed` passport, and a `passedOn` one held by a later buyer, stay apart | `packages/web/components/mine/held.ts` (`splitCredited`, through the credit rule) and `HeldPictures.tsx`: held passports listed apart, never as made, and hideable | web `platform-words.test.ts` "P25: a held passport is never shown as made, and can be hidden", "puts only a confirmed handover with the wallet's own work, whatever the wallet's address case" and "gives a buyer of an unconfirmed handover no line telling it to confirm, since only the first recipient can" |
| **M1 Every fetch for a caller goes through the guarded path.** | `checkPicture` in `src/mcp/picture.ts` hands the URL to `readFromUrl`, the `/verify` path through `safeFetch`; `liveCardReader` in `src/mcp/agentCard.ts` (no redirect, a named host only, 64 KB, the ERC-8004 card schema); metadata only as a bare pinned id | `mcp-guards.test.ts` "M1: refuses a picture URL on a private or loopback address with the /verify sentence"; `mcp-tools.test.ts` "reads an agent's card from a data address and refuses an https card on an address literal" |
| **M2 Every input is shape-checked before any request.** | `src/mcp/inputs.ts`: one pattern for a passport id, bounded agent ids, limits and times, https-only URLs, base64 sized before decoding; `idFrom` in `src/mcp/resources.ts`; a lineage walk capped at eight | `mcp-tools.test.ts` "M2: refuses every malformed id, number and address before any read" |
| **M3 Absence only after a read that succeeded.** | The fixed `unavailable:` sentences in `src/mcp/facts.ts`; a stale index is `unavailable` in `checkPicture`, `historyFacts` and `recentFacts` | `mcp-guards.test.ts` "M3: a read that failed is unavailable, never an empty list, 'not stated' or 'not found'" and "M3: an index that is down gives isError for a picture that matches nothing, never 'no match'" |
| **M4 User text is data.** | `answered` and `refused` in `src/mcp/tools.ts`; titles cut to 200 characters, addresses to 300, card fields in `cardFrom`; 24,000 characters per answer; the same tool list for every caller | `mcp-tools.test.ts` "M4: a title carrying instructions comes back only as a JSON string field", "a 2026-07-28 client lists the six read-only tools and reads a passport from the chain" and "a 2025-era client lists the same six tools and reads the same passport" |
| **M5 MCP reads are bounded like web reads.** | `heldChain` and `heldReads` in `src/mcp/chain.ts` and `src/mcp/memory.ts`; the recent list held 30 seconds for everyone; the service's 60 a minute per address; the upload ceiling on every body; `Origin` checked in `src/routes/mcp.ts` | `mcp-tools.test.ts` "M5: asking for one passport again reads the chain once, whoever asks"; `mcp-guards.test.ts` "M5: a browser Origin that is not listed gets 403; a listed one and none at all pass". Not covered: the count is per process, and every Claude user shares one address |
| **M6 A verdict carries its facts.** | `checkPicture` returns the whole verify answer; `fitted` cuts near misses from the tail and never the best match or the first registration; `lagSeconds` from the chain head read now | `mcp-tools.test.ts` "M6: check_picture carries the verify answer's facts and the index's lag behind the chain head", "M4, M6: check_picture fits a long answer by cutting near misses from the tail, and keeps the best match first" and "M6, V18: the trim never drops the first registration, even when it sits at the tail, and keeps its facts" |

The rules across all of it:

- **One rule, not a list.** The label is one predicate over chain fields and one entry, and the
  credit one rule built on it, so the site and the MCP server cannot disagree about who imagined a
  picture. Address
  safety is `safeFetch`'s predicate, text safety the contract's byte rule, id safety one pattern per
  shape, and the creator check one equality against a verified session.
- **Compare after the same parser.** `getAddress` on both sides of every address comparison, agent
  ids as bigint on both sides, one EIP-712 encoder shared by the service and the package and checked
  against the registry's `hashPassport`, platform names through one normaliser.
- **Fail closed.** No list, no label. No agent signature, no manifest. A digest that differs, an
  unreadable record, a passed deadline or a chain that did not answer: no prompt, no pin, no send.
  An index that did not answer: no verdict.
- **Where state lives.** Quotas, the replay memory and waiting co-signs are on the service's volume
  at `/data` and survive a deploy. The service runs one copy, so a request in flight during a deploy
  is dropped and must be sent again.

## Claim with your email

Added on 2026-10-01. A platform that registers a picture in platform mode can leave the passport
waiting for its user's email address instead of asking for a wallet. The platform sends the address
with its prepare, and the verify service keeps only a keyed hash of it. When the person signs in to
Moolam with Google or an emailed code, My pictures lists what platforms hold for the addresses Privy
verified for them, and they answer "These are mine" or "Not mine". The platform's delivery worker
hands each accepted passport to the person's Moolam wallet, and the person confirms with one
sponsored `setConsentBatch` from that wallet, which is the moment the credit names them. Moolam
writes nothing new on chain: the hand-overs are the platform's transactions and the confirmation is
the person's. How a platform uses it is in
[For platforms](../developers/platform-kit#leaving-a-passport-for-a-persons-email).

This section states what the code does today. The live attack pass has not run against these routes
yet, so every row below is proven by the route, store, SDK, fork and web tests it names. Paths are
under `packages/verifier` unless they name another package.

### A) What kind of system this is

- **An identity broker between two companies.** The platform says an address belongs to its user;
  Privy says the person signed in to Moolam proved they read that inbox. The two strings meet only
  through one normaliser. Too loose hands a stranger someone's pictures, too strict strands them.
- **An attribution channel.** A ticket names an address and a picture. If the person accepts and
  confirms, the credit names them for good, so anyone who can write a ticket can try to pin a
  picture on a real person. A ticket is therefore only ever an offer.
- **A small multi-tenant store keyed by a hash of personal data.** An HMAC of an email under a
  server secret can be reversed by dictionary by anyone holding both the secret and the store, and
  the store lists the platforms each address used.
- **A hand-over service whose output a third party acts on.** The destination wallet goes to the
  platform, whose server moves a token to it. A damaged or swapped address is a transfer nobody can
  undo.
- **A public record keeper.** Waiting, delivered and confirmed are said on Moolam pages and in MCP
  answers, so each must rest on a chain read, never on a platform's word or the ticket file alone.
- **A state machine on disk, read back as truth.** An accept racing a refuse, two accepts, a worker
  trying again after its transfer landed.
- **Platform-chosen fetch targets inside a person route.** A platform-mode passport's metadata
  address is the platform's choice, and `GET /claims` draws its title and picture.
- **Spend by callers.** Each `/claims` read calls Privy and the gateway, each confirm is a sponsored
  transaction, and each failed hand-over costs the platform gas.
- **Unsolicited content sent to a named person.** Spam or a phishing-shaped title can ride a ticket.
- **Not applicable:** SQL or shell injection (no database engine and no shell; the store is
  schema-checked JSON on the volume); rendering user HTML (titles are drawn as text); blind signing
  (the person's one transaction is `setConsentBatch` over ids and terms the page shows first);
  contract changes (none).

### B) Threat model

**Trust boundaries.** A platform's server to `POST /platform/prepare` with `deliverTo`; Privy's user
record to the verify service; the person's browser to `GET /claims`, `POST /claims/accept`,
`/claims/refuse`, `/claims/unmute` and `DELETE /claims/standing/:platformKeyHash`; the ticket file
on disk to every route that reads it back; `GET /platform/deliveries` to the platform's worker; the
chain (the registry's record and `ownerOf`) and the Envio index (the first hand-over and the consent
history) to the ticket states and the credit; the IPFS gateway to `GET /claims`; the stored terms to
the browser that builds `setConsentBatch`; Google's ID token to Dreamloom's server, which is
Dreamloom's own boundary.

**What an attacker controls.** Directly: `deliverTo.email` (any string, any length, any script),
`deliverTo.verifiedBy`, how many tickets a key writes, the ticket ids in an accept or a refuse, the
terms and the send-future tick, a platform key, a Privy token, the picture and title of a prepare,
and the metadata address on chain. Indirectly: the set and spelling of the addresses in a person's
Privy record, the wallets Privy lists, every ticket field read back, what the RPC and the index
answer and how far behind the index is, the document behind a content id, the writer and time of
every consent entry, transfers anyone makes to anyone, and the pepper if it leaks.

**What the privileged position holds.** Moolam's Privy app secret, and with it every Moolam user's
verified addresses; the pepper; the ticket file, which after an accept links an address's hash to a
wallet; the authority to tell a platform where to send a token; the authority to say waiting,
delivered and confirmed on a public page and in MCP answers; the sponsorship budget.

**What an attacker wants.** To pin a picture on a real person (a ticket, an accept, a confirm, a
credit); to catch someone else's pictures, through a spelling collision or by naming another
address's ticket ids; to learn whether an address has a Moolam account, or which wallet it owns, by
probing prepares; to send a passport somewhere wrong, or make the worker spend for nothing; to make
Moolam state a false chain fact: an offer for a passport that does not exist, delivered on the
platform's word, confirmed from a stale index or the wrong writer.

### C) The standards, and where each is held

P26 to P39 extend the platform kit's P1 to P25 above. P35 and P39 replace P16's credit cases:
"claimed" is retired, and the credit is `held`, `handed`, `confirmed`, `passedOn` or `cosigned`.

| Invariant | Held by | What proves it |
|---|---|---|
| **P26 A ticket is an offer; only the person's own acts make it a fact.** No token moves and nothing is written on chain because a ticket exists. A passport reaches a person's wallet only after they press "These are mine" on My pictures while signed in with a matching verified address, or through a standing choice they made the same way and can see and stop there. Confirmed only when the first recipient's own wallet wrote a consent entry. A refusal is final and mutes that platform for that address until the person allows it again | `acceptTickets`, `refuseTickets`, `unmute` and `clearStanding` in `src/claims/store.ts`, reached only through `claimRoutes` in `src/routes/claims.ts` with a verified Privy token; `GET /platform/deliveries` in `src/routes/platform.ts` lists accepted tickets only; `confirmedAtFor` and `creditFor` in `src/platforms/platforms.ts`; the confirm press, `runConfirm` in `packages/web/lib/claims/confirm.ts` | `claims-routes.test.ts` "offers a ticket only once the chain shows it under the platform's wallet, to the matching address only, and delivers it", "P26, P30: a standing choice returns deliverNow to its key for that address only, until it is cleared" and "P26: a refusal is final and mutes that platform for the address until the person unmutes"; `platforms.test.ts` "creditFor" |
| **P27 A ticket is shown only when the chain shows what it claims.** Written pending at prepare. It opens only when the registry's creator and `ownerOf`, both read in that pass, equal the platform's listed wallet and `platformLabel` gives the kit label. A passport that never lands, lands under another creator, or leaves the platform's wallet before an accept closes the ticket as expired or moved, never listed. Delivered only when `ownerOf` equals the destination | `claimSweeper` and its `decide` in `src/claims/sweep.ts`, run on the service's one-minute timer, where a read that fails changes nothing; `writeTicket` in `src/claims/store.ts` writes only `pending`, and `changeProblem` refuses a new ticket in any other state | `claims-store.test.ts` "opens a ticket only when creator and ownerOf both equal the platform's wallet under its label", "never opens a ticket for a passport registered under another creator, and expires it after its window", "changes nothing while the chain cannot be read, past every window included" and "moves an offer whose passport left the platform's wallet, and delivers only to the destination". Not covered: finality, since the sweep reads the latest block |
| **P28 One normaliser, both sides, no provider rules.** NFKC, trimmed, lowercased and NFKC again, then exactly one address: one @, both sides non-empty, at most 254 code points, a dot-atom local part and a domain of letter, mark and digit labels. Anything else is refused. No dot, plus or domain folding. Only Privy's `email` account and the `google_oauth` account's email, each with a verified time, are matched | `normaliseEmail` and `emailHash` in `src/claims/email.ts`, used by `readDeliverTo` in `src/claims/service.ts` on the platform's string and by `callerOf` in `src/routes/claims.ts` on every address `verifiedEmails` in `src/claims/privyUser.ts` reads | `claims-email.test.ts` "meets two spellings of one address: case, white space around it and full-width letters", "keeps apart what only a provider's own rule would join, and a look-alike letter", "refuses anything that is not exactly one addr-spec of printable characters", "gives a fixed point: normalising the output again changes nothing, a dotted capital I included" and "reads only the email account and the Google account's email, each with a verified time". Not covered: one person with two addresses, and look-alike letters from two scripts, which stay two addresses |
| **P29 Nothing reversible about an email leaves the request.** The address is hashed in memory and dropped. No store, log line, error, answer or validation message carries the address or its hash: a bad `deliverTo` is refused with the field's name only. The pepper is 32 to 128 bytes of hex in `CLAIM_PEPPER`, read from the environment and never logged, and its number, `CLAIM_PEPPER_VERSION`, travels inside every hash, so a new pepper expires the pending and open tickets written under the old one. A hash is linked to a wallet only in accepted tickets and the standing choices a person made | `emailHash` and `pepperFromEnv` in `src/claims/email.ts`, with the pepper's shape checked at boot in `src/env.ts`; `readDeliverTo` in `src/claims/service.ts`; the refusals in `/platform/prepare` and `claimRoutes`; `decide` in `src/claims/sweep.ts` for an older pepper; the SDK's `assertDeliverTo` in `packages/sdk/src/prepare.ts`, which names the field and never the value | `claims-routes.test.ts` "P29: no answer and no log line carries an address, in any spelling, or its hash"; `claims-email.test.ts` "keys the hash with the pepper and tags it with its version, so another pepper never matches" and "fails the boot on a short or lone pepper, naming the variable and never the value"; `claims-store.test.ts` "expires waiting offers written under an older pepper (P29)"; SDK `guards.test.ts` "is refused by shape before any chain call, and the error never quotes it". Not covered: the host's own request log, and whether the pepper came from a CSPRNG, which is the operator's step (`openssl rand -hex 32`) |
| **P30 Nothing a platform receives varies with whether an address has a Moolam account,** except a standing choice that person made for that platform. Prepare, deliveries and every refusal read the same for a known and an unknown address. The ticket caps count only the key's own tickets, whatever became of them, so a refusal or a mute frees nothing a platform could probe for. `deliverNow` goes only to the key the choice was made for. A prepare with `deliverTo` still needs the agent's signature and counts against the key's quota | `/platform/prepare` in `src/routes/platform.ts`: `ticketRefusal` over `writeProblem` before any pin, then `standingFor` and `writeTicket`; `writeProblem` in `src/claims/store.ts`. A muted address still gets its ticket written, and only `GET /claims` hides it | `claims-routes.test.ts` "P30: answers a prepare for a Moolam user's address, a stranger's and none in the same shape"; `claims-store.test.ts` "P30: never lets a person's refusal free a slot the platform could probe for". Not covered: response times, which were not measured |
| **P31 The destination comes from Privy, never from the request.** It is the first embedded Ethereum wallet in the person's Privy record, the selector the co-sign routes use. It is stored checksummed and schema-checked on read-back, checked again before every answer that names it, and checked a last time by the SDK's strict rule before any send. Never the zero address, the registry, the ticket's platform wallet or any listed platform's wallet | `POST /claims/accept` in `src/routes/claims.ts`, through `embeddedWallets` in `src/auth/wallet.ts`; `deliverable` in `src/claims/service.ts`, run again in `GET /platform/deliveries` and before a `deliverNow`; the `checksummed` schema in `src/claims/store.ts`; `checkedRecipient` in `packages/sdk/src/transfer.ts`, called by `runDeliveries` and by `registerAsPlatform` for `deliverNow` | `claims-routes.test.ts` "P31: the destination is Privy's first embedded wallet, never a platform's wallet, and never one the body names"; SDK `deliveries.test.ts` "never sends to a bad, zero, registry or own-wallet destination"; SDK `fork.test.ts` "refuses a bad, zero, registry or own-wallet destination, or one for a picture with no email, and sends nothing" |
| **P32 Ticket ids are capabilities scoped by identity.** 128 bits from the operating system's CSPRNG. Accept and refuse act only on ids whose address hash is one of the caller's. A request naming any other id, an unknown id, a repeated id or more than 32 is refused whole, and an unknown id reads the same as someone else's | `newTicketId` and `ownTickets` in `src/claims/store.ts`; the `ticketIds` schema and `MAX_TICKETS_PER_CALL` in `src/routes/claims.ts`; `POST /platform/deliveries/:ticketId/failed` in `src/routes/platform.ts` answers another key's ticket as not found | `claims-store.test.ts` "writes a ticket pending, with a 128 bit id from the CSPRNG and the email only as its hash" and "refuses an id outside the caller's set whole, and an unknown id the same way (P32)"; `claims-routes.test.ts` "P32: refuses a request naming another address's ticket whole, and changes neither" |
| **P33 The ticket store is a write-once state machine.** Pending, open, accepted, delivered, refused, expired, failed and moved only move forward; each step names the state it expects; fixed fields never change and set-once fields are set once. Every record is schema-checked on read-back and a failing one is dropped, never repaired; a file that is not JSON closes the store and every claim route answers 503. Of an accept and a refuse, or of two accepts, exactly one wins | `NEXT`, `FIXED`, `SET_ONCE`, `stepProblem`, `changeProblem`, `advance` and `claimStore` in `src/claims/store.ts`, whose `change` reads, decides and writes in one synchronous stretch | `claims-store.test.ts` "lets an accept racing a refuse, and a second accept, lose whole", "refuses a step that skips a state or rewrites a fixed field, and writes nothing" and "drops a record changed on disk and writes the file back without it; a file that is not JSON closes the store"; `claims-routes.test.ts` "P33: of an accept and a refuse sent together, exactly one wins". Not covered: two copies of the service writing one file; the service runs one |
| **P34 The worker spends a bounded amount per ticket.** `GET /platform/deliveries` lists only accepted tickets of that key whose `ownerOf`, read now, is still the platform's wallet, at most 32 a poll. The worker reads the holder again, checks the destination, simulates and only then sends, sends a ticket at most once a poll, and after `maxTries` failed tries (3 by default) reports it, which closes it as failed and shows it to the person. Delivered stays the sweep's word, from the chain (P27) | `GET /platform/deliveries` and `POST /platform/deliveries/:ticketId/failed` in `src/routes/platform.ts`; `markFailed` in `src/claims/store.ts`; `runDeliveries` in `packages/sdk/src/deliveries.ts`, sending through `sendTransfer` in `transfer.ts`; the person's page groups failed tickets with `waitingByPlatform` in `packages/web/lib/claims/offers.ts` | `claims-routes.test.ts` "P34: lists only accepted tickets the platform still holds, and a failed one is shown to the person"; SDK `deliveries.test.ts` "skips a ticket whose passport the platform's wallet no longer holds, and never counts it as a try", "sends a ticket at most once in one poll, even when the list names it twice", "reports a ticket failed after maxTries failed sends and never sends it again" and "counts a refused simulation as a failed try without sending anything"; SDK `fork.test.ts` "the delivery worker hands an accepted passport to a fresh wallet with one send, though the list still names it". Not covered: the try count lives in the worker's memory, so a restarted worker may try a ticket up to `maxTries` times again |
| **P35 One source for the first hand-over.** The first `Transfer` of that token whose sender is the creator and whose receiver is not, the mint skipped, recorded once by the index and never moved by a later sale or a return. The site and the MCP server both read it from the index, and when the index cannot say, there is no credit, never `held`. The consent match is one predicate: the earliest entry whose writer is that first recipient, both addresses through `getAddress` | The `Transfer` handler in `packages/indexer/src/EventHandlers.ts` (`firstTransferTo` and `firstTransferAt`); `handoverFromIndex` in `src/mcp/handover.ts` and `handoverFacts` in `packages/web/lib/data/platform-label.ts`, both failing closed on a half-written answer or a history longer than one read; `confirmedAtFor` and `kitCredit` in `src/platforms/platforms.ts` | `mcp-handover.test.ts` "credits the first recipient's earliest entry and ignores the platform's and a buyer's", "reads a first recipient with no entry of their own as not confirmed" and "refuses to say 'not confirmed' when the history is longer than one read and the recipient is not in it"; `platforms.test.ts` "keeps crediting the confirmed first recipient after a resale, and shows the buyer only as holding it". Not covered: an index running behind the chain, so a confirmation shows once the index has it |
| **P36 Platform text and pictures reach the claims page only through the pinned-content rule.** The metadata address is read only as a bare IPFS content id through the gateway, with no redirect, a byte cap and a five second limit. The title is one line of printable text of at most 120 code points; the picture is the thumbnail's content id, which the page holds to its own pinned-picture rule again. Anything else shows "No preview" and the passport id. `verifiedBy` is one of three words, refused otherwise at prepare, and worded as the platform's claim beside its listed name: "Dreamloom says it checked this address with a Google sign-in." | `previewOf` and `previewReader` in `src/claims/preview.ts`; `VERIFIED_BY` in `src/claims/store.ts` and `deliverToSchema` in `src/claims/service.ts`; `previewUrl` and `artFor` in `packages/web/lib/claims/art.ts`; the `claims.verifiedBy` words in `packages/web/messages/en.json`, drawn by `packages/web/components/claims/PlatformOffer.tsx` | `claims-email.test.ts` "shows a title as one line of text and a thumbnail only as a bare ipfs content id" and "never reads a metadata address that is not pinned content, and shows no preview when the read fails"; web `claims-render.test.ts` "shows 'no preview' with the passport id when the service sent none, or a picture off the pinned rule" and "words how the address was checked as the platform's claim, beside the platform's name" |
| **P37 Terms are the contract's predicate, checked twice.** Validated at accept by the same rule as `MoolamConsent`'s constraint check and stored unchanged. The browser builds `setConsentBatch` only from ids whose `ownerOf`, read now, is the signed-in wallet and that this wallet has not already written terms on, at most 32 a call; it reads them again at the press and sends nothing if they changed; and it says confirmed only from a receipt with this wallet's `ConsentSet` for every id | `termsProblem` and `termsSchema` in `src/claims/terms.ts`; `heldBatch`, `consentBatchRequest`, `runConfirm` and `receiptConfirms` in `packages/web/lib/claims/confirm.ts` | `claims-email.test.ts` "accepts what the contract accepts, the edges included, and stores it unchanged" and "refuses what the contract refuses"; `claims-routes.test.ts` "P37: a waiting entry carries exactly the terms its own person accepted, and never another person's"; web `claims-confirm.test.ts` "drops the passports this wallet does not hold, reading the holder in any case", "never holds more than 32, and reads each passport once however many tickets name it", "sends nothing when the wallet no longer holds what was shown, and says the list changed" and "is never confirmed from a receipt without ConsentSet, with it for only some ids, from another writer or register, or reverted" |
| **P38 Person routes and ticket writing are metered.** `/claims`, accept, refuse, unmute and stop take 500 calls a day per person, 1,000 per address, and `CLAIM_REQUESTS_PER_DAY` for everyone (20,000 by default; 0 closes them). One key may write 20 tickets for one address inside a ticket's 180 day life and hold 1,000 waiting, and the service holds at most 20,000 tickets. A key with at least 10 refusals, more than one in four of its tickets, stops writing tickets (`deliver-closed`) until an operator clears its tally | `callerOf` in `src/routes/claims.ts` and `DEFAULT_CLAIM_LIMITS` in `src/claims/service.ts`; `DEFAULT_CLAIM_CAPS`, `writeProblem` and `refuseTickets` in `src/claims/store.ts` | `claims-routes.test.ts` "P38: meters each person, and the ceiling for everyone closes the routes at zero"; `claims-store.test.ts` "stops one person's tickets from one platform at the cap, and the key's waiting tickets at its own" and "closes a key's ticket writing once more than one in four of at least ten tickets were refused". Not covered: no route or script clears a closed key yet |
| **P39 Credit words name only what the chain proves.** `held` (the platform's wallet never let it go), `handed` (the first recipient has not confirmed, and the holder is named only as holder), `confirmed` (the first recipient wrote terms and still holds it), `passedOn` (they confirmed and someone else holds it now) and `cosigned`. One function issues them for the site and the MCP server, and nobody is named as the person who imagined a picture without their own consent entry or their own key | `creditFor` and `kitCredit` in `src/platforms/platforms.ts`, copied byte for byte to `packages/web/lib/platforms`; `passportFacts` in `src/mcp/facts.ts`, which returns the case and its addresses as fields; the `passport.platform` words in `packages/web/messages/en.json` | `platforms.test.ts` "creditFor"; web `platform-words.test.ts` "says a handed passport went to its holder, who has not confirmed, and credits nobody", "credits the first recipient who confirmed, with the date and the note on what the credit rests on (WO-261b)" and "credits the confirmed first recipient after a resale and names the buyer only as the holder" |
| **Dreamloom never removes a picture whose passport it holds for a visitor.** The site keeps 500 pictures. A platform-mode picture still registered, or one with an action running on it, is skipped when the oldest are removed, and a weave with nothing it may remove is refused 503 before anything is written or removed | `isHeld`, `makeRoom` and `createPicture` in `packages/dreamloom/lib/server/store.ts` | `packages/dreamloom/test/store-shelf.test.ts`, which failed on the old code with the oldest held picture gone. Not covered: the delivery worker never moves a delivered picture's record on, so a delivered one stays held |

The rules across all of it:

- **One rule, not a list.** One address predicate and one normaliser for both strings, one chain read
  each for open, delivered and held, and one credit function. What they do not cover: look-alike
  letters across scripts, and one person with two addresses.
- **Compare after the same parser.** The same `emailHash` on the platform's string and on Privy's,
  `getAddress` on every address pair, passport ids lowercased by one function, ticket ids by exact
  lookup.
- **Fail closed.** Chain unreadable: no ticket opens, nothing is delivered, no credit. Privy
  unreadable: no list and no accept (`privy-unavailable`). No pepper: every claim route, and every
  prepare with `deliverTo`, answers `claims-unavailable`. A record that fails its schema is dropped, a
  metadata address that is not a content id shows no preview, and an unknown `verifiedBy` is refused
  at prepare.
- **Where state lives.** Tickets, standing choices, mutes and each key's tally are one JSON file on
  the service's volume at `/data`, written whole, so a process killed mid-write leaves the previous
  file.

## Look-alikes, the trust mark and challenges

Added on 2026-10-01. A passport proves who registered a picture first, and nothing stopped a person
from registering a re-saved copy of someone else's picture as a fresh original. Moolam does not
refuse a look-alike, because a refusal hands the picture to whoever registers first. It labels one.
Before signing, the studio and the platform kit say when an earlier passport by someone else looks
like the picture, and a public camera upload is checked against the web through Google Cloud Vision.
After registration, Chainlink's workflow measures the picture itself and writes any earlier
look-alike it can prove to a new receiver, `MoolamLookalikes`. Each passport wears one trust mark,
issued worst first, and only the network's own writes can light it. A challenge still needs a bond;
the holder may now sign an answer within 14 days, and the resolver's reasons are published through
a second new contract, `MoolamDecisions`. What the mark means to a reader is on
[The trust mark](../concepts/trust-mark); how a challenge runs is in [Disputes](../guides/disputes).

Both contracts are on Monad mainnet with a full Sourcify match:
[`MoolamLookalikes` 0xC0f3984A8116dB8BE514F649e3605A2a3aCd454C](https://monadvision.com/address/0xC0f3984A8116dB8BE514F649e3605A2a3aCd454C)
and
[`MoolamDecisions` 0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F](https://monadvision.com/address/0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F).
This section states what the code does today. The live attack pass has not run against any of it,
so every row below is proven by the contract, workflow, service, index and web tests it names.

What went live on 2026-10-02, on Monad mainnet:

- The policy's listing of `MoolamReceiver` (0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04), the receiver
  the network's verdicts go through, ran at 07:08:18 UTC, block 109,830,535, in
  [`0x446c3051...`](https://monadvision.com/tx/0x446c3051322060339d8e95bcc2938ca6db6692e8d583d360ebab6e626ea1ff9f).
- Chainlink's network runs `moolam-verifier`, owner `0xf072a8c620bfc818875736e3f2d3a2a339c06584`, active
  from about 07:09 UTC as workflow ID
  `00c4dd797775bb465fff638ab5171b19a35ed11d4513eb4890661935d4801890`, which held the verdict step only. Since
  2026-10-07 it runs as workflow ID
  `0031b78176458a823e3930d4efe7d5b6a45807964dac463e9551b49e28e3fe21`, with the look-alike step too. The index and the workflow count network writes from 1790924898 (07:08:18 UTC).
- The first network verdict: passport `0x793a540e287cbdfc6cb680c42b553641fa504afebcce6fd5f035e5e600f15782`,
  registered at 07:23:26 UTC in
  [`0x162c97a7...`](https://monadvision.com/tx/0x162c97a70e53441e16633250e1cf96d695b01939d10625bf29248a9c01e3feaa).
  Ten Chainlink nodes recomputed its fingerprint, distance 0, matched. The verdict is
  [`0x760dcb5e...`](https://monadvision.com/tx/0x760dcb5e1b83929201d8fe299ce9c3be2cf8981502117c5288386d7da3438882),
  block 109,833,597, 07:23:42 UTC, sent to the Keystone Forwarder
  0x76c9cf548b4179F8901cda1f8623568b58215E62: 16 seconds from registration to the network's verdict.
- The treasury was set to the burn address 0x000000000000000000000000000000000000dEaD in
  [`0x45700954...`](https://monadvision.com/tx/0x457009544b51c256c130534b76cd7c3052e3f8299984b54d78037d21fb5d371d),
  block 109,834,440, 07:27 UTC. Rejected bonds are burned.

Live from 2026-10-07: the look-alike step in the network workflow, the verify
service's look-alike routes and its Google web check on the hosted service, and the hosted index
rebuild that lets the live site's marks and counts see the network flag. Before that rebuild the live
site's index could not tell network verdicts from test runs. Paths are under `packages/verifier` unless
they name another package.

### A) What kind of system this is

- **An oracle whose output is a label on a named person.** Chainlink's nodes measure a stranger's
  picture and write through a forwarder, and the site turns the record into "Registered after a
  look-alike" on one passport and "A later passport looks the same" on another. The classic faults:
  a writer that is not who the reader thinks, a replayed or stale report, an order turned round so
  the original reads as the copy, and a candidate source, Moolam's own search, that can make the
  oracle say "none" by staying quiet.
- **A service that repeats what strangers wrote.** The warning before signing carries another
  registrant's title and date into a creator's studio and into a platform's server. `seenEarlier` and
  the web pages are pinned for good and drawn on public pages. Anyone can also register straight on
  chain with a document that says anything.
- **A client of a paid third party that sees pictures.** A camera upload's public thumbnail goes to
  Google before the person has decided to register.
- **Public routes that steer a spender.** The candidates and backlog routes are read by Chainlink's
  nodes with no credential, and the backlog decides what the network spends gas on.
- **Two signed-message routes that pin for good:** the holder's answer and the resolver's reasons.
- **Not applicable:** SQL and shell injection (no database engine, no shell); reentrancy on the two
  new contracts (neither holds money, `MoolamLookalikes` calls nothing, `MoolamDecisions` only reads
  the registry and the policy); upgrade abuse (no proxy); user HTML (every title, answer and reason
  is drawn as text).

### B) Threat model

**Trust boundaries.** Chainlink's forwarder 0x76c9cf548b4179F8901cda1f8623568b58215E62 to `onReport`
on both receivers, the one signed crossing for the network's writes; the owner key of `MoolamReceiver`
to its setters, a crossing with no delay (`MoolamLookalikes` has no owner, so no such crossing);
Chainlink's nodes to the candidates and backlog routes, and the answer back into the run; a
registrant's document and thumbnail, and up to three candidates' records per run; the Envio index to
the site, the MCP server and the backlog route; Google's answer into a document the creator signs;
another registrant's title into a studio or a platform's server; the holder's wallet to the answer
route; the resolver's key to `resolve`, `publish` and the reasons route; the chain and the index to
the one rule that says which passport came first.

**What an attacker controls.** Directly: the picture bytes, title and sealed flag of every prepare; a
document written straight on chain, `seenEarlier`, the sworn line and the title included; the
fingerprints of a passport registered straight on chain; the fingerprints, `asOf` and `n` sent to the
candidates and backlog routes, by anyone; the answer text, passport id and signature; the evidence
address on `flag`; how many passports a wallet registers, and when. Indirectly: Vision's page
addresses and counts, the gateway's bodies, the RPC's and the index's answers and lag, and clock
values that become `executedAt`.

**What the privileged position holds.** The forwarder's signed path is the only thing that can light
"Checked by Chainlink" or "Registered after a look-alike". The deployer key owns `MoolamReceiver`
and is today the policy's owner and resolver. The treasury is the burn address. The verify service holds the Vision key, the
Pinata key and the index copy, and decides which candidates the network ever hears about. The
workflow owner 0xf072a8c620bfc818875736e3f2d3a2a339c06584 deploys what the pins accept. The resolver
key alone decides a bond and the mark "Challenge upheld".

**What an attacker wants.**
1. To brand an original as a copy: turn the order round (a same-second pair, a replayed older record,
   an index that joins the wrong way), or write a record through a re-pointed receiver.
2. To keep a stolen registration clean: register straight on chain to skip the warning, the sworn
   line and the web check, or make the search or Vision fail so the silence reads as clean.
3. To show a person a false "someone registered this earlier" as they sign, through crafted
   fingerprints or a fake `seenEarlier`.
4. To spend Moolam's money: Vision calls, network reports through junk registrations, pins through the
   answer and reasons routes.
5. To plant text or links in front of other people.
6. To freeze a passport's record with an `executedAt` at the top of the range, or carry an answer
   over to another dispute.

### C) The standards, and where each is held

The numbers are the ones the code's own comments carry, so each row can be found with a search.

| Invariant | Held by | What proves it |
|---|---|---|
| **L1 One signed door.** No look-alike record is stored or emitted unless the call came from the pinned forwarder and the report's metadata names the pinned workflow owner and name. The pins were read back on mainnet before ownership was given up, and nobody can re-point the receiver now | Chainlink's `ReceiverTemplate.onReport`, vendored unchanged in `packages/contracts/src/vendor/chainlink/ReceiverTemplate.sol`, in front of `MoolamLookalikes._processReport`; `script/DeployLookalikes.s.sol` stops on any pin that reads back wrong, then calls `renounceOwnership` and checks the owner is zero | `MoolamLookalikes.t.sol` test_aCallerOtherThanTheForwarderIsRefused, test_aReportFromAnotherWorkflowOwnerIsRefused, test_aReportFromAnotherWorkflowNameIsRefused and test_onceRenouncedNoSetterCanRepointTheReceiver. Read live on 2026-10-01 at block 109,634,577: owner the zero address, forwarder 0x76c9, author 0xf072, name pin `0x34623863303364663034` |
| **L2 Chain, kind and freshness are inside the signed payload.** A report for another chain, without the look-alike kind word, naming no passport, naming a passport as its own earlier one, or with `executedAt` at or below that passport's stored floor is refused whole. The kind word keeps a verdict report and a look-alike report from being sent to each other's receiver | `MoolamLookalikes._processReport` and `LOOKALIKE_KIND` | test_aReportWithTheWrongKindWordIsRefused, test_aVerdictShapedPayloadIsRefused, test_aReportForAnotherChainIsRefused, test_aReportForPassportZeroIsRefused, test_aReportNamingThePassportAsItsOwnEarlierIsRefused, test_executedAtAtOrBelowTheFloorIsRefused; testFuzz_aPayloadWithoutTheKindWordIsRefused |
| **L3 Bounded time.** An `executedAt` more than one hour past the block time is refused, so no report can set a floor an honest later run cannot pass | `MAX_FUTURE_SKEW` in `MoolamLookalikes._processReport` | test_executedAtAboveBlockTimePlusOneHourIsRefused; testFuzz_executedAtIsAcceptedOnlyAboveTheFloorAndWithinTheSkew. `MoolamReceiver` has no such bound, stated under the weaknesses below |
| **L4 Trust is the transaction, not the contract's settings.** A verdict or a look-alike record counts as the network's only when its writer is the named receiver, the transaction went to forwarder 0x76c9, and its block time is at or after the activation time. An activation time of zero marks nothing. A record written after someone re-points a receiver fails this rule and is never shown as Chainlink's | `isNetworkWrite` in `packages/indexer/src/network.ts`, used by the index's attestation and `LookalikeChecked` handlers; on an index without the flag, `networkVerdicts` in `packages/web/components/mark/read.ts` reads the report transaction's `to` | indexer `lookalikes.test.ts`, the five "L4" tests, including "a record sent to the receiver by any transaction but the forwarder's is not the network's" and "with the activation time at zero nothing is the network's"; web `marks.test.ts` "decides from the report transaction's `to` on an index without the flag" and "never calls a verdict from any other receiver the network's, whatever carried it". Not covered: the network itself writing a wrong record |
| **L5 A record names two different passports in the right order, or nothing.** The index believes a record only when both passports exist in it, they differ, the earlier one was registered in a strictly earlier second, and both distances fit their fingerprints. A zero earlier id is "none", never a match | `isValidLookalike` in `packages/indexer/src/lookalike.ts` | indexer `lookalikes.test.ts` "L5: an earlier passport registered in the same second is not valid", "L5: a record naming the wrong order, or a passport the index has not seen, is not valid" and "L5: a zero earlier id is none, never a match" |
| **L6 Only the newest record counts.** A newer record replaces the older one, and the passport the older one named loses its count of later look-alikes | the receiver's per-passport floor; the `LookalikeChecked` handler in `packages/indexer/src/EventHandlers.ts` | test_aNewerReportReplacesTheRecord; indexer "L6: a newer record that found none takes the mark off both passports" and "L6: an older record arriving after a newer one changes nothing" |
| **L7 Nothing to steal.** Neither new contract has a payable function, a `receive` or a `fallback` | `MoolamLookalikes`, `MoolamDecisions` | test_itTakesNoMoneyAndAnswersNoUnknownCall in both `MoolamLookalikes.t.sol` and `MoolamDecisions.t.sol` |
| **L8 The service proposes, the run proves.** A candidate counts only after this run reads it from the registry and finds it registered strictly earlier, by another creator, with one of this run's own eight turns and mirrors of the new picture inside both thresholds of its stored fingerprints. Of those kept, the earliest is written | `judgeCandidates` in `packages/workflow/moolam-verifier/lookalike.ts`, called by `lookalikeStep` in `workflow.ts` | `workflow.test.ts`, the eight "L8" tests, including "a candidate the chain reads as later never becomes the earlier id", "a candidate by the same creator never becomes the earlier id" and "a candidate stored as a quarter turn of the picture is found through the eight variants" |
| **L9 Only originals.** A passport registered as an edit skips the look-alike step and asks the service nothing | `isOriginal` in `lookalike.ts` | "L9: an Edited passport skips the look-alike step and asks the service nothing" |
| **L10 A tie is never "earlier".** Two passports registered in the same second are never earlier than each other, in the warning, the run, the index or the site. One function decides, kept byte for byte the same in the service and the workflow | `registeredBefore` in `src/lookalike-rule.ts` and `packages/workflow/moolam-verifier/lookalike-rule.ts`; `isValidLookalike` in the index | `lookalike-rule.test.ts` "keeps the two lookalike-rule.ts files byte for byte the same" and "never calls one of two passports in the same second earlier than the other"; workflow "L10: a candidate registered in the same second is not earlier"; `lookalike-presign.test.ts` "answers none for a look-alike registered in the very second the picture is being signed" |
| **L11 One pair of thresholds, both fingerprints.** 10 of 64 pHash bits and 40 of 256 block hash bits, from one file. A verdict matches only when both are inside, and a run whose own measurement misses the chain's stored fingerprints writes "does not match" and no look-alike | `LOOKALIKE_PHASH_BITS` and `LOOKALIKE_BLOCKHASH_BITS` in `lookalike-rule.ts`; `measureThumbnail` and `lookalikeStep` in `workflow.ts` | "L11: a stored block hash this run's picture misses writes does not match and no look-alike" and "L11: the match threshold in config must be the shared one"; `lookalike-rule.test.ts` "takes fingerprint.ts's thresholds, and so every match the service makes, from the shared constants" |
| **L12 Documents only by the pinned rule.** The earlier passport's document is fetched only as `ipfs://<cid>` through the gateway (one carried inline as a data address is read with no request), and one that cannot be read is reported as sealed, which shows no picture | `readSealed` in `workflow.ts`, through `pinnedFetchUrl` in `pinned.ts` | "L12: an earlier passport whose document says sealed, or cannot be read, is reported sealed" |
| **L13 and L14 A refused write is a failed run, and the catch-up covers both receivers.** A write the receiver refused is never logged as a success. Every ten minutes the catch-up reads both receivers' floors for each passport the backlog names and writes only what is missing | `writeTo` and `lookalikeStep` in `workflow.ts`; `onBacklogCron` | "L13: a refused look-alike write fails the run and names the verdict that landed", "L14: the backlog writes only the receiver whose floor is missing" and "L14: a passport with both floors at or after activation is left alone" |
| **L15 Bounded spend.** Each run fits Chainlink's 15 HTTP calls and 15 contract reads; the catch-up takes at most 7 passports a run; the catch-up's look-alike writes are capped by day (1,000 by default), and 0 turns either off. A new registration's own run writes its verdict and at most one look-alike report, and that path has no daily cap | `Budget` and `lookalikeWritesThisRun` in `lookalike.ts`; `backlogPerRun` and `lookalikesPerDay` in the workflow's config schema | "L15: the read budget holds at 15 HTTP calls and 15 reads with seven passports all missing", "L15: the off switches" and "L15: the daily ceiling spreads over the day's 144 runs and never exceeds it" |
| **L16 The routes are pure functions, shape-checked first.** Candidates: at most eight fingerprint pairs and an `asOf` no more than 60 seconds ahead; at most three ids, registered strictly before `asOf`, the earliest always first. An index not loaded through `asOf` answers "not ready" with no list. Two nodes asking with the same `asOf` get the same bytes | `lookalikeRoutes` in `src/routes/lookalikes.ts` | `lookalike-routes.test.ts`, the "L16" tests, including "answers two asks with the same asOf in the same bytes, whoever asks" and "answers not-ready, with no list, while the index is not loaded through asOf" |
| **L17 Silence is never "none".** Any status but 200, any body off the schema, "not ready", a list too long or an id in any other form is "no answer", and the run writes nothing | `readServiceAnswer` in `packages/workflow/moolam-verifier/lookalike.ts` | the "L17" tests in `workflow.test.ts`, including "a non-200 or malformed candidates answer writes nothing and fails the run" |
| **L18 Reads a stranger can start are bounded.** Both routes sit under the service's 60 a minute per address and a ceiling of their own for everyone (600 and 120 a minute), and neither reads the chain, Pinata or the gateway while a request waits | `ceiling` and `lookalikeRoutes` in `src/routes/lookalikes.ts` | "L18: reads no document, block or log while a request waits", "meets the service's 60 a minute per address on the 61st ask" and "refuses everyone past each route's own ceiling for the minute" |
| **L19 The warning is a read that succeeded, or it says it could not check.** Four answers: an earlier passport by someone else, the person's own earlier one, none as of the time the index was current to, or could not check. The studio never shows nothing | `lookalikeBeforeSigning` in `src/lookalike/presign.ts`, called by `/prepare` and `/platform/prepare` | `lookalike-presign.test.ts` "answers none with the second the index was current to, and reads no wallet or title" and "answers unchecked for a stale index, fingerprints that could not be taken, or wallets that failed or never came" |
| **L20 A stranger's title is text.** It reaches a studio or a platform's server only as one printable line of at most 120 code points, the id only by the passport id pattern, the date only from the chain | `lookalikeBeforeSigning` and its title reader in `src/lookalike/presign.ts` | "cuts a hostile title to one printable line of at most 120 code points" and "sends the id by the one passport id pattern, lower-cased, and the date from the chain record" |
| **L21 and L25 The registrant's own words stay theirs.** The sworn line, a platform's statement, `seenEarlier` and the web pages are pinned only in their exact shape, and drawn as the registrant's statement, never as a chain fact. `seenEarlier` becomes a link only when it is a passport id. A document with neither the sworn line nor a platform's statement reads "Registered outside Moolam's studio: no sworn statement, no web check." | `registrantStatements` in `src/statements.ts`; `seenEarlierLink` and `registeredOutside` in `packages/web/components/mark/strength.ts` | `sworn-documents.test.ts` "gives every studio and co-sign document the sworn line and every platform document at most the platform's words, never both"; web `marks.test.ts` "links seenEarlier only when it is a passport id, and draws anything else as text" and "says outside the studio for a document with no sworn line and no platform statement" |
| **L22 One rule decides what goes to Google.** A studio upload, kind Captured, not sealed, not a platform's, not generated. Only its 512 pixel public thumbnail is sent, after the sign-in and the day's ceiling, with the key in a header and never in an address, redirects refused, and ten seconds to answer | `sendsToWeb` and `webCheck` in `src/webcheck/check.ts`; `visionDetector` in `src/webcheck/vision.ts` | `web-check.test.ts` "sends only a studio upload of a captured picture that is not sealed, not a platform's and not generated", "sends a public upload's published thumbnail once, and never a sealed picture", "puts the key in the x-goog-api-key header, never in the address, and refuses redirects" and "gives up on Vision after ten seconds, aborts the call and answers silent" |
| **L23 Google's answer is checked like an input, and its absence means nothing.** Pages are kept only as http or https with a host, no query or fragment, at most 10 of at most 256 characters, drawn as text. Zero hits, a failure and a timeout all record nothing, and no screen says "not found online" | `pageAddress` in `src/webcheck/vision.ts`; `webCheck` answers `silent` | "keeps only http and https pages with a host, without query, fragment or credentials, at most 256 characters", "answers silent and records nothing for zero hits or a failed call"; web "lists the web pages as text, never as links, with the count as stored" |
| **L24 Vision's spend is capped and its key stays out of every log.** 300 checks a day by default, 0 as the off switch | `VISION_CHECKS_PER_DAY` in `src/env.ts`; `safeReason` on every failure | "stops sending once VISION_CHECKS_PER_DAY is spent for the day, read from the environment" and "never writes the key into a log line or an answer, whatever Vision or the network says" |
| **L26 One signature, one answer, one open dispute.** The holder signs EIP-712 `ChallengeAnswer` over the passport, the dispute's `openedAt` and challenger, the sha256 of the text and a deadline. The service reads the dispute and `ownerOf` at one block, and accepts only while the dispute is open and within 14 days of `openedAt` by chain time. A plain wallet signature only; a used signature is refused | `challengeRoutes` in `src/routes/challenges.ts`; `answerDigest` and `ANSWER_WINDOW_SECONDS` in `src/challenges/answer.ts` | `challenge-answer.test.ts` "refuses a signature that binds another text, passport, dispute, challenger or deadline", "accepts until fourteen days after openedAt by chain time, and not a second later" and "takes only a plain 65 byte wallet signature: a compact, a high-s or a contract wallet's signature is refused" |
| **L27 The answer is bounded and shown only beside its dispute.** At most 4,000 bytes of printable text whose only control character is the line break, one answer per dispute, pinned as a document that names the passport, `openedAt`, the challenger and the holder | `answerTextProblem` and `answerDocument` in `src/challenges/answer.ts`; the read route in `src/routes/challenges.ts` | "refuses text over 4,000 bytes, empty, with any control character but the line break, or with direction characters, before any chain read", "refuses a reused signature and a second answer to the same dispute" and "shows an answer only beside the dispute it was given for"; web `challenges.test.ts` "refuses an answer for another dispute, passport, registry or chain, or whose hash or signer is wrong" |
| **L28 The reasons belong to the decision they explain.** `publish` takes the resolver from the policy and the outcome and `openedAt` from the registry at call time, so the caller supplies neither, accepts only an `ipfs://` content id of at most 128 bytes, and only once per dispute. The reasons route pins only for a signature by the policy's resolver over that very outcome. A page shows reasons only when the published outcome is the registry's | `MoolamDecisions.publish`; `decisionRoutes` in `src/routes/decisions.ts`; `decisionView` in `packages/web/lib/disputes/decisions.ts` | `MoolamDecisions.t.sol` test_publishByAnyoneButTheResolverIsRefused, test_theResolverIsReadAtCallTime, test_publishOnAnOpenOrNeverFlaggedDisputeIsRefused, test_aMalformedOrTooLongReasonsAddressIsRefused and test_aSecondPublishForTheSameDisputeIsRefused; `decision-reasons.test.ts` "refuses a stranger's signature, and the resolver's signature over other words or the other outcome"; web `challenges.test.ts` "drops a published decision whose outcome disagrees with the registry" |
| **L29 A stranger's address is a link only as `ipfs://<cid>`.** The challenger's evidence and the resolver's reasons are followed only as a bare content id through the gateway; anything else is printed as text | `pinnedLink` in `packages/web/lib/disputes/evidence.ts` | web `challenges.test.ts` "holds the pinned rule to ipfs:// and a content id, nothing else" and "draws an https address as text with no link" |
| **L30 One function issues the mark, worst first.** The site and the MCP server share it byte for byte. A simulator verdict never lights "Checked by Chainlink" or "Does not match" | `issueMark` in `packages/web/components/mark/mark.ts`, the same file as `src/mcp/mark.ts` | web `marks.test.ts` "names the eight marks in the order the design ranks them" and "never lets a simulator verdict light Checked by Chainlink or Does not match"; `mark-copy.test.ts` "keeps the two mark.ts files byte for byte the same" |
| **L31 "None" is not "original".** A network record with no earlier passport reads "Chainlink found no earlier look-alike among the candidates Moolam's search proposed." | the `lookalike.none` words in `packages/web/messages/en.json` | web `marks.test.ts` "words a network record with no earlier passport exactly as the threat model asks, and never as original" |
| **L32 The mark is a read.** A fact that could make the mark worse and could not be read gives no mark and a line that says so | `issueMark`'s `unread` state | web `marks.test.ts` "says the mark could not be read when the registry did not answer, and presses no stamp" |

The rules across all of it:

- **One rule, not a list.** "Earlier" is one function over the registry's `registeredAt`. "The
  network's" is one rule over the transaction and the event. What goes to Google is one predicate. The
  mark is one function. What they do not cover: the network itself writing a wrong record, and who
  made a picture.
- **Compare after the same parser.** Passport ids are lowercased by one function everywhere, creators
  are compared after one normaliser, and the thresholds come from one file the service and the
  workflow both keep.
- **Fail closed.** No candidate without this run's own measurement, no record without two passports
  in order, no mark on a tie, "could not check" instead of silence, "not ready" instead of a partial
  list, no answer outside an open dispute, and a refused write is a failed run.
- **The bond.** A rejected challenge's bond is credited to the policy's treasury, and since 2026-10-02
  at 07:27 UTC the treasury is the burn address 0x000000000000000000000000000000000000dEaD (change id
  `0x87571be2e5c590b8fa1e9f2921d8a3807c8e210f216c32fbc1f29b069030f3a0`, executed in
  [`0x45700954...`](https://monadvision.com/tx/0x457009544b51c256c130534b76cd7c3052e3f8299984b54d78037d21fb5d371d),
  block 109,834,440). Before that the treasury was the deployer
  0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c. Rejected bonds are burned.

## What the screens promise

Three rules for what the web app draws and serves. The first two were added after the code review
of 2026-09-26, and the third after the one of 2026-09-28. All three hold for every visitor, whatever
a registrant wrote into their document.

| Invariant | Held by | What proves it |
| --- | --- | --- |
| **Pictures are pinned.** Every picture address a screen draws is accepted only as `ipfs://<cid>`, or as the same file named on Moolam's own gateway, and is resolved through Moolam's gateway. A document address is held to the same rule before it is fetched. Anything else gets the seal plate, so a passport registered straight on chain cannot send a visitor's browser to a host its registrant chose | `packages/web/components/passport/art.ts`, `pinnedUri`, called by `readArt` for the document and by `pictureUri` for the image and thumbnail, and by the unseal record's two readers and the account's grid. The film reads its own pictures through `pictureFor` in `components/story/data.ts`, which takes `ipfs://` only | `test/pinned-pictures.test.ts`: other hosts, plain http, a query string, a look-alike host, dot segments, `data:` and `javascript:` refused; an https picture drawn as the seal plate; a document off IPFS never fetched. The census of 2026-09-26 read all 41 passports: every picture is `ipfs://<cid>`, and the 3 documents stored as `data:` name none. An unsealed picture's address, which comes from Moolam's own unseal record, is held to the same `pinnedUri` on the server (`lib/data/unseal.ts`) and on the verify answer (`components/verify/lookup.ts`), and so are the document and the thumbnail the account's own grid reads in the browser (`lib/studio/useCreatorPassports.ts`): `review-fixes.test.ts` step 7, where `https://tracker.example/x.png` gives no thumbnail and no request |
| **Status is read.** Every status word on a screen is bound to a read that succeeded in that render, and a failed read is said in words on the same screen | `packages/web/components/home/Board.tsx`: `Evidence` draws the live mark only when the record and the copy were both read, and `Loose` draws no mark and says the passport could not be read. The reads come from `firstScreenData` in `components/home/read.ts`, where every one is either a reading or the reason it failed | `test/first-screen-dead-rpc.test.ts`, with the app's chain client pointed at a port nothing answers on: the line shows, the mark does not, the reason is kept. `test/first-screen-home.test.ts` for a copy or a statement that could not be read. Not covered: the rule is tested on the home page's first screen only |
| **Downloads are the pinned file.** A download serves only a public or unsealed passport's picture, named as a bare IPFS id by the passport's own document or by Moolam's unseal record. It is fetched through Moolam's gateway with redirects refused and a size cap, and typed by the file's own first bytes. A sealed or unknown passport answers 404 and the gateway is never asked. The link shows only where the route can serve it | `packages/web/app/api/passports/[id]/picture/route.ts` and `lib/passport/original.ts`; `readArt` in `components/passport/art.ts` sets the link only when the route's own `bareContentId` accepts the picture | `test/picture-download.test.ts`: a sealed passport answers 404 with no gateway request, as do an unknown id and a picture that is not a bare id, a document at an ordinary web address is never read, and the extension comes from the first bytes. `test/download-guards.test.ts`: no link for a picture the route would refuse, and no stale length on an encoded answer. On 2026-09-27 three live downloads hashed to their passport ids. Not covered: an unseal record that names `ipfs://<cid>/<path>` would show a link that answers 404; none exists on chain today |

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
  from a plain key in its host environment, so a compromised host could post feedback in its name. A
  platform in the kit signs the same way, from its server: a platform-mode passport is a single-party
  attestation, one company holding the agent's key and the key bound to its creator wallet, and every
  word Moolam shows for it says so. The chain cannot tell that key from any other passkey.
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
- **Moolam vouches for keys, not companies.** A platform on the list proved it holds the agent's
  owner key and its creator wallet. Moolam does not check who the company is, or that its generator
  made what it says it made.
- **A platform's picture can be registered first by someone else.** In platform mode the platform
  holds Moolam's signed file before it sends `register`. In co-sign mode the files are pinned to public
  IPFS when the agent signs, and stay there unregistered until the person signs, up to 30 minutes.
  Whoever registers those bytes first holds the passport, as with every picture here. The prepare
  refuses a picture already registered, and the status route says `failed` when another passport took
  the id.
- **A tap proves a key signed, not that a person understood.** The co-sign page shows the picture,
  the agent and the terms before the prompt; it cannot make anyone read them.
- **Hand-overs are the platform's promise.** Nothing makes a platform transfer a passport it
  promised, and a correctly typed wrong address is still an address. `transferPassport` refuses
  only what it can check.
- **An agent's owner can change after onboarding.** Prepares follow the owner read at that moment,
  and `get_agent` says when the owner is no longer the one that signed the entry. A passport already
  registered keeps its label, because the label is judged on the fields the chain recorded then.
- **Look-alike names.** The name check folds case and Unicode forms, not look-alike letters from two
  scripts. The label always sits beside the wallet and the agent id for that reason.
- **The platform's own keys.** Its Moolam key, agent key, passkey and wallet, and its copy of the
  package, are its to keep. A leaked Moolam key alone makes no manifest; a leaked agent key makes
  pictures in the agent's name until the agent token moves.
- **The MCP server cannot tell one Claude user from another.** It has no sign-in, and Claude calls
  from Anthropic's cloud, so every Claude user shares one address and one rate count. The count is
  kept per process.
- **Rules outside Moolam.** Privy's sponsorship rules and credit balance bound what co-sign mode can
  spend, and Anthropic decides where Claude's calls come from.
- **A platform's own email check is the platform's.** Moolam does not check that the address a
  platform sends belongs to the person who made the picture. It checks only that the Moolam user who
  sees the offer proved that address to Privy, and it shows the platform's `verifiedBy` as the
  platform's claim. A platform that sends the wrong address hands the offer to that address's owner,
  who can accept and confirm it. Whoever confirms a picture they did not make has signed a public
  statement, and Moolam records it.
- **Gmail dots and plus tags are not folded.** `r.am@gmail.com`, `ram@gmail.com` and
  `ram+art@gmail.com` are three addresses here, and a googlemail.com address is a fourth. Folding them
  is one provider's rule, and a list of providers' rules misses the next provider. An offer sent to a
  spelling the person never verified with Privy is never shown to them, and expires after 180 days.
- **A new pepper ends what waits under the old one.** Raising `CLAIM_PEPPER_VERSION` expires every
  pending and open ticket written under the old pepper at the next sweep. Accepted tickets keep their
  destination and are still delivered. Standing choices, mutes and the per-address ticket counts made
  under the old pepper stop matching, so a person has to choose again, and a platform they said no to
  can offer again.
- **Losing the email account.** Offers match the addresses in the person's Privy record, not live
  access to the inbox. A person who loses the inbox but can still sign in to Moolam another way, a
  passkey or a second linked account, still sees and answers their offers, and keeps every passport
  already in their wallet with its credit. A person who can no longer sign in at all cannot accept:
  their offers expire after 180 days and the passports stay in the platform's wallet, read as held.
  Moolam has no recovery path of its own; account recovery is Privy's. Whoever takes over the inbox
  can sign in with a code sent to it, and so can see and accept what waits for that address.
- **A platform can credit its own second wallet.** A platform that hands a passport to another wallet
  it controls and writes terms from it reads as confirmed for that wallet. Nothing on chain tells a
  platform's second wallet from a person's.
- **Pictures are not moderated.** A person can say "Not mine" and stop a platform's offers, and a key
  that collects too many refusals stops writing tickets. Moolam does not judge what a title or a
  picture shows.
- **A look-alike mark proves order, not authorship.** "Registered after a look-alike" says which
  passport came first. A thief who registers a picture before its maker does is marked as the
  earlier one, and the maker's later passport carries the mark. The challenge is the remedy.
- **"None found" rests on Moolam's search.** The network only proves what the verify service
  proposes. A service that is down, behind, or that leaves a candidate out makes the run write
  "none", which the site words as none among the candidates Moolam's search proposed, never as
  original. A search that gives no answer at all writes nothing.
- **Crafted fingerprints, and an open search.** Someone who knows the algorithms can craft a picture
  that lands near another's fingerprints, and the public candidates route tells them how near they
  are. Nothing here defends against that.
- **Registering straight on chain skips the checks.** A passport registered without Moolam's studio
  or the kit has no warning, no sworn line and no web check. The page says so in those words, and
  that is all Moolam can say.
- **The web check answers one narrow question.** It says whether Google found the picture on the web
  when Moolam looked, nothing about who posted it first. It sends a public camera picture's 512
  pixel thumbnail to Google before the person signs, which the studio says beside the upload. When
  it finds nothing, fails or times out, nothing is recorded, so its absence proves nothing.
- **Only originals are compared.** A passport registered as an edit skips the look-alike step, so a
  copy registered as an edit of the copier's own earlier passport is not marked by it.
- **Two passports in the same second are never ordered.** Monad seals more than one block a second
  and `registeredAt` counts whole seconds, so neither of two same-second registrations is ever
  marked as the later one.
- **The verdict receiver has no ceiling on time and still has an owner.** `MoolamReceiver`
  (0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04) cannot change, and it refuses no `executedAt` for
  being far in the future. A clock fault in the workflow could set a floor no later run passes and
  freeze that passport's verdict there; the fix would be a new receiver. Its owner, the deployer key,
  can re-point it in one transaction with no delay, to another forwarder, author or workflow name.
  A workflow it is re-pointed to still writes through Chainlink's forwarder, so the rule in L4
  counts its verdicts as the network's: the site cannot tell them apart. Each re-point is a public
  transaction on the receiver.
- **The workflow's code can change without touching either receiver.** Both pin Moolam's Chainlink
  account (0xf072a8c620bfc818875736e3f2d3a2a339c06584) and the workflow name, not one workflow id,
  so a new version of moolam-verifier deployed from that account writes at once. The code is this
  repository's, and every deploy is recorded in Chainlink's workflow registry. `MoolamLookalikes`
  has no owner and no clock problem.
- **The network's spend is bounded by caps, not by who caused it.** Each junk registration costs
  the network one verdict and at most one look-alike report through its own run, with no daily cap
  on that path; the caps in L15 bound only the catch-up.
- **Chainlink's nodes see every public thumbnail they check,** as they always have.
- **One resolver decides.** Moolam decides challenges today, through one address the policy names.
  The written rules, the holder's answer and the published reasons make each decision checkable; they
  do not make it a court's. The holder's answer and the resolver's reasons are their authors' words,
  and Moolam bounds their bytes and judges nothing else.
- **A holder in a contract wallet cannot answer.** The answer route takes only a plain wallet
  signature, so a passport held by a smart account has no way to answer a challenge here.
- **A quick re-flag can strand a decision's reasons.** A rejected passport can be flagged again at
  once, and the registry then holds the new dispute. Reasons for the earlier decision that were not
  yet published can no longer be published through `MoolamDecisions`, because it reads the dispute
  the registry holds now.
- **A burned bond is gone for good.** Since the treasury was set to the burn address on 2026-10-02,
  a rejected challenge's bond is credited to an address nobody holds a key for. The registry credits
  bonds rather than sending them, so nothing reaches that address and nothing can be withdrawn from it.
- **Self-audited.** No third party has audited these contracts. The attack
  scripts and their outputs are the evidence, and they are in this repo.
