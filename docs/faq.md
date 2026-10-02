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

## Does a Moolam manifest show as trusted in Adobe's verifier

No, and it is not meant to yet. The signer is a development certificate, a throwaway one, so Adobe's
verify site and every other C2PA reader mark the manifest untrusted. The signatures that decide
anything are the ones on Monad: a passkey assertion checked by the contract through the P-256
precompile, and for a generated image a second signature from the wallet that owns the agent's
ERC-8004 identity. A trusted certificate would change what Adobe's site prints and change nothing
about what the chain record proves.

## What would a trusted C2PA certificate cost

TrueScreen's article on the standard's history and limitations, updated 19 July 2026, puts a signing
certificate at "$289 per year" and says there is "no equivalent" of Let's Encrypt for C2PA, with
"the list of recognized Certificate Authorities is controlled by a relatively small group of
companies within the C2PA coalition". That is that article's figure, not a price Moolam has been
quoted or paid. [Rules and standards](concepts/rules-and-standards) sets out the rest of where
Moolam sits against the standard and the law.

## What if someone registers my image before I do

They own that record. First registration wins, and Moolam does not pretend otherwise: a passport
proves who registered first, not who made the picture. For AI output the two are the same moment
because the generator registers before publication; for a human photo it is a timestamped claim and
nothing stronger. The [trust model](concepts/trust-model) states this narrowly, and the prove-it run
shows both an exact re-registration being refused and a re-encoded copy being accepted as a separate
record.

## Does "not for AI training" actually stop anyone

No, and nothing that writes a statement anywhere can. No crawler is obliged to read it, and the
contract has no way to reach out and stop one. What it does is take away the excuse. Your answer is
written inside the file as a signed C2PA assertion and onto Monad as a dated entry only you can
write, so a company that trained on your picture after you refused cannot say it did not know, and
cannot claim the record was made up afterwards. That is a smaller claim than a lock and it is the
honest one. [Say how AI may use a picture](guides/ai-use-statements) has the rest.

## Can I change my mind, and what happens to the old statement

Yes, as often as you like. A new statement does not edit or delete the old one: the old one keeps
its date and stays in the history, and the new one becomes the one that stands. Anyone asking what
you allowed last March gets last March's answer rather than today's, which is the whole point of
putting it on a chain instead of in a file you can rewrite. To go back to saying nothing, set all
four uses to not stated, which takes the earlier statement out of force without hiding that you made
it. One limit: the same wallet waits ten minutes before changing the same picture again, and the
screen says when it opens.

## What happens to my statement when I transfer the passport

It stands until the new holder changes it. A passport is an ERC-721, and the right to speak for it
moves with the token, so from then on only the new holder can write. The history names who wrote
each statement and when, so a reader can tell one made by the person who held it then from one made
by whoever holds it now. The ten minute wait follows the wallet rather than the picture, so a seller
who writes just before a sale cannot lock the buyer out.

## What does "ask first" mean to a crawler

That it has to ask, and that not asking means no. The vocabulary is the Creator Assertions Working
Group's Training and Data Mining assertion 1.1, and the standard settles the case in one sentence:
"In the absence of additional information, constrained shall be treated as equivalent to
notAllowed." So a crawler that reads your conditions and cannot reach you has to treat the picture
as closed. Your conditions travel with the statement, at most 256 bytes of plain text, and the
register refuses a statement that says conditions apply without saying what they are.

## Does Moolam store my image

Verifying does not store anything: the file goes from your browser to the verify service, is
fingerprinted, matched and dropped. Registering does the opposite on purpose. The signed file, its
thumbnail, the manifest and the metadata are pinned to IPFS, because an independent verifier has to
be able to fetch the picture and hash it again.

## What does verification cost

The public route is free, capped at 60 requests a minute per caller, counted on the address the
proxy in front of the service reports rather than the socket it arrived on, so one busy caller
cannot use up everybody else's allowance. There is also a paid route behind x402 at 5 cents in USDC
on Monad, settled by Monad's own facilitator, for anyone who wants a higher allowance. Payment is
settled only after the match succeeds, so a failed check never charges.

## Do I need MON or any crypto to register an image

No. Moolam pays the network fee through Privy's sponsorship, so registering costs you nothing, and
the studio only claims it was paid that way after reading your balance either side of the
transaction. If sponsorship is ever off, the screen says so and offers to send the same transaction
from your own balance instead.

