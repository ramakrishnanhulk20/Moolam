---
title: Verify a copy
---

# Verify a copy

The verify page answers one question: which registered passport does this file belong to. It reads
the picture, not the file name, not the metadata, and not anything the file claims about itself.

It needs no sign in and no wallet. Anyone can check anything.

## Running a check

Open "Verify an image" from the header. Drop a file on "Drag an image in." or press "Choose an
image". JPEG, PNG or WebP, up to 20 MB.

That is the whole interaction. Choosing or dropping the file starts the check, with no second button
between the file and the answer. There used to be one, it taught nobody anything, and the panel on
the home page already answered in place, so the two screens behaved differently for no reason.

Your browser sends the file straight to the Moolam verify service, not through the app's own server.
The line under the drop area says so and names the host it is actually sending to: "Your browser
sends the file straight to", the host, "the Moolam verify service. It is fingerprinted there,
matched against the registry, and never stored."

A file the browser can already tell the service would refuse, over 20 MB or not an image, is refused
right there, so the answer is instant and nothing was uploaded to earn it.

Until then the answer card reads "No answer yet" over "Drop a file in. The answer lands on this
card." While the check runs it leads with "Reading the picture, not the file name." over "Three
fingerprints, all eight orientations, then a search of every registered passport. A few seconds.",
and lists what is about to happen:

1. "Fingerprint the file three ways: the exact bytes, a perceptual hash, a block hash."
2. "Try all eight ways the picture could be turned or mirrored."
3. "Search every registered passport and answer with the closest one."

Then it turns over. Once a file is in, the button beside the drop area reads "Checking" while the
check runs and "Verify another" when it is done. The one over the chosen picture is "Choose another".

## What the answer card means

### Exact bytes match

The sha256 of the file you uploaded is a passport id. This is the registered file itself, byte for
byte, and the confidence reads 100 percent. Both distances read zero because there is nothing to
measure: it is the same file.

### Match found

The bytes are different but the picture is the same. The card leads with a confidence percentage
and then shows the three numbers behind it:

- "Confidence", the score, capped at 99 percent for a perceptual match. A perceptual match can
  never claim to be as certain as identical bytes.
- "pHash distance", how many of 64 bits differ on the perceptual hash.
- "Blockhash distance", how many of 256 bits differ on the second hash.
- "Orientation", which of the eight the match came from.

A match has to clear both thresholds: pHash at most 10 of 64 and blockhash at most 40 of 256. Past
either one it is not a match at all. Requiring both to agree is what holds the false positive rate
down, and the arithmetic is in [Fingerprints](../concepts/fingerprints).

If more than one passport was in range, the card says how many others and that this one was
closest.

The closest match leads, but it is not always the first registration. Anyone can register a
re-encoded copy of someone else's picture, and a copy a bit or two closer to your file would beat
the original on distance alone. So the answer always carries the passport registered first among
everything in range, however many closer copies there are, and when that is not the passport on the
card, the card says an earlier registration matches and links it. A passport proves who registered
first, so that is the record to open when the question is whose picture this is.

Under that it says what became of the C2PA manifest, the signed record Moolam embeds in the file, in
one of four lines:

- Valid: "The signed C2PA record is still inside this file." The record's signature and its binding
  to these exact bytes check out. That says the file is the one that was signed. It does not look
  the signer up on a trust list, so it does not say who signed it.
- Invalid: "The Content Credentials inside this file fail validation: the file was changed after
  signing, or the record was copied in from another file." A record is there and does not hold for
  these bytes. The service's answer carries the validator's failure codes, such as
  `assertion.dataHash.mismatch`, for anyone reading the JSON.
- Unreadable: "This file carries Content Credentials we could not read, so we cannot say whether
  they hold." There is C2PA data in the file and it could not be parsed, so the card makes no claim
  either way.
- Stripped: "The signed C2PA record has been stripped from this file." This is the interesting case,
  and the whole reason the fingerprints are on chain. A platform that stripped the manifest did not
  strip the picture.

The last three all end "The fingerprints matched anyway.", because none of them touches the match: a
record that fails, cannot be read or is gone costs the file its manifest and never its passport.

### Matches a sealed passport

The picture you dropped in can match a passport whose own picture was never published. The match is
as real as any other, because the fingerprints it was matched against are on Monad rather than in
any file, but there is nothing to show beside the verdict.

The card says so in a line of its own: "Matches a sealed passport. The registered picture is not
published." Where the matched picture would be, it draws that passport's block hash, with "Sealed"
beside the verdict at the top. The statement on AI use and the dispute line read exactly as they do
for any other match. The second opinion says "No public copy to re-check. A re-check needs the
picture to be published." rather than reporting a re-check that will never come as "not yet".

Opening the passport from here lands on the sealed page described in
[Read a passport](read-a-passport).

### The holder's statement, under a match

Under any match the card prints what the passport's holder has said about AI use, as a stamp headed
"The holder's statement" and read from the register on Monad rather than from the file. It reads one
of five ways: open to AI use, training included; not for AI training; ask first, conditions apply;
allowed for some uses and not for others; or nothing about AI use. Where there are conditions, the
holder's own words are printed with them.

That is the lookup an AI company makes, and the reason the chain half exists: from the pixels alone,
with the metadata stripped out on the way, to the creator's own word and the date they wrote it.

