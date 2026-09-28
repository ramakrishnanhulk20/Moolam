---
title: Audits
---

# Audits

**No third party has audited these contracts.** Moolam is self-audited. The evidence is the attack
scripts and the outputs they wrote, and both are in this repository. Read this page as what was
checked and by whom, not as an assurance.

## What was checked

| Check | Result |
| --- | --- |
| `forge build` | Zero warnings |
| 182 Foundry tests across eleven suites | All pass. Unit, fuzz, invariant and mainnet fork |
| Twelve invariants over 256 runs and 8,192 calls each | All held, zero reverts |
| `forge coverage` on `src/MoolamConsent.sol` | 100 percent of lines, statements, branches and functions |
| `slither . --exclude-informational --exclude-low --exclude-dependencies` | Zero high, four medium |
| `solhint` on `src/**` | No errors, no warnings |
| Twelve attacks, executed, eight of them as mainnet transactions | 12 of 12 refused |
| Eight more against the consent register, executed as simulations | 8 of 8 refused, with the control passing |

The four medium slither findings are accepted false positives: an append-only mapping of arrays,
two plain zero checks, and one `tryRecover` whose error return is unused. The `arbitrary-send-eth`
on `_payOut` is suppressed inline with its reason, because the destination is chosen by the caller
on purpose and that is the whole point of `withdrawTo`. What bounds it is the amount: `_takeCredit`
has already zeroed the caller's own balance, so the only money that can leave is money that caller
was owed.

Four findings name `MoolamConsent` or its interface and none of them stand. `uninitialized-state` on
`_history` is the same false positive as the registry's `_attestations`: a mapping of arrays needs no
initialiser. `calls-loop` on `_holderOf` reached from `setConsentBatch` is deliberate and is the
point of the design, because authority is read fresh from the registry for every passport rather
than assumed from the one before it, and `MAX_BATCH` caps how many times that can happen in one
transaction. `timestamp` on the ten minute rule is a comparison against `block.timestamp`, which is
what the rule is. `naming-convention` on `STANDARD`, `REGISTRY`, `MIN_INTERVAL`, `MAX_INFO_BYTES`,
`MAX_PAGE` and `MAX_BATCH` is Solidity's own convention for a constant and an immutable, and the
interface has to declare them with the same names so the generated getters match. Nothing else in
the run mentions the contract, which is what a contract with one view call, no money and no owner
should look like.

`src/vendor/` is excluded from both linters. Chainlink's `ReceiverTemplate` is vendored verbatim
with its own license header and floating pragma, so its style is Chainlink's to set.

The full outputs are committed in `proofs/` at the root of the repository:
[slither.txt](../../proofs/slither.txt) with every finding triaged underneath,
[solhint.txt](../../proofs/solhint.txt), [gas.txt](../../proofs/gas.txt) and
[fork-tests.txt](../../proofs/fork-tests.txt). The rest of the folder is listed in
[Prove it](../developers/prove-it). The attack transcripts below are the exception: they live here
in the docs site because these pages link to them.

## The twelve attack outputs

Each file is the whole attempt: what was tried, what the live contract or the live service
answered, and the transaction hash where there is one. Nothing in them is written by hand. They are
rewritten every time `npm run prove` runs. Four more, against the consent register, are listed under
them and are run differently.

| Attack | What it tries | What refuses it | Output |
| --- | --- | --- | --- |
| passkey-replay | Take the creator's WebAuthn assertion off a real passport and use it on a second passport with a different image hash | `InvalidPasskeySignature` | [passkey-replay.txt](attacks/passkey-replay.txt) |
| generator-signature-forged | Sign as the generator agent with a wallet that does not own its ERC-8004 identity | `InvalidGeneratorSignature` | [generator-signature-forged.txt](attacks/generator-signature-forged.txt) |
| unknown-agent | Claim an agent id nobody registered | `UnknownAgent` | [unknown-agent.txt](attacks/unknown-agent.txt) |
| expired-deadline | Use two perfectly valid signatures a minute after their deadline | `SignatureExpired` | [expired-deadline.txt](attacks/expired-deadline.txt) |
| edit-by-non-owner | Hang an edit off a passport somebody else holds | `NotParentOwner` | [edit-by-non-owner.txt](attacks/edit-by-non-owner.txt) |
| attest-from-stranger | Write a verification result straight into the registry from an unlisted wallet | `NotReceiver` | [attest-from-stranger.txt](attacks/attest-from-stranger.txt) |
| report-from-fake-forwarder | Hand the receiver a well formed Chainlink report from the wrong sender | `InvalidSender`, from Chainlink's own `ReceiverTemplate` | [report-from-fake-forwarder.txt](attacks/report-from-fake-forwarder.txt) |
| receiver-replay-and-wrong-chain | Deliver the same report twice, an older one, and one built for another chain | `StaleReport` and `WrongChain` | [receiver-replay-and-wrong-chain.txt](attacks/receiver-replay-and-wrong-chain.txt) |
| privy-policy-refusal | Ask the generator agent's server wallet to send MON, and to call a function its policy does not name | Privy's enclave answers `policy_violation` | [privy-policy-refusal.txt](attacks/privy-policy-refusal.txt) |
| revoked-session-signer | Sign an edit with the app's session key after the creator took the permission back | Privy refuses the key | [revoked-session-signer.txt](attacks/revoked-session-signer.txt) |
| dispute-money-rules | Flag with no bond, settle a dispute without being the resolver, withdraw with nothing owed | `InvalidBond`, `NotResolver`, `NothingToWithdraw` | [dispute-money-rules.txt](attacks/dispute-money-rules.txt) |
| verifier-api-limits | A 25 MB upload, a text file dressed as an image, a URL pointing back at 127.0.0.1, and 61 requests in a minute | 413, 400, 403, 429 | [verifier-api-limits.txt](attacks/verifier-api-limits.txt) |

