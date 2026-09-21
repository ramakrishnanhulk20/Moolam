---
title: Terms
---

# Terms

Last updated: 21 September 2026.

## The short version

Moolam is hackathon-stage software, free to use, offered as is, with no warranty and no promise
that it stays up. A passport proves who registered a file first and what they stated, never who
owns the copyright. A statement about AI use is a public dated record, not a lock on anything.
Registering cannot be undone, so register only pictures you have the right to register. Anyone can
challenge a passport by putting up a bond of 1 MON.

## What Moolam is

A passport registry on Monad and a service that matches a picture back to it. That is the whole
product.

## What a passport proves, and what it does not

Stated narrowly, a passport proves that a specific passkey signed those exact bytes at that moment,
that the record cannot be altered or removed by anyone, that for a generated picture the wallet
owning the agent's ERC-8004 identity signed the same digest, and that every edit came from the
wallet holding the parent at the time.

It does not prove who made the picture. It proves who registered first, and for a human photo that
is a timestamped claim and nothing stronger. It says nothing about the person behind the key. It
does not make the C2PA manifest trustworthy either: manifests are signed with a throwaway
development certificate today, so every C2PA reader marks them untrusted. The full list, with what
is deliberately left out, is in the [trust model](../concepts/trust-model).

## Statements about AI use

A statement is evidence of one narrow thing: the address the registry said held that passport at
that second wrote those words. It does not prove the holder owns the copyright, and it binds
nobody. Nothing in the contract can stop a crawler that never reads it. What it takes away is the
excuse of not knowing.

Using Moolam does not make you, or anyone who reads your statement, compliant with the EU AI Act,
with the Commission's Code of Practice, or with any other law.
[Rules and standards](../concepts/rules-and-standards) sets out where Moolam sits against those
texts and where it does not.

## What you must not register

- A picture you have no right to register.
- Illegal content.
- Someone else's private picture.

A registration cannot be undone. The record is on a public chain and the files are pinned on public
IPFS, and nobody, including whoever runs Moolam, can pull either back. There is no delete.

## Disputes

Anyone with an address and the bond can challenge a passport. There is no allow list, no reputation
gate and no role. The bond is exactly 1 MON on this deployment, it is your own money rather than
something Moolam sponsors, and it sits in the registry until the dispute is settled.

The resolver named by the policy contract decides, and that is one address rather than a court or a
vote. Upheld means the passport is marked disputed for good and the bond is credited back to the
challenger. Rejected means the record stands and the bond is credited to the treasury. Money is
pulled and never pushed, so whoever is owed calls withdraw themselves. A challenge that was upheld
cannot be filed a second time; one that was rejected can be filed again with new evidence.
[Disputes](../guides/disputes) has the rest of it, including what the screens show.

## Fees and limits

Registering a picture, appending an edit and writing a statement are sponsored today: the network
fee is paid through Privy, so those cost you nothing. That can change or stop at any time, and if
sponsorship is off the studio offers to send the same transaction from your own balance instead.

Today's limits, all of which can move:

- 60 requests a minute per caller address across the verify service
- 20 prepares an hour per signed-in account
- 3 generated pictures per account in a rolling day, and 2 being drawn at once across the service
- 5 edits per account in a rolling day
- 20 MB per upload, 16 KB per JSON body
- 10 minutes before the same wallet may change the same picture's statement again

The service may refuse a request or rate-limit a caller at any time.

## No warranty

The code is free and open source under the MIT licence in the repository's LICENSE file, and the
licence is where the warranty position is set out: the software is provided as is, without warranty
of any kind. Monad, the hosts, IPFS, the sign in provider and the image model are all outside
Moolam's control, and any one of them being down takes part of Moolam down with it. What is already
written on chain depends on none of them.

## The law

These terms were not drafted by a lawyer and are not a contract dressed up as one. They are a plain
account of what this software does and what it does not do. Whoever runs Moolam lives in India.

## Who runs this

Moolam is one person's project entered in a hackathon, not a company. Ram builds it and runs it, and
questions about these terms go to ramakrishnanhulk20@gmail.com.
