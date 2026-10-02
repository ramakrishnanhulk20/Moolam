---
title: Moolam
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

A creator can also say, at the moment they make a picture, whether AI may use it. The answer goes
inside the file as a signed C2PA assertion and onto Monad as a dated entry only the passport's
holder can write, so a platform that strips the file's metadata does not strip the answer.

## Live on Monad mainnet

Chain 143, every one verified on MonadVision through Sourcify.

| Contract | Address | Deployed in block |
| --- | --- | --- |
| MoolamRegistry | [0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0](https://monadvision.com/address/0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0) | 103054771 |
| VerifierPolicy | [0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821](https://monadvision.com/address/0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821) | 103054771 |
| SimulationReceiver, public re-checks, listed in the policy since 2026-09-27 14:18 UTC ([listing](https://monadvision.com/tx/0xac642cc5c89290a2659e0ee7aaa78d7b729643f22138725815590dd2abbc0bfb)) | [0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95](https://monadvision.com/address/0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95) | 108102667 |
| SimulationReceiver, private re-checks, listed in the policy since 2026-09-27 14:18 UTC ([listing](https://monadvision.com/tx/0x0e1e2937ee4593cb8aad78d4bb6696b14584080b216d4c3c028f0c32eecf457d)) | [0x52b8fE549B432920eeB061c26cAc5c2D527657f6](https://monadvision.com/address/0x52b8fE549B432920eeB061c26cAc5c2D527657f6) | 108102676 |
| MoolamReceiver, the door for Chainlink's network verdicts, off the policy 2026-09-26 and listed again on 2026-10-02 at 07:08:18 UTC ([listing](https://monadvision.com/tx/0x446c3051322060339d8e95bcc2938ca6db6692e8d583d360ebab6e626ea1ff9f), block 109830535), every re-check it wrote kept | [0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04](https://monadvision.com/address/0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04) | 103054771 |
| MoolamReceiver, private re-checks, off the policy since 2026-09-26, every re-check it wrote kept | [0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A](https://monadvision.com/address/0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A) | 107265126 |
| MoolamConsent | [0x1151E69a82947920546e779c4C8c785b2a3C1277](https://monadvision.com/address/0x1151E69a82947920546e779c4C8c785b2a3C1277) | 105828247 |

Two contracts Moolam reads but did not deploy: Monad's canonical
[ERC-8004 Identity Registry](https://monadvision.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)
at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, and Chainlink's production
[Keystone Forwarder](https://monadvision.com/address/0x76c9cf548b4179F8901cda1f8623568b58215E62)
at `0x76c9cf548b4179F8901cda1f8623568b58215E62`. Two generator agents live on the identity registry.
Agent 10249 is the studio's, whose key is a Privy server wallet under a policy, and it signs every
picture the agent draws. Agent 10248 is owned by the deployer and signed the first seed passports.

## The three technologies underneath

**Privy** holds the keys. The generator agent's wallet lives in Privy's secure enclave under a
policy that allows one function on one contract, so a compromised prompt cannot move MON or call
anything else. Creators grant the editing app a session signer scoped to `appendEdit` alone, which
is how an editing session writes ten edits without ten passkey prompts.

**Chainlink CRE** is the second opinion. When a passport is registered, a log-triggered workflow
downloads the image the passport points at, decodes the JPEG and recomputes the perceptual hash
inside the sandbox, and the result is written back on chain as an attestation. On Chainlink's
network a quorum of nodes must produce the identical verdict before a report is signed, and since
2026-10-02 that is live for the verdict step: the first network verdict, written 16 seconds after the
passport was registered, was agreed by ten nodes in
[transaction 0x760dcb5e…2882](https://monadvision.com/tx/0x760dcb5e1b83929201d8fe299ce9c3be2cf8981502117c5288386d7da3438882).
Every re-check before that came from Chainlink's simulator with `--broadcast`, which is one machine
and no consensus, and the passport page labels each one by the forwarder that delivered it.

**Envio** turns the events into data. HyperIndex V3 builds the passports, the edit trees, the
verification tallies, the disputes and the per-generator trust scores, and serves them over
GraphQL. The verify service reads its passport index from there.

## Where to go next

- [Quick start](getting-started/quick-start) is two minutes in the live app: verify a copy, then
  register an image of your own.
- [How it works](concepts/how-it-works) walks the life of one passport from generation to
  verification.
- [Say how AI may use a picture](guides/ai-use-statements) is the creator's side of the consent
  register: the three choices, what each writes, and what none of them do.
- [Architecture](developers/architecture) has the three diagrams and the interface.
- [Prove it](developers/prove-it) is the one command that runs the whole promise against mainnet.
- [Threat model](security/threat-model) lists every claim, the attack against it, and the file the
  output is saved in.
- [FAQ](faq) answers the questions a creator and a judge each ask first.
