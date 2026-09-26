---
title: Why it matters
---

# Why it matters

A picture's record of where it came from is written into the file, and the file is the first thing
the internet changes. This page sets out what people are publicly running into, who it hurts first,
the honest case against provenance, and what Moolam does about each part. Every source was read in
September 2026 and is linked so you can check it.

## The label falls off

When The Washington Post uploaded an AI video to eight major platforms in October 2025, only YouTube
disclosed it, and only in the description. [No platform it tested kept the Content Credentials
data](https://fredritchin.substack.com/p/major-platforms-are-not-labeling). In September 2026 The
Verge posted Gemini images carrying both C2PA and Google's SynthID watermark to Instagram, and
[neither was labelled AI after almost two weeks](https://www.theverge.com/ai-artificial-intelligence/989617/instagram-ai-content-label-confusion),
while real photos touched by a background remover were. OpenAI added a watermark to its images in
May 2026 because, as [PetaPixel put it](https://petapixel.com/2026/05/20/openai-gets-serious-about-detecting-fake-images/),
metadata "can be tampered with and/or removed". A screenshot removes it too.

Not every platform strips it. LinkedIn keeps the credential and shows it, according to
[Lumethic's platform survey](https://www.lumethic.com/en/articles/content-credentials-social-media-platforms).
But a picture rarely stays on one platform.

## Credit goes with it

Facebook pages with over a million followers take wildlife photographers' pictures, regenerate them
with AI so copyright scanners miss them, and repost them with no credit, [PetaPixel reported in
August 2025](https://petapixel.com/2025/08/07/ai-is-ruining-nature-photography-on-facebook/). On
Pinterest, artists say years-old hand-drawn work gets tagged "AI modified" and [they have to prove
otherwise, again and again](https://www.404media.co/pinterest-is-drowning-in-a-sea-of-ai-slop-and-auto-moderation/).
In April 2026 Instagram [stopped recommending accounts that mostly repost other people's
work](https://petapixel.com/2026/04/30/new-instagram-policies-target-reposted-content/), which tells
you how common it had become.

## Nobody can say where a picture came from

When Columbia's Tow Center asked seven AI chatbots for the place, date and photographer of ten news
photos, [14 of 280 answers got all three right](https://www.cjr.org/tow_center/why-ai-models-are-bad-at-verifying-photos.php).
In August 2025 Grok placed an AFP photo from Gaza in Yemen, and [a French lawmaker who shared the
real photo was accused of spreading disinformation](https://www.france24.com/en/live-news/20250806-grok-is-that-gaza-ai-image-checks-mislocate-news-photographs).
It cuts both ways: in March 2026, [fake forensic analyses were used to call real war photos
AI](https://www.techpolicy.press/how-ai-content-detection-is-being-weaponized-in-the-iran-war/). In
a Malwarebytes survey of 1,500 adults, [85 percent said they can no longer tell real from
AI](https://www.helpnetsecurity.com/2026/06/11/ai-scams-deepfakes-survey/), up from 66 percent a
year earlier.

## Opt-outs do not travel

A creator's "not for AI training" usually lives in one place: a website file, a platform setting or
a metadata field. The picture leaves without it. Cloudflare says Perplexity used undeclared crawlers
that [ignored robots.txt even on test sites that blocked everything](https://blog.cloudflare.com/perplexity-is-using-stealth-undeclared-crawlers-to-evade-website-no-crawl-directives/);
Perplexity denies it. In December 2025 a Hamburg appeal court held that a photographer's opt-out
[did not count because it was written in plain words rather than a machine-readable
form](https://www.insidetechlaw.com/blog/2025/12/machine-readable-opt-outs-and-ai-training-hamburg-court-clarifies-copyright-exceptions).
In August 2026 Cara, a portfolio site built for artists who refuse AI training, [was scraped three
times, starting with 12 million images](https://blog.cara.app/blog/scraping-legal-fund-faq).

## Marking is now a legal duty

Article 50 of the EU AI Act has applied since 2 August 2026. A grace period to 2 December 2026 for
systems already on the market depends on the Digital Omnibus being formally adopted. Providers of AI image generators have to mark what they produce in a
machine-readable way. The Commission's Code of Practice was drafted with [over 187
participants](https://digital-strategy.ec.europa.eu/en/faqs/code-practice-transparency-ai-generated-content)
and asks for signed metadata plus an invisible watermark, and for a way others can check content.
[Rules and standards](rules-and-standards) reads those texts in full.

## Who needs this first

Makers of AI images and the agents that generate them, because the law now asks them to mark output
and let others check it. Photographers and artists, because a first-registered record with a date is
something a reposter cannot produce. Newsrooms and fact-checkers, because "which record does this
copy belong to" is the question they are failing to answer with chatbots.

## The case against, answered honestly

The critics are serious. [RAND](https://www.rand.org/pubs/commentary/2025/06/overpromising-on-digital-provenance-and-security.html)
argues C2PA only works if every tool from camera to post complies, which an open system will never
manage. A [2026 security analysis](https://arxiv.org/abs/2604.24890) says C2PA misses its own
security goals. Researchers have [removed invisible watermarks without knowing the
scheme](https://techxplore.com/news/2025-07-watermarks-defense-deepfakes.html), and C2PA signing on
Android phones [has been forged](https://www.da.vidbuchanan.co.uk/blog/android-c2pa.html). Free tools
to strip every mark are a click away, and anyone who means to deceive will not register at all.

Moolam agrees with most of that. It does not rely on the mark staying in the file, which answers the
stripping. It cannot catch a picture nobody registered, and it proves who registered first, not who
made the picture, as the [trust model](trust-model) says. Cropping is its real hole: a 10 percent
crop is not matched, and [Fingerprints](fingerprints) prints that number next to the good ones. And
by the Code's own words, fingerprinting alone is not enough for Article 50, so Moolam is one layer
beside a watermark, never the whole answer.

## What Moolam does about each

| What people run into | What Moolam does |
| --- | --- |
| Credentials stripped on upload | Keeps the record on Monad and finds it again from the pixels. Screenshots and stripped files matched 100 percent in testing, heavy re-encodes 92 to 96. |
| Credit removed on repost | Every passport says which key registered the picture and when, and nobody can edit or delete it. |
| No way to trace a viral image | Anyone can post any copy to the verify service and get the passport back, with how close the match is. |
| Opt-outs that do not travel | A creator's AI-use statement is written to Monad with a date, so it survives when the file's copy is lost. It is a record, not a lock. |
| The marking duty | A signed C2PA manifest in every registered file, plus a public registry anyone can check. One layer of the stack, not all of it. |

[How it works](how-it-works) follows one passport through every step, and
[Say how AI may use a picture](../guides/ai-use-statements) is the creator's side of the AI-use record.
