---
title: Fingerprints
sidebar_label: Fingerprints
sidebar_position: 4
---

# Fingerprints

Every passport carries three fingerprints of the same picture. They answer different questions and
they fail in different ways, which is the whole reason there are three.

## The three

**sha256 of the exact bytes.** This is the passport id and it is also the ERC-721 token id. It
answers "is this file byte for byte the registered one". Change a single bit and it is a different
answer, which is what makes it useless on its own once a platform has touched the file.

**A 64-bit pHash.** Computed from the picture rather than the bits: greyscale through linear light,
resized to 32 by 32, a 2D discrete cosine transform, then the 8 by 8 block of coefficients next to
the DC term, one bit per coefficient above that block's average. Stored on chain as a `uint64`.

**A 256-bit blockhash.** A second perceptual hash on a different principle, stored as a `bytes32`.
Requiring both to agree is what holds the false positive rate down.

Every passport also records a `fingerprintVersion`, and a zero is refused by the contract. A record
whose perceptual hash nobody can recompute later is not evidence of anything.

## Which way up

A photo taken sideways stores its pixels rotated and leaves an EXIF tag saying which way up it
goes. Moolam applies that tag once, so both perceptual hashes read the same upright picture and the
same photo cannot get two fingerprints depending on who honoured the tag. Hashing the stored bytes
instead put the blockhash of a tagged photo 112 of 256 bits away from its turned copy, far past the
threshold. The agent side bakes the rotation into the pixels before the C2PA manifest is signed, so
the registered file, its fingerprint, the thumbnail and the hash the Chainlink workflow recomputes
all describe one picture the same way up.

## The eight variants

A rotated or mirrored re-upload is the same picture to a person and a completely different one to a
perceptual hash: a quarter turn moves the pHash about 30 of 64 bits. Rather than widen the
threshold, which would start colliding genuinely different pictures, the verifier fingerprints all
eight symmetries of the query and runs each through the index.

The eight are `identity`, `rot90`, `rot180`, `rot270`, `mirror`, `mirror-rot90`, `mirror-rot180`
and `mirror-rot270`. The variant that produced the best match is returned with the answer, so a
caller can see the copy was turned.

## The thresholds

A match must clear both: pHash distance at most 10 of 64, and blockhash distance at most 40 of 256.
Past either one it is not a match and scores zero.

An exact sha256 hit scores a confidence of 1. Everything else scores

```
0.99 * (0.6 * (1 - phashDistance / 11) + 0.4 * (1 - blockhashDistance / 41))
```

Each distance is divided by its own threshold, so the 64-bit and the 256-bit hash land on the same
scale. The pHash carries the larger weight because it measured as the steadier of the two under
honest re-encoding. The 0.99 cap means a perceptual match can never claim to be as certain as
identical bytes.

An upload whose bytes are already registered is answered from the sha256 alone, without building
the eight rotated copies. Anything over 40 megapixels is refused with 413 before a single pixel is
decoded, because a 572 KB JPEG can unpack to 100 megapixels.

## What survives and what does not

Measured over 24 images and 15 transforms, 360 copies in all. Regenerate the table with
`npm run robustness`.

| transform | direct | dihedral | mean pHash | mean blockhash | false positives |
| --- | --- | --- | --- | --- | --- |
| reencode-q60 | 96% | 96% | 0.7 | 3.9 | 0 |
| reencode-q30 | 92% | 92% | 0.7 | 7.7 | 0 |
| resize-50 | 100% | 100% | 0.7 | 2.9 | 0 |
| resize-25 | 100% | 100% | 0.7 | 4.5 | 0 |
| resize-10 | 100% | 100% | 0.9 | 13.6 | 0 |
| crop-10 | 0% | 0% | 21.6 | 56.3 | 0 |
| crop-25 | 0% | 0% | 29.7 | 85.7 | 0 |
| rotate-90 | 0% | 100% | 0.7 | 1.8 | 0 |
| rotate-180 | 0% | 100% | 0.7 | 1.8 | 0 |
| mirror | 0% | 100% | 0.7 | 1.9 | 0 |
| brightness-120 | 96% | 96% | 1.5 | 13.3 | 0 |
| watermark-text | 29% | 29% | 7.2 | 42.3 | 0 |
| screenshot | 100% | 100% | 0.8 | 3.1 | 0 |
| social-chain | 100% | 100% | 0.5 | 4.3 | 0 |
| strip-metadata | 100% | 100% | 0.7 | 1.6 | 0 |

The direct column is the copy fingerprinted as it arrives and looked up once. The dihedral column
tries all eight variants. The three rotation and mirror rows are the argument for the eight
variants: 0 percent becomes 100 percent.

Three honest notes on those numbers.

**Cropping is the real hole.** Cutting 10 percent off each edge moves the pHash about 22 bits of
64, and the worst single case was 35. That is not a threshold anyone can widen; at that distance
genuinely different pictures start colliding. Catching crops needs a different technique such as
keypoint matching, and Moolam has not built it.

**The blockhash fails before the pHash does.** The one image that missed a plain quality-60
re-encode scored 2 of 64 on pHash and 42 of 256 on blockhash, just past the limit of 40. Requiring
both hashes to agree is what keeps false positives at zero, and this is the price of it.

**False positives were zero** across all 360 copies, each checked against all 23 other originals.
That is a clean result on a synthetic corpus of 24 images, which is a much easier test than a
registry of millions. Put 10 or more real files in `packages/verifier/corpus/` and
`npm run robustness` uses those instead and says so in its first lines.

## Two implementations, held against each other

The Chainlink workflow cannot use the verifier's image library: its sandbox is QuickJS on
WebAssembly with no native modules, so it decodes JPEG with `jpeg-js` and recomputes the pHash in
pure TypeScript. `packages/verifier/test/workflow-phash.test.ts` holds the two implementations
against each other on 24 generated images: identical on 11 of them and never more than 2 bits
apart, against a match threshold of 10.