## Who pays for what

Moolam pays the network fee on every write through Privy's sponsorship: registering an upload,
registering a picture the agent drew, and appending an edit. It also pays the image model and the
IPFS pinning, which is why the agent is capped at three pictures a day per account and edits at five.

One thing is yours to pay. A dispute bond is your own MON, currently 1, and the screen says so before
the button: "Moolam pays the network fee. It cannot pay the bond: that is your own MON, and it leaves
your account the moment this lands." A paid verification over x402 is the other one, at 5 cents in
USDC and no gas, because the facilitator pays the settlement itself.

## How would Moolam make money

Nothing in the app charges today. Registering, generating and editing are sponsored, inside daily
limits the whole app shares, and every re-check Moolam's own runner starts is run by Moolam itself.
That is the cost of proving the product works, not the business.

The plan for after: a paid Creator Pro tier, a per-call price for machines over the x402 route
already built into the verify service, agents paying for their own passports once sponsorship ends,
and service deals for newsrooms and agencies. None of it is built yet.
[Business model](concepts/business-model) has the numbers behind it.

## What draws the picture when the agent makes one

An image model, `gpt-image-1-mini` by default, at 1024 by 1024 and medium quality, which is about a
cent a picture. A host can point it at a different model or at OpenRouter with two environment
variables. Your prompt is the only text that reaches it: nothing is wrapped around it, so nothing the
service says about itself can end up inside the manifest of a picture registered in your name. The
prompt and the model that answered are both pinned in the passport's metadata, so the record says
what made the pixels and what it was asked for.

## What can the signer I grant for edits actually do

Append an edit to a passport you hold. That is the whole list. It is a key Privy holds for this app,
registered as a one of one quorum on your own wallet and scoped by a policy that names `appendEdit`
on the Moolam registry. It cannot register a new original, cannot move funds and cannot call another
contract, because the policy names one function on one contract, and the verify service refuses to
use a signer that does not carry that policy. Press "Revoke" and Privy refuses the next call from the
same key before it can reach Monad. Revoking clears every signer on the wallet rather than only this
app's, because Privy's browser SDK has no call that removes one by id.

## Why does my passport say it has not been re-checked yet

Because nobody has re-checked it yet, and the page will not pretend otherwise. A re-check is an
independent verifier fetching the pinned thumbnail, hashing it again and writing the answer on chain,
and the Chainlink CRE workflow is what does it here. It needs the thumbnail reachable through an IPFS
gateway before anything is written, so a fresh passport reads "Not re-checked yet", which is the
honest word for registered and nothing more. On Chainlink's network a quorum of nodes must produce
the identical verdict before a report is signed, and since 2026-10-02 the workflow's verdict step runs
there. The first network verdict is
[transaction 0x760dcb5e…2882](https://monadvision.com/tx/0x760dcb5e1b83929201d8fe299ce9c3be2cf8981502117c5288386d7da3438882).
Every re-check before it came from Chainlink's simulator with `--broadcast`, which is one machine and
no consensus, and the passport page labels each one by the forwarder that delivered it. On
Explore, the plates with a lit R mark are the ones that have one, and the "Re-checked" chip shows
only those.

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
repository: 182 Foundry tests including fuzz, invariant and mainnet fork tests, twelve invariants
each driven over 8,192 calls, slither and solhint clean of anything untriaged, twelve attacks
executed as real transactions against the live deployment and refused, and eight more simulated
against the consent register and refused. Read [Audits](security/audits) as what was checked and by
whom, not as an assurance.

## What chains does this run on

Monad mainnet, chain 143, and nothing else. The four Moolam contracts are deployed and verified
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

Yes. The studio offers both, under "Two ways in". A photo you upload registers as a Captured passport
with one signature, yours, and no generator agent. "Make one with the agent" registers a Generated
passport carrying a second signature from the wallet that owns the agent's ERC-8004 identity, over
the same digest your passkey signs. Both are described in
[Agents and generated images](guides/agents-and-generated-images).

## What does a passport actually prove

That a specific passkey signed these exact bytes at this exact moment, that the record cannot be
altered or removed by anyone, and for a generated image that the wallet owning a specific ERC-8004
agent id signed the same digest. It does not prove who made the picture, and it does not prove
anything about the person behind the key. The full list, with what is deliberately left out, is in
the [trust model](concepts/trust-model).
