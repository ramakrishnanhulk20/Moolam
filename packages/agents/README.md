# Moolam agents

The TypeScript client every other piece of Moolam talks to the chain through: the generator agent,
the prove-it command, and the app. One place builds the digests, one place signs, one place sends
the transactions, so the app and the agent can never drift apart on what a passport commits to.

## What is in here

**`src/chain/eip712.ts`** builds the two digests the registry checks. `passportDigest` is the 32
bytes a creator's passkey and the generator agent both sign, and it is also the WebAuthn challenge.
`bindDigest` is what a passkey signs to attach itself to a wallet. The field order in
`PASSPORT_TYPES` is copied from `PASSPORT_TYPEHASH` in `MoolamRegistry.sol`; change the order and
every signature stops verifying, which is why the test suite compares both digests against the
contract's own `hashPassport` and `hashBind` for three different inputs.

**`src/chain/passkey.ts`** is `SoftwarePasskey`, a P-256 key that signs the way a device passkey
does. See the honest caveat below.

**`src/chain/registry.ts`** is `RegistryClient`: read the bind nonce, bind a passkey, sign as a
generator, register, append an edit, read a passport, mint an agent identity on the ERC-8004
registry, and turn a revert into the custom error name the contract raised.

**`src/chain/addresses.ts`** reads the deployed addresses from
`packages/contracts/deployments/monad-mainnet.json` and fails with the deploy command when that
file is not there yet.

**`src/ipfs/pinata.ts`** pins bytes and JSON to public IPFS through Pinata's v3 files endpoint at
`https://uploads.pinata.cloud/v3/files`, which their docs mark as the current upload API; the older
`pinFileToIPFS` route is kept only for folder uploads, which we do not do. It reads `PINATA_JWT`
from the root `.env` and checks it at import, so a run fails before it spends gas rather than after.

**`src/media/prepare.ts`** turns a raw picture into everything a passport needs: the C2PA signed
JPEG, the fingerprint of those signed bytes, the sha256 of the manifest store the chain commits to,
and a small thumbnail. It refuses to continue if signing moved the perceptual hash, because a
manifest that describes different pixels than the registered ones is worse than no manifest.

**`src/seed/registerSeed.ts`** puts one passport on Monad mainnet: prepare, pin the four files,
build the passport input, sign it with the creator's passkey and with the agent owner's wallet,
then register. Everything is pinned before the transaction is sent, so a failed upload costs no gas.

**`src/privy/`** is the Privy side: `client.ts` builds the client and the authorization context
from the root `.env`, `policies.ts` writes the rulebooks Privy's enclave enforces, `serverWallet.ts`
creates and reuses the wallets and sends transactions from them, `generatorSigner.ts` gets the
agent's EIP-712 signature out of the enclave, and `sessionSigner.ts` grants, uses and revokes the
standing permission a creator gives the app.

**`src/chain/anvil.ts`** starts a local anvil forked from Monad mainnet and deploys the three
contracts onto it. Tests and the local proof only. It repeats what `script/Deploy.s.sol` does
rather than running it, because that script writes the mainnet deployment file and would overwrite
the record of the real deploy.

## How the software passkey differs from a real one

Byte for byte, the assertion is the same. The authenticator data is 37 bytes with user presence and
user verification set, the client data JSON says `"type":"webauthn.get"` and carries the digest
base64url encoded as the challenge, the signature is P-256 over
`sha256(authenticatorData || sha256(clientDataJSON))`, and `s` is normalised into the lower half of
the curve order because OpenZeppelin's `P256` library rejects the upper half. The contract cannot
tell the two apart, and it should not be able to: that is what makes this client testable.

What is different is everything around the key. A real passkey lives in a secure enclave or a
security key, it never leaves the device, and the user verification flag means a human actually
touched the sensor and passed a biometric or a PIN. Here the key sits in process memory and nobody
touched anything. So: use `SoftwarePasskey` for agents, tests and scripts. A human creator's key
must come from their own device through the browser's WebAuthn API, never from this class.

