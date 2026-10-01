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

## Claim with your email

In platform mode the passport starts in your wallet. Add `deliverTo` and it waits at Moolam for your user's verified email instead of waiting for you to find their wallet. When that person signs in to Moolam with the same address, they see the picture and say "these are mine" or "not mine". If they accept, Moolam tells your server where to send it, and your delivery worker hands it over.

```ts
const result = await registerAsPlatform(pictureBytes, {
  verifyUrl, platformKey, agentAccount, passkey, walletClient, title, terms,
  deliverTo: { email: user.email, verifiedBy: "google" },
});
// result.transfer is null: the passport waits for the person.
// It is the hand-over, when the person already asked Moolam to send your pictures straight to their wallet.
```

Only send an address you verified for that user. Moolam checks that the person who sees the picture proved the address to Moolam; it cannot check that the address belongs to the person who used your platform. That part is your word, and Moolam shows it to the person as yours. `verifiedBy` says how you checked: `"google"` for a Google sign-in on your platform, `"email-code"` for a code you sent to the address, `"platform"` for anything else.

The email travels only in the body of the prepare request, over https. The kit never puts it in a URL, never logs it, and its errors never quote it.

When the person has already asked Moolam to send your pictures straight to their wallet, the prepare answer names that wallet, and `registerAsPlatform` registers, writes the terms and transfers in one call, after the same address checks `transferPassport` applies. A wallet the kit refuses stops the call before anything is sent.

Run one delivery worker on your server:

```ts
import { runDeliveries } from "@moolam/platform";

const worker = await runDeliveries({ verifyUrl, platformKey, walletClient, publicClient, intervalMs: 5_000, maxTries: 3 });
// On shutdown:
await worker.stop();
```

Every interval it asks Moolam which passports their people have accepted. For each one it reads the registry and skips it unless your wallet still holds it, checks the destination by the same rule as `transferPassport`, simulates the transfer and only then sends it, and never sends a ticket twice in one poll. After `maxTries` failed attempts (3 by default) it tells Moolam the hand-over failed, so the person sees it, and stops trying that one. Each hand-over costs your wallet about 95,000 gas. The worker logs nothing and throws nothing once started; `stop()` lets the hand-over in flight finish and starts no other. It keeps its count of failed attempts in memory, so a restart gives each waiting ticket a fresh `maxTries`.

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
