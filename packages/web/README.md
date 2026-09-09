# @moolam/web

The Moolam app. It reads passports, agents and verification results from Monad
mainnet, takes an image upload and finds the passport it belongs to, and gives a
creator a wallet without a seed phrase.

This package is the shell: routing, the two themes, the ten languages, the
providers, the live readers and every screen's pending, empty and error state.
The hero and the rest of the visual work land in later builds, which is why the
home page carries a `SWAP: hero` comment where the real one goes.

## Running it

From the repo root:

```sh
npm run dev:web -- -p 3210   # http://localhost:3210
npm run build:web   # a production build
npm run lint:web
```

A verification build must never write into the directory the dev server is
serving from:

```sh
NEXT_DIST_DIR=.next-verify npm run build --workspace packages/web
```

The verify page needs the verifier service. Start it from the repo root with
`npm run dev:verifier`; without it the page says so and names the command.

## Routes

| Route | What it is |
| --- | --- |
| `/` | Sends the visitor to the default language. |
| `/[locale]` | The home page: the placeholder hero and the newest passports, read live. |
| `/[locale]/verify` | Upload any copy of an image and see which passport it matches. |
| `/[locale]/passport/[id]` | One passport: the record, its verifications and its edits. |
| `/[locale]/agent/[id]` | One generator agent: its card and its ERC-8004 reputation. |
| `/[locale]/studio` | Sign in with Privy, bind the passkey on this device once, register an image with the network fee paid by Moolam. |
| `/[locale]/lab` | The hidden bench for visual work. Nothing links to it. |
| `/api/passports` | The newest passports as JSON. |

Ten languages exist today: `/en`, `/ta`, `/hi`, `/zh`, `/ja`, `/ko`, `/es`,
`/fr`, `/de` and `/pt`. Every one carries the same 432 keys, and each message
file opens with a `_glossary` block so the product words stay the same word
throughout that language. The switch in the header lists all ten in their own
script and marks the current one.

Another language is three steps: add the code and its native name to
`lib/i18n/routing.ts`, drop a matching file into `messages/`, and, if it needs
glyphs the Latin faces do not carry, add its face to `lib/fonts.ts`. No component
holds a string of its own.

Numbers, dates and hashes are never translated. They go through `Intl` with the
page's locale, from `next-intl`'s formatter.

## Where the data comes from

Everything on every screen is read live. There is no sample data anywhere.

- **Passports, attestations, edits, owners:** `lib/chain/registry.ts`, straight
  from `MoolamRegistry` at the address in
  `packages/contracts/deployments/monad-mainnet.json`, using the ABIs in
  `packages/contracts/abi`.
- **Agents:** `lib/chain/agents.ts`, from the ERC-8004 identity registry. The
  agent card is whatever `tokenURI` points at, including a `data:` URI.
- **Reputation:** `lib/chain/reputation.ts`, from the ERC-8004 reputation
  registry, filtered by the two tags the verifier writes.
- **The latest-passports strip:** `lib/data/source.ts` picks the index. With
  `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` set it queries Envio; without it, it reads the
  registry's own `PassportRegistered` events. The footer prints which one
  answered, on every page.
- **Verification and preparation:** the browser posts straight to the verify
  service at `NEXT_PUBLIC_VERIFIER_URL` (`/verify` for anyone, `/prepare` with the
  creator's Privy access token from the studio). The service allows the app's origin
  through `CORS_ORIGINS`, which is why a 20 MB upload works on Vercel: no function
  sits in the middle.

## Environment

Copy `.env.example` to `.env.local`. Only `NEXT_PUBLIC_` values reach the
browser, so nothing secret may carry that prefix.

| variable | meaning |
| --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app id. Without it every page still works and the studio says Privy is not configured. |
| `NEXT_PUBLIC_MONAD_RPC_URL` | Monad mainnet RPC. Defaults to `https://rpc1.monad.xyz`, which allows a wide `eth_getLogs` range. `https://rpc.monad.xyz` caps it at 100 blocks and the strip then falls back to a slow backwards scan. |
| `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` | Optional. Set it to read passports from Envio instead of the chain. |
| `VERIFIER_BASE_URL` | Server side only. Where the verifier service listens, `http://localhost:4010` in development. |

The values are checked at boot in `lib/env.ts`, so a malformed URL names itself
before a page renders rather than inside a fetch later.

## How it is put together

- **Themes.** Two palettes of CSS variables in `styles/globals.css`, dark by
  default, switched by the class `next-themes` writes on `<html>`. One accent
  does all the decorative work; the status colours are a separate, colder family.
- **Motion.** Lenis smooth scroll and GSAP's ScrollTrigger share one animation
  frame loop in `components/providers/LenisProvider.tsx`. Framer Motion handles
  entrances in client components, and a plain CSS `rise` class does the same for
  anything rendered on the server. Nothing heavy runs for a visitor whose system
  asks for reduced motion.
- **Fonts.** `lib/fonts.ts`, self-hosted at build by `next/font`. Swapping any
  face is one line there. The Latin faces carry no Tamil, Devanagari, Chinese,
  Japanese or Korean glyphs, so those five languages each bring their own Noto
  face. They all define the same `--font-script` variable and the layout puts
  exactly one of them on `<html>` for the locale being read, so a reader only
  ever fetches the face their page draws with.
- **Wallets.** `components/providers/PrivyProvider.tsx`: email, Google and
  passkey login, a wallet created on first login, Monad mainnet as the only
  chain, and wagmi wired through `@privy-io/wagmi` so ordinary wagmi hooks read
  from the embedded wallet.

## One thing to know about viem

`wagmi` hoists to the repo root and resolves the root copy of viem, while this
package pins the version `@privy-io/wagmi` asks for. `tsconfig.json` points
TypeScript at this package's copy so the two do not disagree about the shape of a
chain. When the other packages' viem versions line up, that mapping can go.
