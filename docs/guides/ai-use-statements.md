---
title: Say how AI may use a picture
---

# Say how AI may use a picture

A creator can say, on the record, whether their picture may be used to train AI. The statement goes
two places at once: inside the file as a signed C2PA assertion, and onto Monad as a dated entry only
the passport's holder can write.

Both halves matter because the file half can be taken out. A platform that recompresses your JPEG
throws the manifest away, and with it the line saying you refused. The chain half survives that,
because it was never in the file.

This is not a lock. It is a record. What it does and does not do is at the bottom of this page.

## The three choices

The studio and the passport page both offer the same three, as plates you pick one of.

| Plate | What it says | What it writes |
| --- | --- | --- |
| Open to AI use | "Anyone may train on this picture, generate from it and mine it." | All four uses `allowed` |
| Not for AI training | "No AI use at all. The one most creators pick, and the one the web has no way to say today." | All four uses `notAllowed` |
| Ask me first | "Allowed on your conditions, written below. Anyone who cannot reach you has to read it as no." | All four uses `constrained`, plus your conditions text |

Under the plates is "answer use by use", which opens the four uses and lets you set each one
separately. A picture can be open to inference and closed to training. The plates are the common
answers, not the only ones.

Saying nothing is also a choice, and it is the one every passport starts in. Nothing is sent, the
chain holds no entry, and the passport page says so in its own words: nobody has written a statement
for this picture, and it is reported as silence because that is what it is. Silence is not
permission.

## The four uses

They come from the Creator Assertions Working Group's Training and Data Mining assertion, version
1.1. Moolam did not invent them, and the contract names the standard on chain so a reader never has
to guess what a value means.

| Use | What it covers |
| --- | --- |
| AI training | Training a model of any kind on this picture |
| Generative AI training | Training a model that produces new pictures |
| AI inference | Running a model over the picture, rather than training one on it |
| Data mining | Bulk analysis that is not model training |

Each one is `allowed`, `notAllowed`, `constrained`, or not stated at all. Not stated is not
permission: it means the creator has said nothing about that use.

## Ask me first, and what a machine does with it

"Ask me first" needs somewhere to ask, so it comes with a conditions text. A licence name, a page to
read, or an address to write to. At most 256 bytes, plain ASCII, and the register refuses a statement
that says conditions apply without saying what they are.

The standard is explicit about the case where nobody can ask. In its words: "In the absence of
additional information, constrained shall be treated as equivalent to notAllowed."

So a crawler that reads your conditions and cannot reach you has to treat the picture as closed.
That is the rule the vocabulary already carries, and Moolam prints it under every "ask first"
statement rather than leaving a reader to find it.

## Where you state it

### In the studio, at the moment of making

Both panels, the upload one and the agent one, carry the
three plates before anything is signed. Pick one and the words go into the C2PA manifest the verify
service signs into your file, and into the metadata pinned to IPFS. Then, once the registration is
confirmed on chain, the studio sends a second transaction that writes the same words to the consent
register. The receipt shows both.

Stating it here is the only way the file itself carries your answer, because the manifest is signed
before the passport exists and cannot be added to afterwards.

### On the passport page, at any time

Open a passport you hold and the section "How AI may use this
picture" has the same three plates under "Say how AI may use it". Only the wallet the registry says
holds that passport sees the control at all. This writes to the chain only: a file already pinned is
not rewritten.

Both are free to you. Moolam pays the network fee through Privy's sponsorship, the same way it pays
for registering. The statement is a plain transaction from your own wallet, so nothing about it
depends on Moolam staying online afterwards.

## Changing your mind

Write a new statement. The old one is not edited and not deleted: it stays in the history with its
date, and the new one becomes the one that stands. That is the whole point of a dated record. Anyone
asking what you allowed last March gets last March's answer, not today's.

To go back to saying nothing at all, set all four uses to not stated. That takes the earlier
statement out of force without hiding that you ever made it.

One rule bounds this. The same wallet must wait ten minutes before changing the same picture again.
When the wait is on, the control locks and says when it opens: the register takes one statement per
wallet every ten minutes for the same picture. The wait exists because Moolam pays for these
transactions, and it stops one account turning the sponsorship into a bill.

The ten minutes follow the wallet, not the picture. A new holder after a transfer does not wait, so
a seller writing a statement just before a sale cannot lock the buyer out.

## What a transfer does

A passport is an ERC-721, so it can be sold or given away. The statement stands until the new holder
changes it, and from then on only the new holder can write. The history shows who wrote what and
when, so a reader can see the statement was made by the person who held it then, not the person who
holds it now.

## What it does not do

This is the honest part, and it is short.

- It stops nobody by itself. No crawler is obliged to read it, and nothing in the contract can
  make one. What it does is remove the excuse. A company that trains on a picture whose holder wrote
  "not for AI training" on a public chain, with a date, cannot say it did not know.
- It proves no copyright. It records what the passport's holder stated. Moolam does not check
  who owns the rights to a picture, and a passport proves who registered first rather than who
  created. The [trust model](../concepts/trust-model) states that narrowly.
- It is not a compliance badge. Writing a statement here does not make you or anyone else
  compliant with the EU AI Act, the Code of Practice, or anything else. [Rules and
  standards](../concepts/rules-and-standards) says where Moolam sits against those texts and where it
  does not.
- Read it beside the dispute status. A statement on a passport whose record is under challenge
  should not be relied on, because the holder's word rests on a record that is in question. The
  verify service returns both facts together for that reason.

## How anyone checks it

### The passport page

The section "How AI may use this picture" draws the passport's life as one
rule with a day scrubber. Drag the thumb to any day and the page asks the chain what was in force
then, rather than showing today's answer with an old date on it. Under it are the four uses as rows,
the conditions text if there is one, who stated it, when, and the dated history.

### A verify result

Upload any copy of the picture, even one with the metadata stripped, and the
answer carries the holder's statement as a stamp under the match. That is the lookup an AI company
makes: from the pixels alone to the creator's own word and the date they wrote it.

### The chain itself

Nothing here needs Moolam. The register is a plain contract anyone can
read.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cast call 0x1151E69a82947920546e779c4C8c785b2a3C1277 \
  "consentOf(bytes32)(bool,(uint64,address,(uint8,uint8,uint8,uint8),string))" \
  0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638 \
  --rpc-url https://rpc.monad.xyz
```

```
true
(1789717128 [1.789e9], 0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6, (2, 2, 2, 2), "")
```

That is one real picture, `monsoon-fishing-nets-drying`. `(2, 2, 2, 2)` is not allowed on all four
uses, written by the wallet that held it at unix second 1789717128, which is 2026-09-18T07:38:48Z.
Every function, every error and the query for a past date are in [MoolamConsent](../api/consent).

## What is not built yet

Explore has no filter for how AI may be used. You can read any passport's statement on its own page
or through a verify result, but you cannot yet list the registry by it. That is a screen nobody has
built, not a limit in the register.
