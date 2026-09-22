---
title: Try to break it
---

# Try to break it

Every claim in the [threat model](threat-model) has been attacked, and the output
of each attack is saved in this repository as text. Text is something you have to
take our word for. This page does not ask you to: press a button and the attack is
sent to the deployed contracts on Monad mainnet while you watch, and the refusal
that comes back is the contract's own.

Nothing here can change anything. Each row is an `eth_call`, which is the question
"what would happen if this address sent this" rather than the sending of it. The
node runs the same bytecode a transaction would run, against the same state, and
throws the result away at the end. The only thing skipped is the commit, which is
also the only thing that would cost gas or need a key. That is why a call can be
sent as the burn address, `0x00...dEaD`, which nobody has ever held a key for: the
refusal proves the rule is about who is asking, and no wallet is involved at any
point.

The last row is the control. It is the first row's call sent by the wallet that
really does hold that passport, and it has to go through. A contract that refuses
everything has proved nothing in particular, so the twelve rows are only worth
reading together.

```break-it
```

## Where these came from

None of these attacks was invented for this screen. Each row names the transcript
it was taken from and the Foundry test that pins the same rule. The transcripts
under `docs/security/attacks/` hold the whole session for each one: the call, the
address it was sent from and the error name. The twelve written by `npm run prove`
carry one thing this page cannot, the hash of the same attack sent as a real
transaction and reverted on Monad, as in
[edit-by-non-owner.txt](attacks/edit-by-non-owner.txt). The refusals from the
consent register were run by hand with `cast call`, and every command as it was
typed is in [proofs/consent-attacks.txt](../../proofs/consent-attacks.txt).

What this page does not cover is an attack nobody thought of. It is the list from
the [threat model](threat-model), written by the people who built the thing, and
no third party has audited it.
