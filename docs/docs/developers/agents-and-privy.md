---
title: Agents and Privy
sidebar_label: Agents and Privy
sidebar_position: 6
---

# Agents and Privy

`@moolam/agents` is the TypeScript client every other piece of Moolam talks to the chain through:
the generator agent, the prove-it command, and the app. One place builds the digests, one place
signs, one place sends the transactions, so the app and the agent can never drift apart on what a
passport commits to.

## What is in the package

| Module | What it does |
| --- | --- |
| `src/chain/eip712.ts` | Builds the two digests the registry checks. `passportDigest` is the 32 bytes the creator's passkey and the generator agent both sign, and it is also the WebAuthn challenge. `bindDigest` is what a passkey signs to attach itself to a wallet. |
| `src/chain/passkey.ts` | `SoftwarePasskey`, a P-256 key that signs the way a device passkey does. See the caveat below. |
| `src/chain/registry.ts` | `RegistryClient`: read the bind nonce, bind a passkey, sign as a generator, register, append an edit, read a passport, mint an ERC-8004 identity, and turn a revert into the custom error name the contract raised. |
| `src/chain/addresses.ts` | Reads the deployed addresses from `packages/contracts/deployments/monad-mainnet.json` and fails with the deploy command when that file is not there. |
| `src/ipfs/pinata.ts` | One line, re-exporting the Pinata client from `@moolam/verifier/src/ipfs/pinata.ts`. It reads `PINATA_JWT` at the moment of the first pin rather than at import, and every pin happens before any transaction is sent, so a run that dies there has spent no gas. |
| `src/media/prepare.ts` | One line, re-exporting the prepare pipeline from `@moolam/verifier/src/prepare.ts`: the C2PA signed JPEG, the fingerprint of those signed bytes, the sha256 of the manifest store, and a thumbnail. |
| `src/seed/registerSeed.ts` | Puts one passport on Monad mainnet, pinning everything before the transaction is sent. |
| `src/privy/` | `client.ts` builds the client, `policies.ts` writes the rulebooks Privy's enclave enforces, `serverWallet.ts` creates and reuses wallets, `generatorSigner.ts` gets the agent's EIP-712 signature out of the enclave, `sessionSigner.ts` grants, uses and revokes the standing permission a creator gives the app. |
| `src/chain/anvil.ts` | Starts a local anvil forked from Monad mainnet and deploys the three contracts onto it. Tests and the local proof only. |

Pinning, the prepare pipeline and the metadata builder live in `@moolam/verifier` now, because the
studio route needs all three and three routes into the registry should not pin three different
shapes. The two rows above are one-line re-exports so nothing that imported them had to change, and
`src/seed/registerSeed.ts` reads `@moolam/verifier/src/metadata.ts` directly for the document a
passport's `metadataURI` points at.

The field order in `PASSPORT_TYPES` is copied from `PASSPORT_TYPEHASH` in `MoolamRegistry.sol`.
Change the order and every signature stops verifying, which is why the test suite compares both
digests against the contract's own `hashPassport` and `hashBind` for three different inputs.

`prepareImage` refuses to continue if signing moved the perceptual hash, because a manifest that
describes different pixels than the registered ones is worse than no manifest.

## How the software passkey differs from a real one

Byte for byte, the assertion is the same. The authenticator data is 37 bytes with user presence and
user verification set, the client data JSON says `"type":"webauthn.get"` and carries the digest
base64url encoded as the challenge, the signature is P-256 over
`sha256(authenticatorData || sha256(clientDataJSON))`, and `s` is normalised into the lower half of
the curve order because OpenZeppelin's `P256` library rejects the upper half. The contract cannot
tell the two apart, and it should not be able to: that is what makes this client testable.

What is different is everything around the key. A real passkey lives in a secure enclave or a
security key, it never leaves the device, and the user verification flag means a human actually
touched the sensor. Here the key sits in process memory and nobody touched anything. Use
`SoftwarePasskey` for agents, tests and scripts. A human creator's key must come from their own
device through the browser's WebAuthn API, never from this class.

## The Privy features Moolam is built on

**Server wallets with a policy.** The generator agent's key lives in Privy's secure enclave, not on
any Moolam server. Its policy allows exactly two things: send a `register` call to the Moolam
registry on chain 143 carrying no MON, and sign an EIP-712 message whose domain is that same
registry. Privy denies any method or destination no rule names, so the agent cannot move funds,
cannot call another contract, and cannot sign for another app even if the machine running it is
taken over.

