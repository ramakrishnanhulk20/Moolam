---
title: For platforms
---

# For platforms

The platform kit lets an AI image company give every picture it makes a Moolam passport on Monad,
naming its own ERC-8004 agent as the maker. It is a TypeScript package for the company's server,
`@moolam/platform`, and four routes on Moolam's verify service that sign the C2PA manifest,
fingerprint the picture and hand back the passport fields.

> **Not live yet.** The routes, the package and the MCP server are in the code and tested, and they
> go live with the next deploy of the verify service. Until then, `https://<verify-service>` on this
> page is a placeholder for its address. Moolam's platform list is empty today, so every platform key
> is refused until the first signed entry is committed. The package is private to this repository
> and not on npm yet.

## The two modes

A platform picks a mode for each picture.

| | Platform mode | Co-sign mode |
| --- | --- | --- |
| Who signs as the maker | Your agent's owner key | Your agent's owner key |
| Who signs as the creator | Your server passkey, bound once to your wallet | The person, with their own passkey, on a Moolam page |
| Who sends the transaction and pays | Your wallet | The person's Moolam wallet, with the fee paid by Moolam |
| Who holds the passport first | Your wallet | The person |
| What it needs from the person | Nothing | Opening a link, signing in, one passkey signature |
| Pick it when | You generate at volume, or your users have no Moolam account | The person should be the creator on chain from the first block |

In platform mode one company holds both keys the registry asks for. The chain records the same
fields it records for anyone, and Moolam says exactly what that proves: a key bound to the creator
wallet signed the fingerprint, and your agent's owner signed it too. A person can hold the passport
later through a transfer.

In co-sign mode your server prepares the picture and your agent signs, and the person finishes it on
a page at `https://moolam.vercel.app/cosign#<handle>`. The handle travels after the `#`, so it never
reaches a server log, an analytics tool or a `Referer` header. The co-sign page ships with the same
deploy that turns the kit on.

## Joining the list

Moolam keeps one public list of platforms, `packages/verifier/src/platforms/platforms.json`, copied
byte for byte into the web app. No route writes it. A Moolam operator adds an entry with
`scripts/platform-add.ts` and commits it, so every change is in git history.

**What an entry holds.** Your platform's name, your ERC-8004 agent id, the address that owned the
agent when you joined, your creator wallet, the sha256 of your Moolam key, one to four https origins
your site opens Moolam from, the time the entry starts (`validFrom`), the time it ends (`validTo`,
set only when it is replaced), the time the operator accepted it, and two signatures.

**What each signature proves.** Both are EIP-712 signatures over one `PlatformOnboarding` message in
the domain `Moolam platform`, version 1, chain 143, covering the name, agent id, agent owner,
creator wallet, key hash, origins and start time.

- The agent owner's signature proves that whoever holds the key of the address named as your agent's
  owner agreed to be listed under this name, with this wallet, this key and these origins.
- The creator wallet's signature proves the wallet that will be the creator of every platform-mode
  passport agreed to the same.
- The operator's acceptance is running the script and committing the entry. It is recorded as
  `acceptedAt` and is not a signature.

**How the list is checked.** The service and the web app check every signature when they load the
list, offline, with no network call. One bad entry refuses the whole list, and a refused list means
no platform routes and no labels anywhere, never a partial list. Names are stored cleaned (NFKC,
trimmed, one space between words), at most 48 characters, printable, and unique after case folding.
One name belongs to one agent, one agent and one creator wallet to one name, a key hash appears
once, and two entries of one platform never overlap in time. Origins are stored in the one canonical
form `new URL(origin).origin` gives, https only, with no path.

What the list does not prove: who the company is. Moolam checks that you hold the keys you name.

**Your Moolam key.** The operator's script makes 32 random bytes and prints them once, as 64 hex
characters, to hand to you over a private channel. Nothing writes the key to a file. The list stores
only its sha256, which is safe to publish and is your platform's id in every PlatformPrepare message.
You send the key as `Authorization: Bearer <64 hex characters>` and nowhere else. Moolam cannot show
it to you again.

The key identifies your platform and meters it. Alone it cannot make a manifest: every prepare also
needs your agent owner's signature, checked against the ERC-8004 registry at that moment. A leaked
key costs you quota, not your name.

**Rotation.** Each key can be replaced without touching passports already registered.

