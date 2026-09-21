---
title: Privacy
---

# Privacy

Last updated: 21 September 2026.

## The short version

Registering a picture publishes it, permanently, and nobody can take that back. Verifying a picture
stores nothing at all. Moolam sets no cookies and runs no analytics of its own. There is no Moolam
account database: sign in is Privy's, and this service sees only a user id and a wallet address.
Nothing is sold and there is no advertising.

## Registering is publishing

Read this before you register anything.

Registering pins four files to public IPFS through Pinata: the signed picture, a thumbnail 512
pixels on its longest side, a readable copy of the C2PA manifest, and a metadata document carrying
the title, the fingerprints, what you said about AI use, and for a picture the agent drew, the
prompt and the model. Pinned means public: anyone holding the content id can fetch a copy, and
Moolam cannot recall one.

The passport goes on Monad: the sha256 of the file, its two perceptual fingerprints, your wallet
address, the agent id where an agent drew it, the hash of the manifest, the address of the metadata
document, and the time of the block it was written in. Nobody can edit or delete that record, including
whoever runs Moolam: the registry is immutable, has no upgrade path, and its owner can pause new
writes and nothing else.

Your statement about how AI may use the picture is a second public record on Monad. Entries are
appended and never edited, so an old statement keeps its date and stays readable beside the new one,
and any conditions you typed, up to 256 bytes, sit on chain as you typed them.

Binding a passkey writes its public half on chain against your wallet address. The private half is
made inside your device and never leaves it.

A right to have data erased cannot reach a public blockchain or a pinned IPFS file. Decide before
you press register: there is no delete.

## Verifying stores nothing

A file you drop on the verify page goes from your browser to Moolam's verify service, which
fingerprints it in memory, matches it against the registry's fingerprints, reads any C2PA manifest,
and answers. The bytes are never written to disk and never pinned. A picture you name by URL is
fetched, matched and dropped the same way.

## What the site keeps on your device

No page on Moolam sets a cookie, and a page you only read stores nothing until you touch the theme
toggle.

| Stored in your browser | What it is for |
| --- | --- |
| `theme` | Light or dark, so the site opens the way you left it |
| `moolam:wallet:returning` | A flag that this browser has signed in before, so the sign in library loads early |
| `moolam.passkey.<your address>` | Which passkey belongs to your account, and its public half, so signing does not make you pick from a list. Never the key itself |

On the three pages where you can sign in, the studio, the resolver console, and a passport page once
you have signed in here, Privy's library keeps your wallet session there too and sets an id of its
own, `privy:caid`, for Privy's product analytics.

## Analytics

Moolam runs no analytics of its own. Vercel Web Analytics and Speed Insights count page views and
measure how fast pages load, in aggregate. They set no cookies and store nothing on your device.

## What the servers write down

The verify service writes one line per request: the route, the status, how long it took, and the
caller's IP address as the host's proxy reports it. A refused request adds the reason. A prepare, an
edit or a generation also logs the Privy user id it was for, and the model that drew. The
uploaded file itself is never logged. Vercel, which hosts the site, keeps its own request logs. No
retention period of Moolam's own is set on either host.

## Accounts

Sign in is Privy's, by email, Google or a passkey. Privy holds the account and the key material for
your embedded wallet. Moolam's service sees your Privy user id and your wallet address, and checks
Privy's token on every request. Moolam never sees a password or a private key and keeps no account
database. Privy's own policy is at https://privy.io/privacy-policy.

## Pictures the agent draws

Your prompt goes to OpenAI's image API, which draws the picture. The prompt is the only text sent:
nothing is wrapped around it. If you then register what came back, the prompt and the model are
pinned in the public metadata.

## Who else handles something

| Who | What they see |
| --- | --- |
| Vercel | Hosts the site, keeps request logs |
| Railway | Runs the verify service, keeps request logs |
| Pinata | The four files pinned at registration |
| Privy | Your account, sign in and embedded wallet |
| OpenAI | Prompts, and the pictures drawn from them |
| Envio | Indexes public events on Monad |
| A Monad RPC provider | Reads and transactions, including those your browser makes |
| Chainlink | A CRE workflow fetches the public thumbnail to re-check a passport |

No data is sold, and there is no advertising.

## Children

Moolam is not directed at children. Who may hold an account is decided by Privy's own terms.

## Who runs this

Moolam is one person's project entered in a hackathon, not a company. Ram builds it and runs it, and
questions about this page go to ramakrishnanhulk20@gmail.com.