A passport whose holder has never spoken for it says so and says what that means: "Its holder has
said nothing about AI use. Silence is not permission." If the register could not be read, the card
says the statement could not be read just now and adds that this is not permission either, because
the register is on Monad and can be asked again in a moment. A failed read never fails the
verification: the match is what you came for, so the answer still arrives.

Beside it the card carries the passport's dispute status, and the two are meant to be read together.
A statement on a passport under an open or upheld challenge should not be relied on: the record the
holder's word rests on is itself in question. [Disputes](disputes) has the rules, and
[Say how AI may use a picture](ai-use-statements) has what each statement means.

Under those two the card carries the second opinion: what an independent Chainlink CRE workflow
found when it fetched the registered picture and hashed it again, or that nothing has re-checked it
yet. A button under that line says "Request a re-check", and anyone reading the answer can press it:
it is free, it needs no account and no wallet, and it puts the passport in a queue the workflow is
run against, usually within the day. The line under the button then reports where the request
stands, and when the verdict lands it links the transaction it was written in.

### Not registered

"No passport matches this image." with a note underneath: "Cropped copies do not match yet. Try the
file as it came out of the generator."

Nothing in the registry is close enough. A file straight out of a generator that nobody registered
looks exactly like this, and so does a heavy crop of something that is registered. The card offers
"Register this image" as the next step.

### What was measured

Every result, hit or miss, ends with a block headed "What was measured": the size and format, the
pHash as a decimal number, and the first bytes of the sha256 and the blockhash. Those are the
fingerprints of the file you handed over, so you can hold them against the ones printed on any
passport page yourself.

## The eight orientations

A quarter turn moves a perceptual hash about 30 of 64 bits, which is a completely different picture
as far as the index is concerned. Rather than widen the threshold, which would start colliding
genuinely different pictures, the service fingerprints all eight symmetries of your file and runs
each one through the index.

The card names the one that matched, in these words:

| Variant | On screen |
| --- | --- |
| `identity` | "The same way up" |
| `rot90` | "Turned a quarter turn" |
| `rot180` | "Turned upside down" |
| `rot270` | "Turned three quarters" |
| `mirror` | "Mirrored" |
| `mirror-rot90` | "Mirrored, quarter turn" |
| `mirror-rot180` | "Mirrored, upside down" |
| `mirror-rot270` | "Mirrored, three quarter turn" |

## What survives, and what does not

Measured over 24 images and 15 transforms, 360 copies in all. Regenerate the table yourself with
`npm run robustness`. The full version, with the mean bit distances, is in
[Fingerprints](../concepts/fingerprints).

**Survives.** Re-encoding at quality 60 and at quality 30, resizing to a half, a quarter and a
tenth, a screenshot, two rounds of social platform resizing, and stripping every scrap of metadata.
Rotation by 90 and 180 degrees and mirroring match at 100 percent through the eight variants, and
at 0 percent without them.

**Does not survive.** Cropping. Cutting 10 percent off each edge moves the pHash about 22 bits of
64, and the worst single case was 35. That is not a threshold anyone can widen; at that distance
genuinely different pictures start colliding. Catching crops needs keypoint matching, which Moolam
has not built.

**Partly survives.** A text watermark matched 29 percent of the time. A brightness change of 20
percent matched 96 percent.

False positives were zero across all 360 copies, each checked against all 23 other originals. That
is a clean result on a synthetic corpus of 24 images, which is a much easier test than a registry
of millions.

## Checking against one passport

Every passport page carries the same check under "Check a copy", headed "Is your copy this
picture?". It runs the same verify, and reads the answer against that passport's id rather than the
whole registry, so it can answer three ways: "Yes. Byte for byte, this is the file.", "Yes. This is
the same picture.", or "No. This copy belongs to a different passport."

That last answer is the point of asking there. A copy that matches something else does not get a
green tick.

## Limits and refusals

| Limit | Value |
| --- | --- |
| File size | 20 MB |
| Pixels | 40 megapixels once decoded |
| Requests | 60 a minute from one socket address |

When a check does not run, the card reads "The check did not run" and one of these, with the
service's own words underneath:

| Message | Status behind it |
| --- | --- |
| "That file is over the 20 MB limit. Send a smaller copy." | 413. The browser also checks the size itself and says this before uploading |
| "Too many checks from here. Wait a minute and try again." | 429 |
| "The verifier would not take that request." | 400, which is also what `/verify` answers for a file it cannot decode |
| "The verifier answered in a shape this page does not know." | The answer did not match the schema this page reads |
| "The verifier refused this request." | 401 or 403 |
| "The verifier could not finish this check." | 502 |
| "That file could not be read as an image. JPEG, PNG or WebP." | 415 |

The last three cannot be produced from the page as it stands. A 403 is the guard against a URL
pointing inside the service's own network and a 502 is a remote host that did not answer, and both
belong to the JSON body form of the API rather than to a browser upload. A 415 comes from
`/prepare`, not from `/verify`.

If the service is not running at all, the page says: "The verifier service is not answering. Start
it with npm run dev:verifier from the repo root, then try again." That line is for anyone running
Moolam locally.

## The API behind it

The page is a thin client over `POST /verify`, which anyone can call with curl or from their own
code, either with a multipart upload or with a JSON body naming a URL. The full request and
response shapes, every status code, and the paid `POST /verify/paid` route are in
[Verifier endpoints](../api/verifier-endpoints).
