---
title: Edits and lineage
---

# Edits and lineage

An edited picture is a different picture. Different bytes, a different perceptual hash, a different
passport. What Moolam records is that the second one came from the first, on chain, signed by
whoever held the original.

## What an edit is

`appendEdit` writes a new passport whose `parentId` is an existing passport's id, and mints the
child token. It is the same record shape as a registration, with three differences:

- `parentId` names the parent, and the parent has to exist. A zero parent reverts `InvalidParent`, a
  parent with no record reverts `ParentNotFound`.
- `kind` has to be `Edited`. Anything else reverts `InvalidKind`.
- There is no passkey signature.

Everything else still holds. The child gets its own `exactHash`, its own two perceptual hashes, its
own metadata URI and its own token, and a duplicate image hash still reverts
`PassportAlreadyExists`.

## Owner only

Holding the parent token is the authority. `msg.sender` must own the parent, or the call reverts
`NotParentOwner`, and `p.creator` must be that same owner, or it reverts `InvalidCreator`.

An ERC-721 approval is deliberately not enough, and neither is an operator approved for all. That
rule is worth stating on its own: approval is permission to move a token, which people grant to
marketplaces and escrows every day. It must never quietly become permission to write history under
the owner's name. Both are refused.

The refusal is executed rather than argued. `npm run prove` hangs an edit off a passport somebody
else holds and the live contract answers `NotParentOwner`. The output is in
[edit-by-non-owner.txt](../security/attacks/edit-by-non-owner.txt).

## Why an editing app does not prompt ten times

An editing session that writes ten edits would mean ten biometric prompts if every edit needed a
passkey. So it does not. Holding the parent is the authority, and the app acts from the creator's
own wallet through a Privy session signer.

The creator owns the wallet. They grant the app a separate key, registered with Privy as a one of
one key quorum, permission to sign on that wallet, scoped by a second policy that allows
`appendEdit` and nothing else. The app can then write edits for as long as the permission stands. It
cannot register a new original, cannot move funds and cannot call another contract, because the
policy names one function.

When the creator takes the permission back, the same call from the same key is refused by Privy
before it can reach Monad. That refusal is executed too, in
[revoked-session-signer.txt](../security/attacks/revoked-session-signer.txt).

A session signer works where an ERC-721 approval does not because it acts from the owner's own
wallet. The contract is not being asked to trust a third party; it is seeing the owner sign, with
Privy holding the key under a rule the owner set.

The session signer API is in [Agents and Privy](../developers/agents-and-privy).

## Generated edits

An edit made by an agent carries a `generatorAgentId` and the agent owner's signature, checked the
same way a fresh Generated passport is: recovered and compared against `ownerOf(agentId)` on the
ERC-8004 registry. An unknown id reverts `UnknownAgent` and a signature from a wallet that does not
own the id reverts `InvalidGeneratorSignature`. For an edit with no agent, the signature is empty.

## What the lineage block shows

On a passport page, under "Edits":

- "Edited from" appears only when this passport has a parent, and links to it.
- "Registered from this one" lists every child, in the order the registry stored them, read live
  from `getChildren`. Each row links to that child's passport page.
- With no children it says "No edit has been registered from this passport."

The list is a real record rather than a claim in the metadata, because the parent id is inside the
signed struct and the contract appends the child to the parent's own list. Walk up from any edit
and you reach the original; walk down from an original and you see everything registered from it.

An edit costs 299,849 gas at the median, a little more than a register because it also links the
child to its parent. The full function signature, every revert and the events it emits are in
[Registry](../api/registry).
