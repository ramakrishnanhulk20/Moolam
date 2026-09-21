---
title: Why Monad
---

# Why Monad

Moolam is not a contract that happens to run on Monad. Three things about the chain decide what
this design can do at all.

## The P-256 precompile at 0x0100

A passkey signs with P-256, and the EVM has no native support for that curve. Checking one in plain
Solidity is expensive enough that most designs give up and verify the signature on a server, which
turns the whole claim back into self-reporting.

Monad has the precompile at `0x0100`. `MoolamRegistry` runs every passkey check through
OpenZeppelin's `WebAuthn` library, which uses that precompile and falls back to pure Solidity only
where it is missing. Both user presence and user verification are required, so a passport can only
be created by someone who physically touched the device and passed its biometric or PIN.

Measured in Foundry's Monad network family, `register` costs a median 254,429 gas. That is one
transaction that checks a real WebAuthn assertion, checks an ECDSA signature against the agent's
ERC-8004 owner, writes the record and mints the token.

## Gas cheap enough to register everything

Registering one image is not a considered decision a user makes. It has to happen every time, for
every picture, or the record has holes in it.

Median gas per action, from the contracts package:

| Action | Median gas |
| --- | --- |
| `bindPasskey` | 117,165 |
| `register` | 254,429 |
| `appendEdit` | 299,849 |
| `attest` | 126,113 |
| `flag` | 172,939 |
| `withdraw` | 40,717 |

Deploying all three contracts, pinning the receiver, registering the demo agent and running the
live proof came to 9,609,437 gas in total, which is 0.961 MON at Monad's 100 gwei minimum base fee.

Two Monad specifics shape how these are spent. Monad bills the gas limit you declare rather than
the gas you use, so every script here declares its limit with `--gas-estimate-multiplier 110`
instead of Foundry's default 130, which would overpay by a fifth. And every account has to keep a
10 MON reserve balance it cannot spend, so a wallet needs that on top of whatever it is about to
pay.

## Cheap enough to change your mind on the record

A creator's statement about AI use has the same problem as a registration and a worse one on top. It
has to be worth writing for one picture, and it has to be worth rewriting when the creator changes
their mind, or the record is a snapshot of one afternoon rather than a history.

`MoolamConsent` measures 117,337 gas for a passport's first statement and 91,036 for a later one.
Stating one policy across 32 pictures in a single call is 2,371,445, which is 74,107 a picture,
roughly half the price of saying the same thing 32 times. At the 102 gwei Monad was quoting when
these were measured, that is about 0.014 MON for one, about 0.0077 MON a picture for the batch, and
about 0.036 MON when a full 256 byte note about the conditions rides along. Moolam sponsors the fee
through Privy, so a creator pays none of it.

Asking what a picture allowed on a given day costs nothing at all, because `consentAt` is a view.
The binary search behind it barely moves with the history length: 30,676 gas over two entries and
35,539 over 256.

The cap on a batch comes from the same arithmetic. The worst batch, 32 first statements each
carrying 256 bytes of text, measures 8,144,656 gas, a bit over a quarter of Monad's 30,000,000 gas
per transaction limit, which is what makes 32 a cap that is provably inside one transaction. The
same Monad specific applies here as everywhere: the chain bills the gas limit declared, so a wallet
that pads the limit on a 32 picture batch pays for the padding.

## Room to keep the record on chain

Attestations are stored, not just emitted, and a passport can hold up to `MAX_ATTESTATIONS`, which
is 64. Reading a full page back is about 6,000 gas of returned data, three orders of magnitude
under Monad's 150M gas block limit, so a whole page always fits in one call.

The registry compiles to 20,954 bytes of runtime code. That leaves 3,622 bytes of headroom under
the 24,576 byte contract size limit, and far more under Monad's 128 KB cap, which is what made it
possible to keep the passkey verification, the edit tree, the attestations and the dispute escrow
in one immutable contract rather than splitting them across proxies.

## The ERC-8004 registry is already there

Moolam does not run its own agent identity system. It reads Monad's canonical ERC-8004 Identity
Registry at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and nothing else: `ownerOf(agentId)` is
the whole integration. An agent's reputation is portable because the identity is not ours.
