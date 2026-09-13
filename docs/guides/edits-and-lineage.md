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

## Adding an edit from the passport page

Open a passport you hold and a panel sits under the lineage block, headed "Yours to edit" over "Add
an edited version". It is drawn for one reader only, the wallet the registry says holds this
passport. A signed out visitor and a signed in stranger get no markup at all, not a greyed out
button, because an edit they could never make is not worth the space on a page about someone else's
picture.

### First, the permission

The panel opens on what it is asking for, in one sentence: "A signer is a permission you give this
app to add edits to your passports, limited to that one action by a policy Privy enforces." Under it,
in monospace, what the policy actually allows: "The policy allows appendEdit on the Moolam registry
and nothing else."

Press "Allow edits from this app" and Privy asks you in its own window. The panel says so while it
waits, "Privy is asking for your permission", and afterwards reads "This app can add edits from your
wallet" with "Revoke" beside it.

Revoking takes every signer off the wallet, not only this app's, because Privy's browser SDK has no
call that removes one by id. The panel prints "Taking it back" while it runs.

If a deployment has no signer configured, the panel says so and offers nothing: "No signer is set up
on this deployment, so an edit cannot be added from here yet."

### Then, the edit

Drop the edited picture on "Drop the edited picture here" or press "Choose a picture". JPEG, PNG or
WebP, up to 20 MB. Give it a "Title", and optionally a line under "What changed", up to 280
characters. The hint says where that line goes: "Optional, up to 280 characters. It is pinned with
the picture, next to the parent's id." Then press "Add this edit".

Two steps, not three, because no passkey is involved.

| Line on screen | What is happening |
| --- | --- |
| "Pinning the edited picture" | A fresh C2PA manifest is written into the file, the signed bytes are fingerprinted, and the picture, its thumbnail, the manifest and the metadata go to IPFS |
| "Sending from your account, signed by the app's key under the edit policy, gas sponsored" | `appendEdit` goes out from your own wallet, asked for by the service with the app's key under the policy. Then "Sent from your account, signed by the app's key under the edit policy. Waiting for Monad to show it." |

It finishes as "Recorded", with the child passport's id, the block, the fee line "Sponsored by Privy.
You paid nothing.", how many edits this passport now has, and links to the edit, the transaction and
"Add another edit". The tree above it redraws from the chain rather than being patched in the
browser.

The line under the button reads "0 of 5 edits today". Five a day per account is what stops one
account draining the pinning plan and the sponsored gas, and it is counted on the Privy user id from
your session, which a caller cannot choose.

### When it does not go through

| Message | What happened |
| --- | --- |
| "This app does not hold a signer on your wallet under the edit policy. Grant it again and the edit can go out." | The service looked at the wallet and found no signer of this app's under the policy. A grant made without the policy lands here too, and the panel drops back to the grant button |
| "This account does not hold this passport, so it cannot add an edit to it." | The registry says someone else owns the parent now |
| "The registry has no passport with this id, so there is nothing to add an edit to." | The parent id is not a record |
| "That is 5 of 5 edits for today. The allowance comes back at" | The daily cap, with the time it resets |
| "The edited picture could not be pinned to IPFS, so nothing was sent." | Pinata refused a pin. Nothing reached the chain |
| "Privy would not sign the send, so nothing was recorded." | The permission or the policy refused the call before it left |
| "The registry refused the edit, so nothing was recorded." | The call was simulated against current state and reverted, so nothing was signed or broadcast |
| "The service is running as many edits at once as it can. Try again in a moment." | Two edits were already in flight |
| "The edit was accepted and Monad has not shown it yet. It may still land, so it must not be sent again." | The wait ran out. The button reads "Ask Monad again", which reads the chain and sends nothing |

The ownership check is read from the chain before anything is spent, and the wallet comes from the
Privy user record rather than from the request, so neither is something a caller can assert.

The route behind all of this, with its status codes, is
[Verifier endpoints](../api/verifier-endpoints).

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
- One line under the tree, for every reader and not only the owner, says how edits get there: "Edits
  are added by the owner through a Privy signer with a policy that allows only appendEdit."

The list is a real record rather than a claim in the metadata, because the parent id is inside the
signed struct and the contract appends the child to the parent's own list. Walk up from any edit
and you reach the original; walk down from an original and you see everything registered from it.

An edit costs 299,849 gas at the median, a little more than a register because it also links the
child to its parent. The full function signature, every revert and the events it emits are in
[Registry](../api/registry).
