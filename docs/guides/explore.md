---
title: Explore the registry
---

# Explore the registry

Two pages read the whole registry rather than one record: "Explore" is every passport on Monad, and
"Agents" is every generating agent that has signed one. Both are in the header, and both read the
index live while the page is being built. Nothing on either is placed by hand.

## Explore

"The registry", newest first. The lede says where it comes from: "Every picture registered on Monad,
newest first, read from the index while this page loads."

The page opens on the pictures. "Pictures" is the chip a bare `/explore` is on, so the first rows are
ones a reader can look at, and the cards the repository's own scripts wrote sit behind the next chip,
"Test images", rather than at the top of a judge's first screen. Nothing is hidden: "All" is the
third chip and holds the whole registry.

Three counts sit beside the title: "Passports", "Generated" and "Re-checked". They count the whole
index however the grid is filtered. The first is the index's own running total. The other two are
counted by asking for the matching ids, capped at a thousand, so a count that hit the cap prints as a
number with a plus after it rather than pretending to be exact. The endpoint exposes no aggregate to
ask instead.

Under them, one line says how the registry divides: "7 pictures / 22 test images". That number is
read the only way it can be, by fetching each pinned metadata document for its title, capped at the
newest two hundred, and a read that hit the cap says so in the line.

### The order, stated on the page

One line in monospace over the grid. On "Pictures" and on "Test images" it reads "Newest first",
because those two hold one kind of row each. On "All" and on every chip that can mix them it reads
"Newest first, and seed test images sort last".

That second line is there because the registry holds cards the repository's own scripts wrote, titled
`Moolam seed 4`, `Moolam prove-it` and `Moolam Privy proof`. They are not hidden and not dropped.
They sort to the end, the page says so, and each one is labelled "Seed test image" on its plate.

The title is the only thing that separates them. Having a generator does not: the seed script signs
every card it writes with the demo agent, so "has an agent" would call every seed card a test. A
plate whose metadata will not load has no title to judge, and sorts with the test cards rather than
above pictures a reader can actually see.

Inside a second, ties fall back to the id, so the same set always lands in the same order.

### The filters

Nine chips in two groups, a hairline between them. Which half of the registry is on the sheet:
"Pictures", "Test images", "All". Then what the record says: "Generated", "Captured", "Edits",
"Re-checked", "With manifest", "Disputed".

Each one is a real link carrying the whole state of the page, so a filtered view can be copied out of
the address bar and sent to somebody else, and the browser's back button walks back through the
filters you tried. `/explore` is the pictures, `/explore?view=test` the test images,
`/explore?view=all` everything.

Beside them, a search box that matches a passport id. It is a form rather than a live filter, so
typing does not fire a query per keystroke at the index. A link that carries a search term or an
agent id and names no chip opens on "All": it is asking about records rather than about which of them
are test cards, and the pictures chip would answer it with an empty grid.

Arriving from an agent's page adds a tenth chip, "Agent" and the id, with an x that clears it. A
chip this build no longer has falls back to the same chip the rest of the address implies, instead of
an error page, because a link someone shared should still open.

The index cannot be asked for the two picture chips. It stores no title, and a title is the only
thing that separates a real picture from a test card, so the page reads whole pages of rows from the
index and sifts them with the same test the sort rule uses. That is why "Load more" under "Pictures"
can read several pages of the index for one screen of plates, and why the cursor it carries points at
the row the scan stopped on rather than at the last plate drawn.

### A plate

The pinned thumbnail and the title, with the kind in one word at the top left, "Generated",
"Captured" or "Edited", and three marks at the top right.

| Mark | What it means |
| --- | --- |
| M | "C2PA manifest pinned with the picture" |
| R | "Re-checked by Chainlink" when the attestation came through this deployment's receiver, otherwise "Re-checked on chain" |
| D | "Disputed" |

A mark the registry does not support is a dim outline rather than absent, so a plate with nothing on
it still reads as a plate with nothing on it. A picture the gateway will not hand over shows the seal
and "No picture on the gateway"; a passport whose metadata carries no name reads "Untitled".

### Load more

Twenty four plates a page. "Load more" asks for the next twenty four from where the last one ended,
and the count under it says how many are on screen. The cursor is a pair, the registration time and
the id, so two passports registered in the same second are never skipped between pages. A plate
already on screen is dropped rather than drawn twice.

At the end: "That is every passport that matches." A filter nothing matches says "No passport
matches this filter yet." rather than an empty grid.

## Agents

Every generating agent the index has seen sign a passport, busiest first. The order is the passport
count, and nothing on the page is placed by hand.

The formula for the trust score is printed at the top, in full, next to a link to where it is worked
out:

```
round(100 x (matched + 1) / (matched + mismatched + 2 x upheld + 2))
```

Each row carries the agent id, the name from its own ERC-8004 card, when the index first saw it
sign, the trust score, and four counts: "Passports", "Re-checks matched", "Re-checks missed" and
"Disputes upheld". "See its passports" opens Explore filtered to that agent.

The counts are the index's, because that is the only place they are added up. The name is the
chain's, read from the card at the agent's `tokenURI`. An identity registry that will not answer
costs the name and nothing else: the row still stands on its numbers.

With nothing recorded the page says "The index has not seen an agent sign a passport yet.", and an
index that will not answer says that instead of drawing an empty table.

What one agent's own page shows is in
[Agents and generated images](agents-and-generated-images).

## Sharing a passport

Paste a passport link anywhere that unfurls links and the card is built from the record itself: the
pinned picture, the title from its metadata, and one line under it, "Registered on Monad, block" and
the block number. A record the index has not caught up with yet prints the chain's own registration
date there instead, rather than saying it was registered and refusing to say where. A passport that
pinned no name is called "Passport" and the short form of its id, and a picture the gateway will not
serve falls back to the seal on a dark plate.

The title on the card and the title in the link preview come from the same function, so the picture
and the text under it cannot drift apart.

## The line in the footer

Every page carries three live readings along the bottom: the verify service, the index and the
chain. Each says "live" with what it is holding, the record count for the service and the block for
the other two, or "unreachable", or how many blocks the index is behind.

They are read when the page is rendered, each capped at three seconds, and the page never waits on
them. A red dot there means the thing is genuinely down rather than slow to paint.

## Where to go next

- [Read a passport](read-a-passport) is one record and every block on it.
- [Verify a copy](verify-a-copy) answers which passport a file belongs to.
- [Envio indexer](../developers/envio-indexer) is the index both pages read, and the trust score
  worked out in full.
- [GraphQL](../api/graphql) is the same data, queryable yourself.
