---
title: Moolam
sidebar_label: Introduction
sidebar_position: 1
slug: /
---

# Moolam

Moolam is Tamil for source or origin, which is what the product records: where a picture came from.

Moolam gives every AI-generated image a passport on Monad. The passport is a permanent record of
the exact bytes, two perceptual fingerprints that survive re-encoding, the C2PA manifest, the
creator and the generator agent. Anyone can verify any copy, even one a platform has stripped of
metadata.

The record is only worth something if it was hard to fake. Two signatures have to check out on
chain before a passport exists. The creator signs the image fingerprint with the passkey on their
own phone or laptop, verified through Monad's P-256 precompile. The AI agent that generated the
image signs the same fingerprint with the wallet that owns its ERC-8004 identity. Neither signature
is checked off chain, and neither can be added later.

Verification runs on the picture, not on the file. Upload any copy to the verify service and it
computes the same fingerprints, tries all eight rotated and mirrored versions, and searches the
registered passports. On the prove-it run against Monad mainnet, six mangled copies of one image
and one copy with every scrap of metadata removed all resolved back to the same passport.

## Live on Monad mainnet

Chain 143, deployed in block 103054771, all three verified on MonadVision through Sourcify.

| Contract | Address | Deployed in block |
| --- | --- | --- |
| MoolamRegistry | [0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0](https://monadvision.com/address/0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0) | 103054771 |
| VerifierPolicy | [0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821](https://monadvision.com/address/0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821) | 103054771 |
| MoolamReceiver | [0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04](https://monadvision.com/address/0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04) | 103054771 |

Two contracts Moolam reads but did not deploy: Monad's canonical
[ERC-8004 Identity Registry](https://monadvision.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)
at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, and Chainlink's production
[Keystone Forwarder](https://monadvision.com/address/0x76c9cf548b4179F8901cda1f8623568b58215E62)
at `0x76c9cf548b4179F8901cda1f8623568b58215E62`. The demo generator is agent 10248 on the identity
registry.

## The three technologies underneath

**Privy** holds the keys. The generator agent's wallet lives in Privy's secure enclave under a
policy that allows one function on one contract, so a compromised prompt cannot move MON or call
anything else. Creators grant the editing app a session signer scoped to `appendEdit` alone, which
is how an editing session writes ten edits without ten passkey prompts.

**Chainlink CRE** is the second opinion. When a passport is registered, a log-triggered workflow
downloads the image the passport points at, decodes the JPEG and recomputes the perceptual hash
inside the sandbox, and the nodes have to agree on the verdict before it is signed into a report
and written back on chain as an attestation.

**Envio** turns the events into data. HyperIndex V3 builds the passports, the edit trees, the
verification tallies, the disputes and the per-generator trust scores, and serves them over
GraphQL. The verify service reads its passport index from there.

## Where to go next

- [Quick start](getting-started/quick-start) is two minutes in the live app: verify a copy, then
  register an image of your own.
- [How it works](concepts/how-it-works) walks the life of one passport from generation to
  verification.
- [Architecture](developers/architecture) has the three diagrams and the interface.
- [Prove it](developers/prove-it) is the one command that runs the whole promise against mainnet.
- [Threat model](security/threat-model) lists every claim, the attack against it, and the file the
  output is saved in.
- [FAQ](faq) answers the questions a creator and a judge each ask first.