| What changes | How | What happens to labels |
| --- | --- | --- |
| Your Moolam key | A new key from the script, both signatures again, then `platform-add.ts rotate --replaces <old key hash>`. The old entry gets `validTo` set to the new entry's `validFrom` | Passports registered before the switch keep the label under the old entry, later ones take it under the new |
| Your creator wallet | The same rotation, naming the new wallet, then `setupPlatform` from the new wallet | The same |
| Your server passkey | `setupPlatform({ walletClient, rpId, rotate: true })` from the same wallet. No list change | None |
| Your agent's owner | A transfer on the ERC-8004 registry. Prepares follow the owner read at that moment, so the new owner signs from then on. Sign a new entry by rotation so the list names the new owner again | Earlier passports keep theirs |

Your agent id cannot change under the same name. A new agent is a new platform.

## Before your first picture

1. Register an ERC-8004 agent on Monad's identity registry,
   `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, from a plain key. The Moolam registry recovers the
   maker's signature with ECDSA and compares it with `ownerOf(agentId)`. It does not accept a
   contract signature, so an agent held by a multisig cannot sign for Moolam.
2. Pick a wallet for platform mode that holds no passports yet, and fund it with MON.
3. Send Moolam your name, agent id, agent owner address, creator wallet and origins. Sign the typed
   data the operator sends back from the agent owner key and from the creator wallet, and keep the
   Moolam key the operator hands you.
4. For platform mode, run `setupPlatform` once from the creator wallet.

## The secrets you keep

| Secret | Needed for | Why it matters |
| --- | --- | --- |
| Moolam platform key | Both modes | It identifies and meters your platform. Sent only in the `Authorization` header |
| Agent owner key | Both modes | It signs as your agent on every picture. Whoever holds it can make pictures in your agent's name. Any viem local account works, including one backed by a key vault |
| Server passkey private key | Platform mode | The creator key bound to your wallet. `setupPlatform` returns it once and the kit never writes, logs or sends it |
| Platform wallet key | Platform mode | It pays for and holds platform-mode passports |

The package runs on your server only, never in a browser. It logs nothing, and its errors never
carry a key, a private key or a co-sign handle, so they are safe to log.

## Quickstart

### One-time setup (platform mode)

```ts
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { setupPlatform } from "@moolam/platform";

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.PLATFORM_WALLET_KEY as Hex),
  chain: monad,
  transport: http(),
});

const setup = await setupPlatform({ walletClient, rpId: "images.example.com" });

// Shown once and never again. Put it in your secret store before anything else.
await saveSecret("MOOLAM_PASSKEY_KEY", setup.passkeyPrivateKey);
console.log(`bound ${setup.qx} to ${setup.wallet} in ${setup.bindTx}`);

declare function saveSecret(name: string, value: string): Promise<void>;
```

`setupPlatform` makes a P-256 key and binds it on the registry as your wallet's creator key, sent and
paid by that wallet. Before anything is signed it refuses a wallet that already has a passkey bound
(unless `rotate: true`), a wallet that already holds passports (unless it is rotating a key it
already has), and an `rpId` that is Moolam's hostname, `localhost`, an IP address, a single word, or
anything the URL parser would rewrite. Use your own public hostname. Nothing on chain reads the
`rpId`, so it is your honest label for the key, not a proof.

### Platform mode

```ts
import { readFile, writeFile } from "node:fs/promises";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { ServerPasskey, registerAsPlatform } from "@moolam/platform";

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.PLATFORM_WALLET_KEY as Hex),
  chain: monad,
  transport: http(),
});
const agentAccount = privateKeyToAccount(process.env.AGENT_OWNER_KEY as Hex);
const passkey = ServerPasskey.fromPrivateKey(process.env.MOOLAM_PASSKEY_KEY as Hex, "images.example.com");

const picture = new Uint8Array(await readFile("lighthouse.png"));

const registered = await registerAsPlatform(picture, {
  verifyUrl: "https://<verify-service>",
  platformKey: process.env.MOOLAM_PLATFORM_KEY ?? "",
  agentAccount,
  passkey,
  walletClient,
  title: "A lighthouse at dusk",
  terms: { aiTraining: "notAllowed", aiInference: "constrained", constraintInfo: "Ask licensing@example.com" },
});

