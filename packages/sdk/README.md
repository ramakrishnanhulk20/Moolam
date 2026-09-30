# @moolam/platform

The Moolam platform kit. An image generator installs this package and gives every picture it makes a Moolam passport on Monad: a permanent record that says which ERC-8004 agent made the picture, who registered it, and what AI use its maker allows. Anyone can later check a copy of the picture against that record, even after it has been re-encoded.

The package runs on the platform's server, never in a browser. It is private to this repo for now and is not published.

## The two modes

The platform picks a mode for each picture.

- **Platform mode.** The platform registers the picture itself, in one pass. Its agent signs as the maker, its server passkey signs as the creator key, its wallet sends the transaction and pays, and the passport starts in the platform's wallet. A person can claim it later by transfer. On chain this is one party holding two keys, and Moolam says so plainly: the record proves those keys signed, not that a person touched a phone.
- **Co-sign mode.** The platform hands its user a link to a Moolam page. The person signs in, sees the picture, the agent and the terms, and signs with their own passkey. The passport is theirs from the start, and Moolam pays the network fee.

## Quickstart: platform mode

```ts
import { createWalletClient, http, type Hex } from "viem";
import { monad } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { registerAsPlatform, ServerPasskey } from "@moolam/platform";

const walletClient = createWalletClient({ account: privateKeyToAccount(process.env.PLATFORM_WALLET_KEY as Hex), chain: monad, transport: http() });
const passkey = ServerPasskey.fromPrivateKey(process.env.MOOLAM_PASSKEY_KEY as Hex, "images.your-platform.com");
const agentAccount = privateKeyToAccount(process.env.AGENT_OWNER_KEY as Hex);

const { passportId, signedFile } = await registerAsPlatform(pictureBytes, { verifyUrl: process.env.MOOLAM_VERIFY_URL!, platformKey: process.env.MOOLAM_PLATFORM_KEY!, agentAccount, passkey, walletClient, title: "A lighthouse at dusk", terms: { aiTraining: "notAllowed" } });
// Serve signedFile, not pictureBytes: its sha256 is the passport id.
```

Before the first picture, run the one-time setup once from the same wallet and store what it returns:

```ts
import { setupPlatform } from "@moolam/platform";

const setup = await setupPlatform({ walletClient, rpId: "images.your-platform.com" });
// Put setup.passkeyPrivateKey into your secret store now. It is shown once and never again.
```

`setupPlatform` refuses a wallet that already has a passkey bound (pass `rotate: true` to replace it on purpose), refuses a wallet that already holds passports, and refuses an `rpId` that is Moolam's hostname, `localhost`, an IP address, or anything that is not your own hostname written plainly.

To replace the server passkey later, for example after a leak, call `setupPlatform({ walletClient, rpId, rotate: true })` from the same wallet and store the new `passkeyPrivateKey` in place of the old one. A working platform's wallet holds its passports, so rotation goes ahead on a wallet that holds some, but only when a key is already bound to it: a wallet with no key bound that holds passports is still refused, because there is nothing to rotate. Passports registered under the old key stay as they are.

## Co-sign mode

```ts
import { startCosign, waitForCreator, signAsAgent, waitForPassport } from "@moolam/platform";

const handle = await startCosign(pictureBytes, { verifyUrl, platformKey, agentAccount, publicClient, title, terms });
// Send handle.cosignUrl to your user, and to no one else: it is their key to the page.
const digest = await waitForCreator(handle);
await signAsAgent(handle, digest);
const passport = await waitForPassport(handle);
```

`waitForCreator` rebuilds the digest from the record's fields and the person's wallet and refuses a digest the service computed differently. `waitForPassport` returns only after the registry itself holds this passport with this creator, agent, manifest and metadata.

If your server restarts while a co-sign is open, keep `handle.handle` (the 32 hex characters, not the link) and pick it up again with `const handle = await resumeCosign(savedHandle, { verifyUrl, platformKey, agentAccount, publicClient })`. It reads the record's status from Moolam and returns the same kind of handle, so `waitForCreator`, `signAsAgent` and `waitForPassport` carry on from wherever the record is, with the same checks. Store the handle like the link: it is the person's key to the page.

## Handing a passport to a person

```ts
import { transferPassport } from "@moolam/platform";

const moved = await transferPassport(passportId, claimedAddress, walletClient);
```

It refuses a mistyped address (a wrong checksum is refused, not guessed), the zero address, your own wallet and the registry, uses `safeTransferFrom`, and returns only after a successful receipt and a fresh `ownerOf` read that names the new holder. Until the new holder states their own terms, the platform's terms stay in force.

## What the platform must keep secret

| Secret | Where it goes | Why it matters |
|---|---|---|
| Moolam platform key | Your server's secret store; sent only in the Authorization header | It identifies and meters your platform. Alone it cannot make a manifest: every prepare also needs your agent owner's signature. |
| Agent owner key | Your secret store or a key vault (any viem local account works) | It signs as your ERC-8004 agent on every picture. Whoever holds it can make pictures in your agent's name. |
| Server passkey private key | Your secret store | It is the creator key bound to your wallet. The kit returns it once from `setupPlatform` and never writes, logs or sends it. |
| Platform wallet key | Your secret store | It pays for and holds platform-mode passports. |

The kit never logs anything, and its errors never carry a key, a private key or a co-sign handle, so they are safe to log.

## What each action costs on Monad

Measured on Monad mainnet at about 102 gwei (Monad charges the gas limit a transaction sets):

| Action | Gas | MON |
|---|---|---|
| One-time setup: bind the server passkey | about 130,000 | about 0.013 |
| Register one picture in platform mode | about 414,000 | about 0.042 |
| State its AI-use terms | 107,000 to 240,000 (more with a longer condition) | 0.011 to 0.024 |
| Hand a passport to a person | about 95,000 | about 0.010 |

Registering the platform's ERC-8004 agent, done once outside this kit, costs about 0.042 MON. In co-sign mode the platform pays nothing on chain.

## Tests

```bash
cd packages/sdk && npx vitest run
```

The fork tests start a local anvil fork of Monad mainnet (Foundry's `anvil`, found on the path or in `~/.foundry/bin`) from `MONAD_MAINNET_RPC_URL` in the repo root `.env`, and run against the live registry, consent and ERC-8004 contracts at their mainnet addresses, with the verify service answered at the HTTP level. Nothing is sent to Monad mainnet.
