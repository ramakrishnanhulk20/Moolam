---
title: Business model
---

# Business model

Everything Moolam does today is free, and stays free during early access. The prices a platform
will pay are published; nothing else on this page has a price yet. Read it as a plan, not a feature
list.

## Platform pricing

These are the prices on the site's business page, word for word. They apply to platforms that
register their users' pictures through the [platform kit](../developers/platform-kit).

> Free during early access. Paid plans start only when Moolam has real demand, with 30 days'
> notice.

| Plan | Price | What it covers |
| --- | --- | --- |
| Free | $0 a month | The first 1,000 passports every month |
| Pay as you go | $0.005 a passport | Half a cent a passport after the first 1,000 |
| Monthly | $99 a month | Up to 50,000 passports a month |

The business page adds that Moolam pays the Monad fee for every passport a person signs. Nothing is
billed today: no part of the code charges a platform, and no plan starts without the 30 days'
notice.

## Free today, and why

Registering, generating and editing all run through Privy's sponsorship, so a creator pays nothing.
That has a ceiling rather than a price: 300 sponsored registrations, 60 generations and 150 edits a
day, shared by everyone using the app (see [Verifier endpoints](../api/verifier-endpoints)). Every
re-check today runs on Moolam's own machine, and every picture is public. This is the cost of
proving the product works, not the business.

## Creator Pro

A monthly plan for a creator who outgrows the free tier: a Chainlink re-check on demand instead of
waiting for one, a private re-check that keeps a sealed picture's proof without publishing the
picture, more generations in a day, and priority when the service is busy.

## Machines paying by the call

`POST /verify/paid` is already in the code: an x402 payment on Monad mainnet for one verification.
It is switched off today until a wallet holds the USDC it collects. That is all that is true about
it right now.

The idea is a platform or an AI company paying cents per call, either to verify a picture or to ask
whether its holder allows AI training. That second question is the larger business. The EU AI Act's
marking duty and the European Commission's Code of Practice, both read in full on
[Rules and standards](rules-and-standards), turn "may we train on this" into a question a company
has to answer for whatever it trains on. Moolam answers it from the pixels of the picture alone, and
claims no compliance for doing so.

## Agents paying their own way

Once sponsorship ends, an agent registering its own output would pay a few cents from its own
wallet instead of Moolam's. Part of that already runs: the demo agent, 10249, signs and transacts
from a wallet built on Privy today, sponsored. Turning the sponsorship off is the only change this
plan needs.

## Newsrooms and agencies

Sealed embargoes ahead of publication, bulk registration, and a service agreement in place of a
per-call price.

## What a picture costs Moolam

A passport a person signs costs Moolam about 0.067 MON today: the registration goes through the
person's smart wallet with Moolam paying its gas, and the moon picture's took 657,678 gas at 102 gwei
([its transaction](https://monadvision.com/tx/0x4445e48d8c4db691eabc4208f467ae71b8d78d27b5e506f05235f186f4367152)).
The registration itself is about 376,000 gas, about 0.038 MON, which is what a platform pays from its
own wallet; the rest is the smart wallet's overhead. Each passport also takes four pins on Pinata, for
the file, the thumbnail, the manifest and the metadata. A generated picture adds about
3 cents of model spend on top. These are the real costs any tier above would have to cover.

## Nothing above is charged yet

Every tier on this page is a plan, the platform prices included until their 30 days' notice is
given. A judge who wants to see the one paid rail that already exists in
the code can read its terms and status codes in
[Verifier endpoints](../api/verifier-endpoints).