**The agent's signature comes out of the enclave.** `register` only writes a Generated passport if
the owner of the ERC-8004 agent signed the same digest the creator's passkey signed. That signature
is produced by Privy typed data signing, and the script recovers the address from it locally before
spending gas, so a mismatch fails on the developer's machine rather than on chain.

**Session signers.** The creator owns their wallet. They grant the app a separate key, registered
with Privy as a one of one key quorum, permission to sign on that wallet, scoped by a second policy
that allows `appendEdit` and nothing else. That is what lets an editing session write ten edits
without ten passkey prompts. When the permission is taken back, the same call from the same key is
refused by Privy before it can reach Monad.

**Gas sponsorship.** The creator's first transaction is attempted with `sponsor: true`. On the
recorded run, Privy answered `HTTP 400 invalid_data: Gas sponsorship is not enabled`, so the script
printed `sponsorship: not enabled, paid by wallet` and the wallet paid. Turning it on is a
dashboard setting under Wallet Infrastructure, App pays, with Monad ticked. Nothing in the output
claims a sponsored transaction that did not happen.

Two honest notes on that proof. There is no browser in it, so the creator's wallet is a Privy
server wallet standing in for the embedded wallet a user would get on login, and the session signer
is granted through `wallets().update` with `additional_signers`, which is the server side of what
the React SDK calls `addSigners`. And the generator mints its ERC-8004 identity before its policy
goes on, because the policy forbids calls to any other contract; a rerun skips that step and the
wallet stays locked down.

**Access tokens.** The last thing Moolam takes from Privy is not a wallet at all. A creator in the
studio uploads a photo straight from their browser to the verify service, and it checks the Privy
access token that session already carries before it pins anything: signed by the app's own key set,
issuer `privy.io`, this app id in the audience, ES256, inside its expiry. That is what lets an
upload endpoint spend Moolam's pinning account without a shared secret sitting in a browser, where
it would not be secret. This one runs in the verify service rather than in this package, so it is
covered by that package's tests and not by the mainnet run above. See
[Verifier service](verifier-service).

## The generator agent

```bash
npm run agent -- "a cinematic poster of a lighthouse in a storm, film grain"
```

A language model with four tools takes the prompt, and in one run it draws the picture, signs it
with a C2PA manifest, pins four files to IPFS, and registers the passport on Monad mainnet. Every
tool call and every tool result is printed as it happens.

The four tools are in `src/agent/tools.ts`:

- **generate_image** draws the picture and keeps the bytes on this side of the model. Image bytes
  never travel through the conversation, so the model cannot register a picture it imagined.
- **register_passport** runs the whole write path: `prepareImage`, four pins to Pinata, the
  creator's passkey over the EIP-712 digest, the agent's own signature produced inside Privy's
  enclave, then `register` sent by the agent's server wallet under its policy.
- **verify_image** posts the file to the verify service, which is the only thing that can match a
  re-encoded or rotated copy, then reads the passport it names straight off Monad, because the
  service is not the authority on who signed what.
- **lookup_agent** reads an owner and a registration card from the ERC-8004 Identity Registry.

The agent cannot spend the wallet it uses. Privy's policy names `register` on the Moolam registry
and typed data whose domain is that registry, and nothing else.

### The models, and what they cost

| Job | Default model | List price | Override |
| --- | --- | --- | --- |
| Brain | `gpt-5.4-nano` | 0.20 dollars per million input tokens, 1.25 per million output | `AGENT_TEXT_MODEL` |
| Image | `gpt-image-1-mini` | 8 dollars per million image output tokens, about 1,200 tokens for one medium 1024 by 1024 picture | `AGENT_IMAGE_MODEL` |

A whole generate run costs about one cent. The two recorded runs used 2,736 and 2,394 text tokens
and one picture each. The brain speaks the OpenAI chat completions API, so pointing it at
OpenRouter is two environment variables and no code change: `AGENT_PROVIDER=openrouter` and, for a
different model, `AGENT_TEXT_MODEL`. The image model has no OpenRouter fallback, because the images
endpoint is OpenAI's own.

To answer "who made this?" the verify tool needs the service running:

```bash
PASSPORT_SOURCE=json PASSPORT_SOURCE_PATH=packages/agents/.moolam/passports.json \
  VERIFIER_PORT=4010 npm run dev:verifier
```

