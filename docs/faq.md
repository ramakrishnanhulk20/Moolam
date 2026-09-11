---
title: FAQ
---

# FAQ

Short answers, with a link to the long one where there is a long one.

## What actually happens when a platform strips the metadata

Nothing that matters. The C2PA manifest inside the file is a convenience; the record that counts is
on Monad, and it holds two perceptual fingerprints of the picture rather than of the bytes. In the
robustness run, stripping every scrap of metadata matched 100 percent of the time, and the
prove-it run does the same thing against mainnet and prints the bit distance.

## What if someone registers my image before I do

They own that record. First registration wins, and Moolam does not pretend otherwise: a passport
proves who registered first, not who made the picture. For AI output the two are the same moment
because the generator registers before publication; for a human photo it is a timestamped claim and
nothing stronger. The [trust model](concepts/trust-model) states this narrowly, and the prove-it run
shows both an exact re-registration being refused and a re-encoded copy being accepted as a separate
record.

## Does Moolam store my image

Verifying does not store anything: the file goes from your browser to the verify service, is
fingerprinted, matched and dropped. Registering does the opposite on purpose. The signed file, its
thumbnail, the manifest and the metadata are pinned to IPFS, because an independent verifier has to
be able to fetch the picture and hash it again.

## What does verification cost

The public route is free, capped at 60 requests a minute from one address. There is also a paid
route behind x402 at 5 cents in USDC on Monad, settled by Monad's own facilitator, for anyone who
wants a higher allowance. Payment is settled only after the match succeeds, so a failed check never
charges.

## Do I need MON or any crypto to register an image

No. Moolam pays the network fee through Privy's sponsorship, so registering costs you nothing, and
the studio only claims it was paid that way after reading your balance either side of the
transaction. If sponsorship is ever off, the screen says so and offers to send the same transaction
from your own balance instead.

## Can I use my own wallet

Not in the app today. The studio signs in with email, Google or a passkey, and Privy creates an
embedded wallet for you on Monad. The contracts themselves do not care who sends the transaction,
so any wallet can bind a passkey and call `register` through `@moolam/agents`; it is the sign in
screen that does not offer a wallet connector.

## What is a passkey, in plain words

The fingerprint reader, face unlock or PIN your device already uses to unlock itself. The private
half is made inside your device's secure hardware and never leaves it. Moolam stores only the public
half, on Monad, and the registry checks every signature against it through Monad's P-256 precompile.

## What happens if I lose the device with my passkey

Sign in on another device and bind that one instead. The studio detects the case, says "Your passkey
was set up somewhere else", and offers either to unlock with the passkey you already have or to bind
the new device, which costs one transaction. Passports you already registered keep their original
signatures either way.

## Why does binding ask for my fingerprint twice

Once to create the passkey and once to sign the message that attaches it to your account. The second
one is what proves the key is really on that device, so a stolen public key cannot be parked on
someone else's account.

## Does a cropped copy match

No, and that is the honest limit. Cutting 10 percent off each edge moves the perceptual hash about
22 bits of 64 against a threshold of 10, and widening the threshold that far would start colliding
genuinely different pictures. Catching crops needs keypoint matching, which Moolam has not built.
[Fingerprints](concepts/fingerprints) has the measured table.

## What files can I upload

JPEG, PNG or WebP, up to 20 MB and 40 megapixels, on both the verify page and the studio. The pixel
cap is checked before anything is decoded, because a 572 KB JPEG can unpack to 100 megapixels. A
signed-in creator may prepare 20 images an hour.

## Is there an API

Yes. `POST /verify` takes a multipart upload or a JSON body naming a URL and returns the passport,
the bit distances and a confidence. `POST /prepare` is the studio's own upload endpoint, behind a
Privy access token. Everything, including status codes and the x402 route, is in
[Verifier endpoints](api/verifier-endpoints), and the contract functions are in
[Registry](api/registry).

## Is the code audited

No third party has audited these contracts. It is self-audited, and the evidence is in the
repository: 119 Foundry tests including fuzz, invariant and mainnet fork tests, six invariants over
8,192 calls, slither and solhint clean of anything untriaged, and twelve attacks executed against
the live deployment and refused. Read [Audits](security/audits) as what was checked and by whom, not
as an assurance.

## What chains does this run on

Monad mainnet, chain 143, and nothing else. The three Moolam contracts are deployed and verified
there, and the two registries Moolam reads but did not deploy, ERC-8004 identity and reputation, are
Monad's canonical ones on the same chain.

## Can Moolam edit or delete my passport

No. `MoolamRegistry` is immutable with no upgrade path, and records, edits and attestations are only
ever added. The owner can pause new writes and rescue tokens sent by mistake, and can never touch a
passport or a user balance.

## What happens if Privy is down

Everything that reads keeps working: the verify page, passport pages, agent pages and the landing
story all read Monad and the index directly. What stops is signing in and the sponsored send, so no
new passport can be registered until it is back. Nothing already on chain depends on Privy at all.

## What happens if IPFS loses the file

The record survives, the picture does not. All three fingerprints, the creator, the agent and the
manifest hash are on chain, and the verify service matches against those rather than against IPFS,
so a copy still finds its passport. What breaks is the picture on the passport page, which says
"Image unavailable from IPFS right now", and any future Chainlink re-check, which has to download
the thumbnail to recompute the hash.

## Can I transfer or sell a passport

Yes. Each passport is an ERC-721 whose token id is the image hash, so it moves like any other NFT.
Ownership matters for one thing beyond trading: only the current owner of a passport may register an
edit from it.

## Can I register a photograph rather than AI output

Yes, and that is what the studio does today. A photo registers as a Captured passport with one
signature, yours, and no generator agent. A picture an AI made carries a second signature from the
wallet that owns the agent's ERC-8004 identity, and registers through the agent, which is described
in [Agents and generated images](guides/agents-and-generated-images).

## What does a passport actually prove

That a specific passkey signed these exact bytes at this exact moment, that the record cannot be
altered or removed by anyone, and for a generated image that the wallet owning a specific ERC-8004
agent id signed the same digest. It does not prove who made the picture, and it does not prove
anything about the person behind the key. The full list, with what is deliberately left out, is in
the [trust model](concepts/trust-model).
