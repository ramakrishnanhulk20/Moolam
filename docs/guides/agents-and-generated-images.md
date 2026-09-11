---
title: Agents and generated images
---

# Agents and generated images

A photograph gets one signature. A generated image gets two, and the second one is what makes it an
AI provenance record rather than a timestamp.

The studio takes human uploads today, and registers them as Captured passports with no generator
agent. A picture an AI made registers through the agent that made it, which is the path this page
describes.

## What an agent is

An agent's identity is an ERC-8004 token on Monad's canonical Identity Registry at
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, minted once and owned by a wallet. Moolam does not
mint it, does not control it, and reads exactly one thing from it: `ownerOf(agentId)`. That makes an
agent's history portable, and it means an agent id is worth exactly as much as the wallet that owns
it. The demo generator in this deployment is agent 10248.

The agent's key is a Privy server wallet. It lives in Privy's secure enclave, not on any Moolam
server, under a policy that allows exactly two things: send a `register` call to the Moolam registry
on chain 143 carrying no MON, and sign an EIP-712 message whose domain is that same registry. Privy
denies any method or destination no rule names, so a hijacked prompt cannot move funds, cannot call
another contract, and cannot sign for another app even if the machine running the agent is taken
over.

That refusal is executed, not asserted. `npm run prove` asks the agent's wallet to send MON and to
call a function its policy does not name, and Privy's enclave answers `policy_violation` both
times. The output is saved in
[privy-policy-refusal.txt](../security/attacks/privy-policy-refusal.txt).

## How a generated image gets its passport

1. **The agent draws the picture.** It is a language model with four tools, and `generate_image` is
   the one that produces the file. The image bytes stay on this side of the model and never travel
   through the conversation, so the agent cannot register a picture it only imagined.
2. **The file is prepared.** The same pipeline the studio uses: turned upright, a C2PA manifest
   signed into it carrying a soft binding, the signed bytes fingerprinted, a thumbnail built. Four
   files go to IPFS, the image, the thumbnail, a readable copy of the manifest and the metadata,
   before any transaction is sent, so a failed upload costs no gas.
3. **The creator's passkey signs the digest.** `hashPassport(input)` on the registry returns the
   EIP-712 digest, and that same digest is the WebAuthn challenge.
4. **The agent owner signs the same digest.** Privy typed data signing produces the signature inside
   the enclave. The script recovers the address from it locally before spending gas, so a mismatch
   fails on the developer's machine rather than on chain.
5. **`register` checks both, on chain.** The WebAuthn assertion goes through OpenZeppelin's
   `WebAuthn` library against Monad's P-256 precompile at `0x0100`. The agent signature is recovered
   and compared against `ownerOf(agentId)` on the ERC-8004 registry. Only then is the record written
   and the ERC-721 minted, with the image hash as the token id.

Neither signature is checked off chain and neither can be added later. An agent id nobody registered
reverts `UnknownAgent`; a signer who does not own the id reverts `InvalidGeneratorSignature`. Both
refusals are in the fork tests and in the saved attack outputs.

Anyone may send the transaction. Authority comes from the two signatures, not from `msg.sender`,
which is what lets a relayer pay a creator's gas.

## What the agent page shows

Open any agent from a passport's "Generator agent" link, or from an agent link on a verify result.

**The contact sheet.** Every picture the agent has signed, tiled behind its name, with the owner
address and the identity registry underneath. An agent that has signed nothing gets the seal on a
dark plate rather than an empty grid.

**Reputation.** Two numbers, deliberately kept apart, because one is a claim someone signed and the
other is a calculation.

- On the left, the ERC-8004 Reputation Registry's own summary, read from the canonical registry on
  Monad mainnet under the tags `moolam` and `verification`. The page says who writes it: "Feedback
  is written to the canonical ERC-8004 reputation registry by whoever left it, under the tags
  moolam and verification. This page reads the summary of those two tags and applies the decimals
  the registry reports." The registry refuses feedback from the agent's own owner, which is what
  makes it worth reading, so the Moolam verifier signs with its own wallet. With nothing recorded it
  says "No feedback recorded for this agent yet. The verifier writes one after every check it runs."
- On the right, "What the index has counted": a "Trust score" out of 100, "Passports", "Re-checks
  matched", "Re-checks missed" and "Disputes upheld". The score is
  `round(100 * (matched + 1) / (matched + mismatched + 2 * disputesUpheld + 2))`, and the page says
  why it is smoothed: "Out of 100, from re-checks that matched, re-checks that did not, and any
  upheld dispute. Smoothed, so one lucky check cannot make it 100." A brand new agent starts at a
  neutral 50 rather than a meaningless 100, and an upheld dispute counts double against it.

**How this agent signs.** Three steps with the contract's own behaviour under each: "The agent signs
the fingerprint", "The registry recovers the signer", "It has to be the owner". The third one names
the refusal: if the recovered address and `ownerOf` differ, the registration reverts with
`InvalidGeneratorSignature` and no passport exists.

Under those, a "Where the key lives" block appears only when the agent's own registration card
records a Privy wallet id or policy id. The page is explicit that those values are the agent's, not
Moolam's: "These values come from the agent's own card, not from this app." Neither live agent card
in this deployment records them, so the block does not show today.

**What it has signed.** Every passport naming this agent, read from the index, with thumbnails. An
agent with no passports says "No passport names this agent yet."

## Running the agent yourself

```bash
npm run agent -- "a cinematic poster of a lighthouse in a storm, film grain"
```

One run draws the picture, signs the manifest, pins four files and registers the passport on Monad
mainnet, printing every tool call and every tool result as it happens. It costs about a cent of
model credit plus the gas. The same agent answers the other question too:

```bash
npm run agent -- --verify path/to/file.jpg
```

That posts the file to the verify service, then reads the passport it names straight off Monad,
because the service is not the authority on who signed what.

The package, the tools, the models and the environment it needs are in
[Agents and Privy](../developers/agents-and-privy).