`register_passport` writes each new passport into that JSON file after reading it back off Monad,
so the file is a cache of the chain and never a source of its own. In production the same records
come from Envio with `PASSPORT_SOURCE=envio`.

## Commands

From the repo root, with Foundry on the path and the root `.env` loaded:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . .env; set +a
```

| Command | What it does |
| --- | --- |
| `npm run test:agents` | 22 tests across 4 files: the digests against the contract, the whole write path on a fork of Monad mainnet, the Privy policy shapes, and the refusals decoded to their error names. Spends no MON. |
| `npm run proof:anvil` | Deploy, bind, three passports and an edit on a fork, with gas per step. Spends no MON. |
| `npm run seed` | One real passport on Monad mainnet, files pinned to IPFS. Spends MON. |
| `npm run prove:privy` | Server wallets under a policy, enclave signing, session signers and sponsorship, live on Monad mainnet. Spends MON. |
| `npm run prove` | The prove-it run. Spends about 0.4 MON. See [Prove it](prove-it). |
| `npm run agent -- "..."` | The demo agent. Spends MON and a cent or two of OpenAI credit. |
| `npm run agent -- --verify path/to/file.jpg` | The same agent answering "who made this?" for any copy. |

The tests and the anvil proof fork Monad mainnet locally, so the ERC-8004 Identity Registry at
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` is the real contract with real state while the
balances are anvil's play money. The contracts are compiled by Foundry, so run `forge build` in
`packages/contracts` first if `out/` is missing.

### Seeding a passport

`npm run seed` draws a fresh 1024 by 768 picture from its own seed number, so no two runs register
the same image, then does the whole flow on mainnet: read the addresses and the demo agent id, bind
the passkey if the live registry does not already hold it, sign a C2PA manifest carrying the soft
binding, pin four files to IPFS, register a Generated passport co-signed by the agent owner, and
fetch the thumbnail back through the public gateway to prove the file the Chainlink verifier will
download really matches the fingerprint on chain.

The thumbnail is a baseline JPEG, longest side 512 pixels, and the script drops the quality until
the file is under 60,000 bytes. Two constraints set that: the Chainlink workflow fetches through an
IPFS gateway with a 100 KB cap, and it decodes with `jpeg-js`, which reads baseline files only. A
progressive thumbnail would fail every verification.

The two recorded mainnet runs cost 376,178 and 376,166 gas, about 0.0384 MON each, because Monad
bills the gas limit rather than the gas used.

### What each action costs on a fork

Measured by `npm run proof:anvil`. Anvil answers the P-256 precompile at `0x0100` the same way
Monad does, checked directly against OpenZeppelin's own probe vector, so these figures are close to
the real thing rather than the much larger cost of the pure Solidity fallback.

| Action | Gas on the fork | In plain English |
| --- | --- | --- |
| Bind a passkey | 117,538 | One time per wallet, before it can register anything. |
| Register a Captured photo | 308,911 | Checks the WebAuthn signature, writes the record, mints the token. |
| Register an agent on ERC-8004 | 450,903 | One time per agent. Paid to the ERC-8004 registry, not to Moolam. |
| Register a Generated image | 371,986 | The Captured cost plus the agent signature check and the ERC-8004 ownership read. |
| Append an edit | 353,983 | No passkey prompt. Holding the parent token is the authority. |

The gas figures the contracts package publishes are the ones to quote for mainnet: they are
measured in Foundry's Monad network family, which prices gas the way Monad does.

## Environment

| Variable | Needed by |
| --- | --- |
| `MONAD_MAINNET_RPC_URL` | Every read and transaction |
| `DEPLOYER_PRIVATE_KEY` | The creator's wallet. It owns the demo ERC-8004 agent and pays the gas |
| `PROOF_P256_PRIVATE_KEY` | That creator's passkey, the P-256 key the WebAuthn assertion is made with |
| `PINATA_JWT` | Pinning the image, the thumbnail, the manifest and the metadata to IPFS |
| `VERIFIER_PRIVATE_KEY` | The outsider wallet the attacks are sent from. It holds no role in Moolam |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` | The Privy server wallets, policies and session signers |
| `OPENAI_API_KEY` | The generator agent |

The wallet ids, the policy ids and the agent id are cached in `packages/agents/.moolam/wallets.json`
so a second run reuses everything. The app's session key and the creator's passkey key live next to
it in the same gitignored folder and are never printed.