## Commands

From the repo root, with Foundry on the path and the root `.env` loaded:

```
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . .env; set +a
```

```
npm run test:agents     16 tests: the digests against the contract, the whole write path on a
                        fork of Monad mainnet, and six refusals decoded to their error names
npm run proof:anvil     deploy, bind, three passports and an edit on a fork, with gas per step
npm run seed            one real passport on Monad mainnet, files pinned to IPFS. Spends MON.
npm run prove:privy     the four Privy features, live on Monad mainnet. Spends MON.
```

Both need `MONAD_MAINNET_RPC_URL` in the root `.env` and `anvil` on the path. Neither spends MON:
they fork Monad mainnet locally, so the ERC-8004 Identity Registry at
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` is the real contract with real state, while the
balances are anvil's play money. The contracts are compiled by Foundry, so run `forge build` in
`packages/contracts` first if `out/` is missing.

## Seeding a passport

`npm run seed` from the repo root is the script that gives judges something to look at. Each run
draws a fresh 1024 by 768 picture from its own seed number, so no two runs register the same image,
and then does the whole flow end to end on Monad mainnet:

1. Reads the addresses and the demo agent id from `packages/contracts/deployments/monad-mainnet.json`.
2. Uses the deployer wallet as both the creator and the generator, because that wallet owns agent
   10248 on the ERC-8004 registry. The creator key is `PROOF_P256_PRIVATE_KEY` from the root `.env`,
   loaded as a `SoftwarePasskey`. If the wallet has no passkey bound on the live registry, or a
   different one, the script binds it first and prints that transaction.
3. Signs a C2PA manifest into the picture carrying the soft binding, which is the 64 bit perceptual
   hash and the 256 bit blockhash of the same pixels.
4. Pins four files to IPFS: the signed image, the thumbnail, a readable copy of the manifest, and
   the metadata JSON that points at the other three.
5. Registers a Generated passport, co-signed by the agent owner, and prints the passport id, the
   transaction with its MonadVision link, and the gas.
6. Fetches the thumbnail back through the public gateway and fingerprints it, to prove the file the
   Chainlink verifier will download really matches the fingerprint on chain.

The output of every run is appended to `kitchen/reports/WO-5b-seed.txt`. The run counter lives in
`packages/agents/.moolam/seed-state.json`, which is gitignored, so deleting it starts the numbering
over and draws the same pictures again.

The thumbnail is a baseline JPEG, longest side 512 pixels, and the script drops the quality until
the file is under 60,000 bytes. Two constraints set that: the Chainlink workflow fetches through
`https://gateway.pinata.cloud/ipfs/` with a 100 KB cap, and it decodes with jpeg-js, which reads
baseline files only. A progressive thumbnail would fail every verification.

