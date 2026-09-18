---
title: Rules and standards
---

# Rules and standards

Three published texts decide how AI pictures have to be marked: the EU AI Act, the European
Commission's Code of Practice on transparency, and the C2PA standard itself. This page describes
those rules as published and says where Moolam sits against them. It is not legal advice.

## The marking duty in the AI Act

Article 50(2) of [Regulation (EU) 2024/1689](https://eur-lex.europa.eu/eli/reg/2024/1689/oj) binds
providers of AI systems that generate synthetic audio, image, video or text content. They "shall
ensure that the outputs of the AI system are marked in a machine-readable format and detectable as
artificially generated or manipulated". Paragraph 4 binds deployers instead, and only for deep
fakes: a deployer "shall disclose that the content has been artificially generated or manipulated",
with a carve-out for evidently artistic, satirical or fictional work. Article 113 of the same
regulation dates it: "It shall apply from 2 August 2026".

Moolam is a registry and a verify service. Registering a picture here does not make a provider or a
deployer compliant with Article 50, and nothing on this site should be read as saying it does.

## The Code of Practice, and which layer Moolam is

The [Code of Practice on Transparency of AI-generated
Content](https://ec.europa.eu/newsroom/dae/redirection/document/129555) (European Commission, 10
June 2026) is voluntary. Its signatories commit to "at least two layers of machine-readable
marking": digitally signed metadata (Sub-measure 1.1.1) and imperceptible watermarking (Sub-measure
1.1.2). Fingerprinting or logging is an optional further layer, and the Code is plain about its
limits: "relying on fingerprinting or logging alone is not considered sufficient to meet the quality
requirements specified in Article 50(2) AI Act and in Commitment 3."

| Layer | What Moolam does today |
| --- | --- |
| Digitally signed metadata | Writes a signed C2PA manifest for every picture it registers. |
| Imperceptible watermarking | Nothing. Moolam does not add a watermark. |
| Fingerprinting and logging | Two perceptual fingerprints per picture and a public registry on Monad. By the Code's own words, this layer alone is not enough. |

So Moolam is one part of a marking stack, not the whole of it. Anyone marking output to the Code
would still need a watermarking layer beside what Moolam writes.

## What C2PA asks for, and what it does not

The [C2PA specification](https://spec.c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html)
never mentions a blockchain. The word "blockchain" and the phrase "distributed ledger" appear
nowhere in the 2.1 text. TrueScreen's FAQ states it directly: "Does C2PA use blockchain? No. C2PA
does not rely on blockchain or any distributed ledger technology... while still providing verifiable
provenance through a decentralized trust model based on certificate authorities included in the
official C2PA Trust List."

What the standard does define is the soft binding, section 18.9: "if a C2PA manifest is removed from
an asset, but a copy of that manifest remains in a provenance store elsewhere, the manifest and
asset may be matched using available soft bindings." It also defines a Manifest Repository, section
2.4.4: "A repository into which C2PA Manifests and C2PA Manifest Stores can be placed, and which can
be searched using a content binding."

Moolam's registry is one such repository, searchable by the fingerprint of a copy. Putting it on
Monad is Moolam's own design choice. The specification does not ask for it and does not sanction it.
[Fingerprints](fingerprints) has the measured numbers for what survives and what does not.

## History, not truth

The standard's critics and Moolam's own docs land in the same place.
[TrueScreen](https://truescreen.io/articles/c2pa-standard-history-limitations/) puts it as "C2PA
certifies content history, not truth". The [trust model](trust-model) says the same of a passport:
it proves who registered first, not who made the picture, and for a human photo it is a timestamped
claim and nothing stronger. When a record is wrong, the route is a bond and a challenge rather than
an argument about the signature, which is what [Disputes](../guides/disputes) describes.
