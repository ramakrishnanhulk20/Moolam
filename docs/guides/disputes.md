---
title: Disputes
---

# Disputes

A passport is a permanent record, and permanent records need a way to be argued with that does not
involve deleting them. Moolam's answer is a bonded challenge: anyone can flag a record, it costs
them money to be wrong, and the outcome is written next to the record rather than replacing it.

No dispute has been filed on Monad mainnet yet. The screens below are live against the deployed
contracts, and what they would show is the deployed code and its test coverage rather than a
recorded event.

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

## What a challenge needs

The flag panel lists the rules before it asks for the bond, under "What a challenge needs":

1. "The earlier work: the picture you say this passport copies."
2. "Proof it existed or was shown earlier: a dated post, the camera's own file, or an earlier
   passport."
3. "A Verify answer that shows it is the same picture."
4. "That it is not a copy you licensed to them."

Then, set apart: "The challenger carries the burden. Without this evidence, the record stands."

A [Verify answer](verify-a-copy) names the first registration of any copy, and a passport that
Chainlink's network has marked "Registered after a look-alike" names its earlier passport on its own
page ([The trust mark](../concepts/trust-mark)). Either is a place to start. Registered first is not
the same as made first, so a challenge can be brought against either passport.

## The bond

`msg.value` has to be exactly `VerifierPolicy.disputeBond()`, which this deployment set to 1 MON.
Not more, not less. An amount that does not match reverts, rather than being partly accepted or
refunded.

The bond sits in the registry and is never sent anywhere until the dispute is settled, so opening a
challenge costs an honest challenger nothing but gas. The registry keeps a running `totalBonds`, and
`rescueNative` computes what the owner may sweep as `balance - totalBonds - totalOwed`, so an open
bond can never be swept out from under a live dispute.

