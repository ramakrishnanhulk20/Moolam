---
title: Audits
sidebar_label: Audits
sidebar_position: 3
---

# Audits

**No third party has audited these contracts.** Moolam is self-audited. The evidence is the attack
scripts and the outputs they wrote, and both are in this repository. Read this page as what was
checked and by whom, not as an assurance.

## What was checked

| Check | Result |
| --- | --- |
| `forge build` | Zero warnings |
| 119 Foundry tests across six files | All pass. Unit, fuzz, invariant and mainnet fork |
| Six invariants over 256 runs and 8,192 calls | All held, zero reverts |
| `slither . --exclude-informational --exclude-low --exclude-dependencies` | Zero high, four medium |
| `solhint` on `src/**` | No errors, no warnings |
| Twelve attacks, executed | 12 of 12 refused |

The four medium slither findings are accepted false positives: an append-only mapping of arrays,
two plain zero checks, and one `tryRecover` whose error return is unused. The `arbitrary-send-eth`
on `_payOut` is suppressed inline with its reason, because the destination is chosen by the caller
on purpose and that is the whole point of `withdrawTo`. What bounds it is the amount: `_takeCredit`
has already zeroed the caller's own balance, so the only money that can leave is money that caller
was owed.

`src/vendor/` is excluded from both linters. Chainlink's `ReceiverTemplate` is vendored verbatim
with its own license header and floating pragma, so its style is Chainlink's to set.

The full outputs are committed in `proofs/` at the root of the repository:
[slither.txt](../../../proofs/slither.txt) with every finding triaged underneath,
[solhint.txt](../../../proofs/solhint.txt), [gas.txt](../../../proofs/gas.txt) and
[fork-tests.txt](../../../proofs/fork-tests.txt). The rest of the folder is listed in
[Prove it](../developers/prove-it). The attack transcripts below are the exception: they live here
in the docs site because these pages link to them.

## The twelve attack outputs

Each file is the whole attempt: what was tried, what the live contract or the live service
answered, and the transaction hash where there is one. Nothing in them is written by hand. They are
rewritten every time `npm run prove` runs.

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

Two of the twelve are not mainnet transactions, and the files say so.
`receiver-replay-and-wrong-chain` sits behind the forwarder check, so only Chainlink's own
forwarder can reach it and three Foundry tests prove it instead. `privy-policy-refusal` and
`revoked-session-signer` are refused by Privy's enclave before anything is signed, so no
transaction reaches Monad at all, which is the point.

## Verified source

All three contracts are verified on MonadVision through Sourcify, so the deployed bytecode can be
read against the source in this repository:

- [MoolamRegistry](https://monadvision.com/address/0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0)
- [VerifierPolicy](https://monadvision.com/address/0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821)
- [MoolamReceiver](https://monadvision.com/address/0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04)

## What this does not cover

An attack nobody thought of. The list is the [threat model](threat-model), written by the people
who built the thing. The two known holes are stated there rather than here: a crop of more than a
few percent breaks the fingerprints, and a passport proves who registered first, not who created.
