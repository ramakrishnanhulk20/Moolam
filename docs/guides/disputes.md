---
title: Disputes
---

# Disputes

A passport is a permanent record, and permanent records need a way to be argued with that does not
involve deleting them. Moolam's answer is a bonded challenge: anyone can flag a record, it costs
them money to be wrong, and the outcome is written next to the record rather than replacing it.

No dispute has been filed on Monad mainnet yet. Everything below is the deployed code and its test
coverage, not a recorded event.

## Who can flag

Anyone with an address and the bond. There is no allow list, no reputation gate and no role.

```solidity
function flag(bytes32 passportId, string calldata evidenceURI) external payable
```

The call refuses in five cases, each with its own error: the registry is paused
(`EnforcedPause`), no record exists for that id (`PassportNotFound`), a challenge is already open
(`DisputeAlreadyOpen`), a previous challenge was upheld (`PassportAlreadyDisputed`), or the value
sent is not exactly the bond (`InvalidBond`).

A passport whose challenge was upheld cannot be flagged a second time; the record already says what
it needs to say. One whose challenge was rejected can be flagged again with new evidence.

Only the keccak256 of `evidenceURI` is stored, not the URI itself, so what a challenger pointed at
cannot be quietly swapped for something else afterwards.

## The bond

`msg.value` has to be exactly `VerifierPolicy.disputeBond()`, which this deployment set to 1 MON.
Not more, not less. An amount that does not match reverts, rather than being partly accepted or
refunded.

The bond sits in the registry and is never sent anywhere until the dispute is settled, so opening a
challenge costs an honest challenger nothing but gas. The registry keeps a running `totalBonds`, and
`rescueNative` computes what the owner may sweep as `balance - totalBonds - totalOwed`, so an open
bond can never be swept out from under a live dispute.

Flagging costs 172,939 gas at the median, including the bond going into escrow.

## The resolver

```solidity
function resolve(bytes32 passportId, bool upheld) external
```

Only the address `VerifierPolicy.resolver()` names may call it. Anyone else reverts `NotResolver`,
and a passport with no open challenge reverts `NoOpenDispute`.

The resolver is a single address held in the policy contract, and changing it goes through the
policy's 24 hour timelock, in the open, so anyone watching can react before it takes effect. That
is the honest shape of it: dispute resolution here is one named party, not a court and not a vote.
Whether that party is a person, a multisig or a committee is a deployment choice, and the timelock
is what stops it being changed quietly.

Two outcomes:

- **Upheld.** The passport is marked disputed, permanently, and the bond is credited back to the
  challenger. The record itself is not edited or removed, because nothing in this registry ever is.
- **Rejected.** The record stands, and the bond is credited to `VerifierPolicy.treasury()`.

## Pull payments

`resolve` records a credit and never sends native token. Whoever is owed calls `withdraw()`
themselves, or `withdrawTo(address)` to name where it goes.

That is deliberate. A resolver that pushed money could be blocked by a challenger or a treasury that
refuses a transfer, which would jam dispute resolution for everybody. Recording a credit cannot
fail, so it never can.

Three properties hold around it. The caller's balance is zeroed before anything is sent, so the
reentrancy guard is a second line rather than the only one. Nobody can spend anyone else's credit:
the amount is always the caller's own. And both functions keep working while the registry is paused,
so a pause can never trap someone's money.

`withdrawTo` exists for a credited address that cannot receive native token itself, such as a
treasury contract with no payable path. It is the actual escape hatch behind the policy's treasury
probe.

The money rules are attacked in `npm run prove`: flag with no bond, settle a dispute without being
the resolver, and withdraw with nothing owed. The live contract answers `InvalidBond`, `NotResolver`
and `NothingToWithdraw`. The output is in
[dispute-money-rules.txt](../security/attacks/dispute-money-rules.txt).

## What the passport page shows

A passport nobody has challenged shows nothing about disputes at all. An empty dispute box on every
page would read like an accusation.

While one exists, a block headed "Challenged" appears above the lineage, with one line explaining
it: "Someone put a bond behind a claim that this record is wrong. The bond is held by the registry
until the dispute is settled."

| Field | What it shows |
| --- | --- |
| The status | "Open, and not yet settled", "Upheld: the challenge was right", or "Rejected: the record stands" |
| "Challenger" | The address that flagged it, linked to MonadVision |
| "Bond" | The bond in MON |
| "Opened" | The block timestamp on the dispute |
| "Evidence hash" | The keccak256 of the evidence URI, in full |

The poster at the top of the page changes too. A dispute outranks every other standing, so the word
over the title reads "Disputed" whatever the re-checks said.

## What a dispute does not do

It does not remove the record, and it does not stop the image being verifiable. A disputed passport
still answers a verify query, still carries its attestations, and still shows every edit registered
from it. What changes is the one word the page leads with, and that word is permanent once a
challenge is upheld.

The function signatures, every revert and the events are in [Registry](../api/registry). What the
policy contract can and cannot change is in [Security overview](../security/overview).