A rejected challenge's bond is credited to the policy's treasury, and since 2026-10-02 the treasury is
the burn address 0x000000000000000000000000000000000000dEaD
([transaction 0x45700954…371d](https://monadvision.com/tx/0x457009544b51c256c130534b76cd7c3052e3f8299984b54d78037d21fb5d371d),
block 109,834,440, 07:27 UTC). A rejected bond is burned: it is credited to an address nobody holds a
key for, so nobody can ever withdraw it and Moolam gains nothing from a rejection.

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

The flag panel says it the same way, under "Who decides": "Moolam decides challenges today, by these
rules, and publishes every decision with its reasons. Moolam is one company, not a court." And: "The
decider is one address named on Monad. Changing it takes a public 24 hour wait." Below that it says
where a rejected bond goes, read from the policy as the panel opens: while the treasury is any other
address, "A rejected challenge's bond is credited to the treasury the policy names", with the
address; once the treasury is the burn address, as it is today, "A rejected challenge's bond is
burned, so Moolam gains nothing either way."

Two outcomes:

- **Upheld.** The passport is marked disputed, permanently, and the bond is credited back to the
  challenger. The record itself is not edited or removed, because nothing in this registry ever is.
  An edit registered from that picture is shown as disputed too, everywhere the app lists it, because
  the registry marks only the passport the challenge named and a copy of a picture proven fake is
  still a copy of a picture proven fake.
- **Rejected.** The record stands, and the bond is credited to `VerifierPolicy.treasury()`, which is
  the burn address, so nobody receives it. The treasury change is under [The bond](#the-bond).

## The holder's answer

The wallet that holds a challenged passport can answer in writing before the decision. The passport
page shows that wallet a form headed "Answer this challenge": "Someone has challenged your passport.
You have until {date} to answer before Moolam decides. Say why the record is right, and how someone
else could check it." My pictures lists every challenged picture the wallet holds, so the holder
does not have to go looking.

The rules, each checked by the verify service against Monad in the same call:

- **Fourteen days.** An answer is taken only while the challenge is open and within 14 days of the
  moment it was opened, measured by Monad's block time, not the holder's clock.
- **Only the holder.** The holder's wallet signs the answer as EIP-712 typed data in Moolam's domain,
  over the passport, the challenge's opening time and challenger, the sha256 of the text and a
  deadline. Signing costs no gas. The service reads `ownerOf` in the same call and refuses a
  signature from anyone else. Only a plain wallet signature counts, so a passport held by a smart
  account cannot answer here.
- **One answer per challenge.** A second answer, or a signature used before, is refused.
- **Plain text, line breaks allowed.** The form says: "Up to 4,000 bytes. Your wallet signs it, and it
  is pinned for good where anyone can read it." An answer can have paragraphs; every other control
  character, and the characters that flip the direction of text, are refused.

The answer is pinned to IPFS as one document naming the passport, the challenge, the challenger and
the holder, with the text, its hash, the deadline and the signature, so anyone can check it against
the chain and the holder's key without Moolam. The page shows it under "The holder's answer", with
"Signed by" and the holder's address, and only beside the challenge it answers. Until then it reads
"The holder has not answered yet. They have until {date}.", and after the 14 days "The holder did
not answer within the 14 days."

## Published decisions

Settling a challenge with `resolve` writes the outcome on Monad, but the registry has no field for
reasons and cannot change. So the reasons travel through a second contract,
[`MoolamDecisions`](https://monadvision.com/address/0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F)
(0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F, verified on Sourcify), in three steps:

1. **The resolver signs.** On the resolver console, the resolver writes the reasons, up to 8,000
   bytes with line breaks kept, and signs them with their wallet as EIP-712 typed data over the
   passport, the challenge's opening time, the outcome, the sha256 of the reasons and a deadline.
2. **The verify service pins them.** It reads, at one block, the resolver the policy names and the
   registry's record of the challenge, and pins only when the signature is that resolver's, the
   challenge is settled with that outcome and opening time, and its reasons are not yet published.
   The document names the passport, the challenge's opening time, the outcome and the resolver,
   with the reasons and their hash.
3. **`MoolamDecisions` publishes the address.** The resolver calls `publish(passportId, reasonsURI)`.
   The contract reads the resolver from the policy, and the outcome and opening time from the
   registry, at that moment, so the caller supplies neither. It takes only `ipfs://` and a content
   id, at most 128 bytes, once per challenge, and emits
   `DecisionPublished(passportId, openedAt, upheld, reasonsURI, resolver)`.

To read one, open the passport. Under "The decision" it says "Upheld on {date}. Moolam agreed with
the challenge." or "Rejected on {date}. The record stands.", with "Read the reasons" linking the
pinned document. The page links reasons only when the published outcome is the one the registry
holds, and only as an `ipfs://` content id. With none published it says "No reasons were published
with this decision." Without the page, read the `DecisionPublished` events of `MoolamDecisions` on
MonadVision for the passport id, and open the `reasonsURI` through any IPFS gateway.

One case the contract cannot cover: a rejected passport can be flagged again straight away, and the
registry then holds the new challenge, so reasons for the earlier decision that were not yet
published can no longer be published here.

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
| "The claim" | What the challenger typed, printed only when it can be proved to be theirs. See below |
| "Challenger" | The address that flagged it, linked to MonadVision |
| "Bond" | The bond in MON |
| "Opened" | The block timestamp on the dispute |
| "Evidence hash" | The keccak256 of the evidence URI, in full |
| The outcome | "Waiting for the dispute judge to decide." while it is open, then what the resolver did and where the bond went |

The claim is printed carefully. The words ride inside the transaction as a
`data:text/plain;charset=utf-8` URI, so they are public and permanent, but the chain stores only
their keccak256. The page reads the URI from the index, hashes it itself, and prints the words only
when that hash matches the one on the record. An evidence URI that points somewhere else instead of
carrying text says so: "The evidence for this challenge points somewhere else:".

The [trust mark](../concepts/trust-mark) at the top of the page changes too. While a challenge is
open the passport wears "Challenged", unless "Does not match" or "Registered after a look-alike"
already holds, since those rank above it. Once a challenge is upheld it wears "Challenge upheld",
which outranks every other state, for good.

## Flagging one from the page

Under the facts on a passport page, one line: "Dispute this passport". It opens in place rather than
leading anywhere, because a record nobody has challenged should not lead with an accusation.

Three readers never see it at all: anyone signed out, the wallet that holds the passport, which
cannot usefully dispute itself, and every reader of a passport that already has an open challenge,
because the registry refuses a second one.

Opened, it reads "Put a bond behind the claim" over what it costs: "A dispute costs a bond of 1 MON.
The resolver named by the policy settles it, and if they agree with you, the bond is credited back
to you." The rules and "Who decides" sit above it, with the line on where a rejected bond goes. The
bond and your own balance sit side by side, with
the one line that matters about money: "Moolam pays the network fee. It cannot pay the bond: that is
your own MON, and it leaves your account the moment this lands."

Type into "What is wrong with this record", between 20 and 500 characters. The hint says what becomes
of it: "It travels inside the transaction, so it is public and permanent." Then press "Flag with 1
MON".

Two steps: "Waiting for your account" while the transaction is put together and sent, then "Sending
the challenge" and "Waiting for Monad to show it". It finishes as "The challenge is on the record",
with the block, the transaction, and your bond under one line: "Held by the registry itself until the
dispute is settled. Nobody can move it."

The refusals are the contract's own, read back from the simulation rather than guessed:

| Message | What happened |
| --- | --- |
| "Your account is ... MON short of the bond. Moolam pays the network fee, but the bond has to be your own MON." | The balance was read before anything was sent |
| "The bond changed while this panel was open, so the registry refused this amount. It has been read again, so try once more." | `InvalidBond`. The policy's bond had moved |
| "Somebody has already challenged this passport, and the registry allows one open dispute at a time." | `DisputeAlreadyOpen` |
| "This passport is already marked disputed, so it cannot be challenged again." | `PassportAlreadyDisputed` |
| "New records and new challenges are paused on the registry right now." | `EnforcedPause` |
| "The window was closed before the transaction went out. Nothing was sent and nothing was spent." | You dismissed the wallet prompt |

## The resolver console

Every open challenge in one place, at `/resolve`. Anyone can read it. Only the address the policy
names can settle anything on it, and the page says so in its own lede.

It is in no menu and no sitemap, by design: it is a working screen for one address, not a page to
find by browsing.

The head of it names the resolver the policy holds today, with the rule underneath: "The policy
contract names one address, and changing it waits 24 hours in the open, so anyone watching can react
before it takes effect." A reader signed in as that address sees "You are the resolver". Anybody else
signed in is told plainly that the registry would refuse anything sent from there.

Each open dispute is one row: the picture and the title, the passport, the claim, the challenger, the
bond and when it was opened, then two buttons with what each one does written next to it. "Uphold
marks the record disputed for good and credits the bond back to the challenger." "Reject leaves the
record standing and credits the bond to the treasury, the burn address, so nobody receives it." Once
a decision lands, the row says "Rejected. The bond is credited to the treasury, the burn address, so
nobody receives it." With nothing open the page says "No challenge
is open. Nothing here is waiting on you."

The list comes from two places, each doing the thing only it can. The index answers which disputes
are open, because the registry keeps no list of them. Then every row is read again from the registry
itself before it is shown, because the index can be behind and the resolver is about to spend
somebody's bond on what this page says. Where the two disagree about the evidence, the claim is not
printed and the row says to read the record itself before settling it.

Under the rows sits "What the registry owes you", with the reason it is there: "Money here is pulled,
never pushed. A settled dispute records a credit, and nothing reaches an account until that account
asks for it." Whoever is owed presses "Withdraw" with the amount on it.

## What a dispute does not do

It does not remove the record, and it does not stop the image being verifiable. A disputed passport
still answers a verify query, still carries its attestations, and still shows every edit registered
from it. What changes is the one word the page leads with, and that word is permanent once a
challenge is upheld.

The function signatures, every revert and the events are in [Registry](../api/registry). What the
policy contract can and cannot change is in [Security overview](../security/overview).