Every on-chain attack runs twice. First as a read against the deployed contract, which is how the
exact custom error is decoded. Then as a real transaction with the same gas limit, so the refusal
is on Monad mainnet where anyone can open it in the explorer. Using the same gas limit for both is
what rules out a revert that is really an out-of-gas.

### Four more, against the consent register

These are `cast call` simulations rather than transactions, run by hand on 2026-09-21 against the
live contract at `0x1151E69a82947920546e779c4C8c785b2a3C1277`. A simulation runs the same bytecode
the same way and is how the exact custom error is decoded, but nothing here can be opened in the
explorer. They are reads only on purpose: writing the control would put a real statement on a real
passport and change what the demo shows. The whole session, with every command as it was typed and
a valid statement from the real holder as the control that passes, is in
[consent-attacks.txt](../../proofs/consent-attacks.txt).

| Attack | What it tries | What refuses it | Output |
| --- | --- | --- | --- |
| consent-from-stranger | Say how AI may use a picture somebody else holds | `NotPassportHolder` | [consent-from-stranger.txt](attacks/consent-from-stranger.txt) |
| consent-text-rules | Conditions with nothing to read, a conditions text carrying a newline, and one of 257 bytes | `ConstraintInfoRequired`, `ConstraintInfoNotPrintable`, `ConstraintInfoTooLong` | [consent-text-rules.txt](attacks/consent-text-rules.txt) |
| consent-batch-limits | A batch of 33 passports, and a batch of none | `BatchTooLarge`, `EmptyBatch` | [consent-batch-limits.txt](attacks/consent-batch-limits.txt) |
| consent-no-money | Send MON to the consent register | An empty revert. No `receive`, no `fallback`, nothing payable | [consent-no-money.txt](attacks/consent-no-money.txt) |

Four of the twelve are not mainnet transactions, and the files say so.
`receiver-replay-and-wrong-chain` sits behind the sending-wallet check, so only a transaction
signed by Moolam's CRE wallet can reach it, and Foundry tests plus a mainnet fork test prove it
instead. `privy-policy-refusal` and `revoked-session-signer` are refused by Privy's enclave before
anything is signed, so no transaction reaches Monad at all, which is the point.
`verifier-api-limits` is refused over HTTP by the verify service's own limits.

The three receiver files were written again on 2026-09-28 by `npm run prove:receivers`, against
the SimulationReceiver today's re-checks land through.

## Verified source

Every contract below is verified on MonadVision through Sourcify, so the deployed bytecode can be
read against the source in this repository:

- [MoolamRegistry](https://monadvision.com/address/0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0)
- [VerifierPolicy](https://monadvision.com/address/0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821)
- [SimulationReceiver, public](https://monadvision.com/address/0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95), listed in the policy since 2026-09-27 14:18 UTC
- [SimulationReceiver, sealed](https://monadvision.com/address/0x52b8fE549B432920eeB061c26cAc5c2D527657f6), listed in the policy since 2026-09-27 14:18 UTC
- [MoolamReceiver](https://monadvision.com/address/0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04) (retired 2026-09-26), off the policy with its history kept
- [MoolamConsent](https://monadvision.com/address/0x1151E69a82947920546e779c4C8c785b2a3C1277)

## What this does not cover

An attack nobody thought of. The list is the [threat model](threat-model), written by the people
who built the thing. The two known holes are stated there rather than here: a crop of more than a
few percent breaks the fingerprints, and a passport proves who registered first, not who created.