// Serve these bytes, never the original upload: their sha256 is the passport id.
await writeFile(`${registered.passportId}.jpg`, registered.signedFile);
console.log(registered.registerTx, registered.consentTx);
```

What happens, in order:

1. Your agent owner signs a PlatformPrepare: the mode, the picture's sha256, your platform id, a fresh
   random nonce and the latest block's time.
2. The service checks your key, then that signature against the agent's owner read on chain now. It
   signs a C2PA manifest naming your agent, fingerprints the signed picture, pins four files and
   answers with the passport fields, the digest and the signed file.
3. The kit checks the signed file hashes to the passport id, that the creator is your wallet, that
   the terms in the manifest are the terms you sent, and rebuilds the digest itself. Any difference
   stops it before anything is signed.
4. Your agent signs the passport, your server passkey signs the same digest, and your wallet sends
   `register`, then `setConsent` with the same terms.

Nothing is sent on chain until every check passes, and a result comes back only from receipts with
status success.

### Co-sign mode

```ts
import { readFile } from "node:fs/promises";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { signAsAgent, startCosign, waitForCreator, waitForPassport } from "@moolam/platform";

const publicClient = createPublicClient({ chain: monad, transport: http() });
const agentAccount = privateKeyToAccount(process.env.AGENT_OWNER_KEY as Hex);
const picture = new Uint8Array(await readFile("lighthouse.png"));

const handle = await startCosign(picture, {
  verifyUrl: "https://<verify-service>",
  platformKey: process.env.MOOLAM_PLATFORM_KEY ?? "",
  agentAccount,
  publicClient,
  title: "A lighthouse at dusk",
  terms: { aiTraining: "notAllowed" },
});

// The link is the person's key to the page. Send it to them and to nobody else.
await sendToUser(handle.cosignUrl);
// Keep the 32 hex characters too, so a restart can pick the co-sign up again.
await saveHandle(handle.handle, handle.passportId);

const digest = await waitForCreator(handle);
await signAsAgent(handle, digest);
const passport = await waitForPassport(handle);
console.log(`${passport.passportId} registered by ${passport.creator} at ${passport.registeredAt}`);

declare function sendToUser(link: string): Promise<void>;
declare function saveHandle(handle: string, passportId: Hex): Promise<void>;
```

- `startCosign` signs a PlatformPrepare in co-sign mode. The service signs the manifest, computes
  every file's IPFS content id, and freezes the files on its own disk. **Nothing is pinned yet.**
- The person opens the link and signs in. Their Moolam wallet becomes the creator, set once, from
  their verified session. A second wallet opening the same link is refused.
- `waitForCreator` polls until then, rebuilds the digest from the fields, the person's wallet and the
  deadline, and refuses a digest the service computed differently.
- `signAsAgent` signs that digest as your agent. The service accepts the signature only if it
  recovers to your agent's owner read now, then pins the frozen files and checks each content id is
  the one the passport names. Only then may the person's page ask for their passkey.
- `waitForPassport` returns only after the registry holds this passport with this creator, agent,
  manifest and metadata.

The person's wallet sends `register`, and only a passport's holder can state its AI-use terms on
chain, so in this mode the terms you sent are in the manifest and the metadata, and the person states
them on chain.

**After a restart.** Keep `handle.handle`, the 32 hex characters, and pick the co-sign up again:

```ts
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { resumeCosign, signAsAgent, waitForCreator, waitForPassport } from "@moolam/platform";

const publicClient = createPublicClient({ chain: monad, transport: http() });
const agentAccount = privateKeyToAccount(process.env.AGENT_OWNER_KEY as Hex);

const handle = await resumeCosign(await loadHandle(), {
  verifyUrl: "https://<verify-service>",
  platformKey: process.env.MOOLAM_PLATFORM_KEY ?? "",
  agentAccount,
  publicClient,
});

const digest = await waitForCreator(handle);
await signAsAgent(handle, digest);
await waitForPassport(handle);

declare function loadHandle(): Promise<string>;
```

`resumeCosign` reads the record's status and returns the same kind of handle, so the three calls
carry on from wherever the record is, with the same checks. A handle another key made is refused as
not found. Store the handle like the link: it opens the person's page.

**The signed file in co-sign mode.** The files are pinned when your agent signs. The passport's
metadata document, which the chain names, gives the signed picture's IPFS address as `image`, and its
sha256 is the passport id. Hash it before you serve it.

### Handing a passport to a person

```ts
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { MoolamPlatformError, transferPassport } from "@moolam/platform";

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.PLATFORM_WALLET_KEY as Hex),
  chain: monad,
  transport: http(),
});