Needs in the root `.env`: `MONAD_MAINNET_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `PROOF_P256_PRIVATE_KEY`
and `PINATA_JWT`. The two mainnet runs recorded in the report cost 376,178 and 376,166 gas, about
0.0384 MON each at the price of the day, because Monad bills the gas limit rather than the gas used.

## Proving the Privy side

`npm run prove:privy` from the repo root runs the four Privy features that Moolam is built on,
against Monad mainnet, and prints a transaction hash or the exact refusal for every one. The output
is saved to `kitchen/reports/WO-4-output.txt`.

**Server wallets with a policy.** The generator agent's key lives in Privy's secure enclave, not on
our server. Its policy allows exactly two things: send a `register` call to the Moolam registry on
chain 143 carrying no MON, and sign an EIP-712 message whose domain is that same registry. Privy
denies any method or destination no rule names, so the agent cannot move funds, cannot call another
contract, and cannot sign for another app even if this machine is taken over.

**The agent's signature comes out of the enclave.** `register` only writes a Generated passport if
the owner of the ERC-8004 agent signed the same digest the creator's passkey signed. That signature
is produced by Privy typed data signing, and the script recovers the address from it locally before
spending gas, so the run fails on this machine rather than on chain if the two ever disagree.

**Session signers.** The creator owns their wallet. They grant the app a separate key, registered
with Privy as a one of one key quorum, permission to sign on that wallet, scoped by a second policy
that allows `appendEdit` and nothing else. That is what lets an editing session write ten edits
without ten passkey prompts. When the permission is taken back, the same call from the same key is
refused by Privy before it can reach Monad.

**Gas sponsorship.** The creator's first transaction is attempted with `sponsor: true`. On the run
recorded in the report, Privy answered `HTTP 400 invalid_data: Gas sponsorship is not enabled`, so
the script printed `sponsorship: not enabled, paid by wallet` and the wallet paid. Turning it on is
a dashboard setting under Wallet Infrastructure, App pays, with Monad ticked. Nothing in the output
claims a sponsored transaction that did not happen.

What a judge sees, in the order the script prints it:

1. The generator's wallet address, its policy id, and the ERC-8004 agent id it owns.
2. The creator's wallet and the passkey bind transaction, with whether it was sponsored.
3. A passport registered by the generator wallet under that policy, with the token id.
4. The same wallet refused when it tries to send MON: `policy_violation`, no transaction.
5. The same wallet refused when it tries `appendEdit`: same contract, wrong function.
6. An edit written on the creator's wallet by the app's session signer, co-signed by the agent.
7. The permission revoked, and the same call refused with Privy's own error text.

Two honest notes. There is no browser in this proof, so the creator's wallet is a Privy server
wallet standing in for the embedded wallet a user would get on login, and the session signer is
granted through `wallets().update` with `additional_signers`, which is the server side of what the
React SDK calls `addSigners`. And the generator mints its ERC-8004 identity before its policy goes
on, because the policy forbids calls to any other contract; a rerun skips that step and the wallet
stays locked down.

The wallet ids, the policy ids and the agent id are cached in `packages/agents/.moolam/wallets.json`
so a second run reuses everything and only sends the three transactions. The app's session key and
the creator's passkey key live next to it in the same gitignored folder and are never printed.

Needs in the root `.env`: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`,
`MONAD_MAINNET_RPC_URL`, `DEPLOYER_PRIVATE_KEY` and `PINATA_JWT`. The first run funds the two
Privy wallets with 12 MON each from the deployer, because Monad reserves 10 MON per account and a
wallet below that cannot pay for anything.

## What each action costs

Measured by `npm run proof:anvil`, saved in `kitchen/reports/WO-4a-anvil-proof.txt`. Anvil answers
the P-256 precompile at `0x0100` the same way Monad does, checked directly against OpenZeppelin's
own probe vector, so these figures are close to the real thing rather than the much larger cost of
the pure Solidity fallback. Monad bills the gas limit you declare, not the gas you use.

| Action | Gas on the fork | In plain English |
| --- | --- | --- |
| Bind a passkey | 117,538 | One time per wallet, before it can register anything. |
| Register a Captured photo | 308,911 | Checks the WebAuthn signature, writes the record, mints the token. |
| Register an agent on ERC-8004 | 450,903 | One time per agent. Paid to the ERC-8004 registry, not to us. |
| Register a Generated image | 371,986 | The Captured cost plus the agent signature check and the ERC-8004 ownership read. |
| Append an edit | 353,983 | No passkey prompt. Holding the parent token is the authority. |

On mainnet through Privy wallets, with the limit set to the estimate plus ten percent, the last
`npm run prove:privy` run paid 0.0072 MON to rebind the passkey, 0.0422 MON to register and 0.0492
MON to append an edit, all at 102 gwei.

The gas figures the contracts package publishes are the ones to quote for mainnet: they are
measured in Foundry's Monad network family, which prices gas the way the chain we ship on does.
