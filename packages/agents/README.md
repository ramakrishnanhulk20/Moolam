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

The gas figures the contracts package publishes are the ones to quote for mainnet: they are
measured in Foundry's Monad network family, which prices gas the way the chain we ship on does.
