---
title: Business model
---

# Business model

Everything Moolam does today is free. This page is the plan for after: what would eventually
charge, and what does not exist yet. Read it as a plan, not a feature list.

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

A registration measures about 376,128 gas, about 0.038 MON at Monad's 100 gwei floor, and four pins
on Pinata for the file, the thumbnail, the manifest and the metadata. A generated picture adds about
3 cents of model spend on top. These are the real costs any tier above would have to cover.

## Nothing above is charged yet

Every tier on this page is a plan. A judge who wants to see the one paid rail that already exists in
the code can read its terms and status codes in
[Verifier endpoints](../api/verifier-endpoints).