try {
  const moved = await transferPassport(await passportIdToHandOver(), await addressTheyGaveYou(), walletClient);
  console.log(`${moved.passportId} now held by ${moved.to}, in ${moved.txHash}`);
} catch (error) {
  if (error instanceof MoolamPlatformError && error.code === "refused-recipient") {
    console.log(error.message);
  } else {
    throw error;
  }
}

declare function passportIdToHandOver(): Promise<Hex>;
declare function addressTheyGaveYou(): Promise<string>;
```

`transferPassport` refuses a mixed-case address whose checksum is wrong, the zero address, your own
wallet and the registry, uses `safeTransferFrom`, and returns only after a successful receipt and a
fresh `ownerOf` read that names the new holder. The terms your wallet stated stay in force until the
new holder states their own, and the history shows who wrote each. The person can hand you their
address through Moolam's connect page, which ships with the co-sign page: it names your platform from
the list and posts the address only to one of your listed origins, after they click.

### Errors

Every refusal is a `MoolamPlatformError` with a `code` to branch on and `details` that never carry a
secret.

```ts
import { MoolamPlatformError, registerAsPlatform } from "@moolam/platform";

type Options = Parameters<typeof registerAsPlatform>[1];

async function register(picture: Uint8Array, options: Options) {
  try {
    return await registerAsPlatform(picture, options);
  } catch (error) {
    if (!(error instanceof MoolamPlatformError)) throw error;
    if (error.code === "service-refused" && error.details.status === 429) {
      return null; // A daily limit: try again after the reset.
    }
    if (error.code === "consent-failed") {
      // The passport landed and the terms did not. Send setConsent again with the same terms.
      console.log(error.details.passportId, error.details.registerTx);
    }
    throw error;
  }
}

export { register };
```

| Code | Means |
| --- | --- |
| `invalid-input`, `invalid-rp-id`, `invalid-terms` | Your input was refused before anything was sent |
| `wrong-chain` | The client is not on Monad, chain 143 |
| `passkey-already-bound`, `passkey-not-bound`, `wallet-holds-passports` | Setup or rotation rules, see above |
| `service-refused` | The verify service said no. `details.status` and `details.error` carry its code, listed in the [API reference](../api/verifier-endpoints#post-platformprepare) |
| `service-unreachable`, `unexpected-answer` | No answer in time, or an answer in a shape the kit does not accept |
| `digest-mismatch`, `signed-file-mismatch`, `terms-mismatch`, `creator-mismatch` | The service's answer disagreed with what the kit rebuilt. Nothing was signed |
| `creator-not-set`, `deadline-passed`, `cosign-expired`, `timed-out` | A co-sign step came too early or too late |
| `passport-taken` | Another passport already holds this picture |
| `transaction-failed` | A transaction would revert, so it was not sent, or it reverted |
| `consent-failed` | The passport is registered and the terms are not. Send `setConsent` again |
| `refused-recipient`, `not-holder` | A transfer the kit will not make |

## Limits

| Limit | Value |
| --- | --- |
| Prepares per platform key | 100 in a rolling 24 hours, `PLATFORM_PREPARES_PER_KEY_PER_DAY` on the service |
| Prepares for every platform together | 500 per UTC day, `GLOBAL_PLATFORM_PREPARES_PER_DAY`. It holds even when a key leaks, and 0 closes the route for everyone |
| Requests | 60 a minute per address, like every route on the service |
| The picture | JPEG, PNG or WebP, up to 20 MB and 40 megapixels |
| The title | 1 to 120 characters |
| The terms | `aiTraining`, `aiGenerativeTraining`, `aiInference` and `dataMining`, each `allowed`, `notAllowed` or `constrained`. `constraintInfo` is required exactly when one is constrained: at most 256 bytes of printable ASCII, with no space at either end |
| The prepare window | `issuedAt` at most ten minutes before chain time and at most 60 seconds after it. A nonce is accepted once, and the same picture once per platform inside the window |
| A co-sign link | Open for 30 minutes of chain time after the prepare (`openBy`) |
| A co-sign deadline | 30 minutes of chain time from the moment the person opens the link |
| Frozen files per key | 100 MiB, five full uploads, in co-signs still waiting for a creator or a signature |
| Waiting co-signs on the service | 5,000 at most |

Every window is read against the latest block's time, never a server clock. A prepare that is
refused before anything that costs Moolam lands gives its quota slot back. Status stays readable for
a day after a record's deadline.

The quotas, the replay memory and the waiting co-signs live on the service's volume at `/data`, so a
redeploy keeps them. The service runs one copy, so each deploy has a short gap: a request sent during
it fails and must be sent again, and a co-sign whose deadline passes inside the gap is lost.

## What it costs on Monad mainnet

Monad charges the gas limit a transaction sets, not the gas it used. Measured on mainnet on
2026-09-30 at about 102 gwei, from receipts unless the row says estimate:

| Action | Paid by | Gas | MON |
| --- | --- | --- | --- |
| Register your ERC-8004 agent, once | You | 411,369 | 0.042 |
| Bind your server passkey, once | You | 130,034 | 0.013 |
| Register one picture in platform mode | You | 413,634 | 0.042 |
| State its terms with `setConsent` (estimate; a longer condition costs more) | You | 107,067 to 239,917 | 0.011 to 0.024 |
| Hand a passport to a person (estimate) | You | 95,149 | 0.010 |
| Register one picture in co-sign mode, sponsored | Moolam | 657,678 to 678,128 | 0.067 to 0.069 |
| A sponsored `setConsent` | Moolam | 321,392 to 374,141 | 0.033 to 0.038 |

The C2PA signing and the four IPFS pins of every prepare are Moolam's cost in both modes. A new
platform wallet that sets up, registers ten pictures with terms and hands one over spends about
0.73 MON; fund it with 1.5 MON for the margin a gas limit and a failed attempt need.

## What the label on a passport means

A passport your platform registered in platform mode carries this line on its passport page:

> Registered by *your platform* through the Moolam platform kit

and under it:

> *Your platform*'s own server key signed as the creator, and its agent signed as the maker. Moolam
> checked that the company holds both keys, not who the company is.

Its plate in Explore carries the platform's mark, and the MCP server's `get_passport` answers with
`platform: { status: "kit", name, creatorWallet, agentId }`.

A co-sign passport's creator is the person, so it carries no platform label. Its page names your
agent by its ERC-8004 id, with the name your agent's own card gives, marked as the card's own word,
and the MCP server's `get_agent` answers with the name Moolam lists for that agent.

Every passport's base line stays the same with or without the list: "A key bound to this creator's
wallet signed this picture's fingerprint on Monad." The label is added on top, so losing the list
loses a label and never adds a claim.

One function issues it, `platformLabel` in `packages/verifier/src/platforms/platforms.ts`, used by
the service and, as a byte for byte copy, by the web app. It gives the label only when all of these
hold:

- the passport's creator is your listed creator wallet;
- it is Generated, by your listed agent;
- it carries a C2PA manifest;
- it was registered inside your entry's window, from `validFrom` up to `validTo`.

**When it is withheld.**

- A passport from your listed wallet that fails any of those reads: "This wallet is listed as
  *your platform*, but this picture was registered outside the Moolam platform kit."
- A passport registered after an entry was replaced takes its label from the new entry, or none.
- A list that fails to load gives no label anywhere.
- When your agent's owner changes after you joined, `get_agent` answers `ownerUnchanged: false`, and
  Moolam's co-sign page shows your platform's badge only while the owner read now is the owner that
  signed your entry. Passports already registered keep their label, because it is judged on the
  fields the chain recorded when they were made.

When the holder is not the creator, every reader says both: "Registered by *creator*. Now held by
*holder*." A passport someone holds but did not make is listed apart in their pictures, never as
their work.

## What the kit does not promise

- Moolam does not check who the company behind an agent is. It checks that the listed keys signed.
- The chain cannot tell a server key from any other passkey, and Moolam does not pretend it can. A
  platform-mode passport is one company holding two keys.
- It cannot vouch that a listed platform's generator made what the platform says it made.
- It cannot make a platform hand a passport over, or tell a correctly typed wrong address from the
  right one.
- Your key custody, your copy of the package and your users' identity are yours.
- In platform mode your server holds the signed file before it registers, and in co-sign mode the
  files are public on IPFS from your agent's signature until the person signs. Whoever registers
  those bytes first holds the passport; the prepare refuses a picture already registered.
- A look-alike name in another script can pass the name check, which is why the label always sits
  beside the wallet and the agent id.

The full list of what is checked, where and by which test is in the
[threat model](../security/threat-model#the-platform-kit-and-the-mcp-server). The routes are in the
[API reference](../api/verifier-endpoints#post-platformprepare), and AI agents read passports through
the [MCP server](mcp).
