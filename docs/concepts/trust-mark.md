---
title: The trust mark
---

# The trust mark

Every passport wears one word that says how far to trust it: on its page, on its Explore plate and in
the MCP server's answer. This page lists the eight words, what has to be true on chain for each, and
what Moolam does about a picture that someone registers after another person already did.

## Why there is one mark

A passport carries several facts that can each change what a reader should think of it: a
challenge, Chainlink's verdicts, a look-alike record, whether the picture was ever published. Shown
side by side, they leave the reader to decide which one wins. The mark decides for them, the same
way every time: the states are ranked worst first, and a passport wears the first one that holds.

One function issues it, `issueMark` in `packages/web/components/mark/mark.ts`, and the MCP server
keeps the same file byte for byte, so the site and an AI agent can never give one passport two
different marks. A state is chosen only after every worse one has been ruled out by a read that
succeeded. When a read that could make the mark worse fails, no mark is shown and the page says:
"The mark could not be read just now, so none is shown. Try again in a moment."

## The eight states, worst first

| Mark | What the page says | What lights it |
| --- | --- | --- |
| Challenge upheld | "Moolam upheld a challenge against this record. Treat it, and its AI-use terms, as wrong." | The registry says a challenge against this passport was upheld. Nothing outranks it |
| Does not match | "Chainlink's network fetched the picture this passport points to, and it is not the picture that was registered." | The newest verdict from Chainlink's network says the picture does not match its passport |
| Registered after a look-alike | "An earlier passport, {title}, looks like the same picture. It was registered on {date}, before this one." | The newest look-alike record from Chainlink's network names an earlier passport, and the index has checked both passports and their order |
| Challenged | "Someone put {bond} MON behind a claim that this record is wrong. The holder can answer until {date}." | A challenge is open on the registry |
| Waiting for Chainlink | "Registered {when}. Chainlink's network checks every new public passport, and has not checked this one yet." | The picture is public and the network has written no verdict on it yet |
| Checked by Chainlink | "Chainlink's network fetched this picture itself, measured it again, and it matches its passport: {bits} of 64 bits apart. Written on Monad on {date}." | The newest verdict from Chainlink's network matched |
| Sealed | "Never published, so Chainlink's network cannot check it. Its fingerprints are public, and a copy still finds it in Verify." | The picture was never published, and no network verdict exists |
| Nothing to check | "This passport names no picture, so Chainlink has nothing to fetch." | The passport's document names no picture |

A challenge that was rejected changes nothing: the record stands, and the passport wears whatever
mark it wore before.

A match needs both fingerprints. The look fingerprint must be within 10 of its 64 bits and the
layout fingerprint within 40 of its 256. When only the layout one misses, the page adds: "Chainlink's
network found the look fingerprint matches and the layout fingerprint does not. Both have to match,
so this passport does not pass." The two numbers live in one file, `lookalike-rule.ts`, which the
verify service and the Chainlink workflow keep byte for byte the same.

## Why only the network's verdicts count

Every verdict on Monad before 2026-10-02 came from Chainlink's simulator: one machine, with no group
of nodes having to agree. Those verdicts stay on the record and are still shown, each labelled "Test
run" with one line: "A test run on one machine, in Chainlink's simulator. It stays in the record and
never turns on the mark."

A verdict counts as the network's only when three things hold: it was written by Moolam's network
receiver, `MoolamReceiver` (0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04); the transaction went to
Chainlink's forwarder on Monad, 0x76c9cf548b4179F8901cda1f8623568b58215E62; and its block is at or
after 1790924898, which is 2026-10-02 07:08:18 UTC, the moment the network deployment went live. The
rule looks at the transaction rather than at the receiver's settings, because whoever owns a receiver
could point it somewhere else, and a transaction that never went through the forwarder never came
from Chainlink. The same rule decides look-alike records. It is held by `isNetworkWrite` in
`packages/indexer/src/network.ts`.

### What is live

Live on Monad mainnet since 2026-10-02:

- `MoolamReceiver` is on the policy's list again, in
  [transaction 0x446c3051…ff9f](https://monadvision.com/tx/0x446c3051322060339d8e95bcc2938ca6db6692e8d583d360ebab6e626ea1ff9f),
  block 109,830,535, at 07:08:18 UTC.
- Chainlink's network runs `moolam-verifier`, workflow ID
  `00c4dd797775bb465fff638ab5171b19a35ed11d4513eb4890661935d4801890`, owner
  `0xf072a8c620bfc818875736e3f2d3a2a339c06584`, active from about 07:09 UTC. On 2026-10-02 this deployment held the
  verdict step only.
- The first network verdict was written at 07:23:42 UTC for passport
  `0x793a540e287cbdfc6cb680c42b553641fa504afebcce6fd5f035e5e600f15782`, registered at 07:23:26 UTC in
  [transaction 0x162c97a7…feaa](https://monadvision.com/tx/0x162c97a70e53441e16633250e1cf96d695b01939d10625bf29248a9c01e3feaa).
  Ten Chainlink nodes recomputed its fingerprint, got distance 0 and matched. The verdict is
  [transaction 0x760dcb5e…2882](https://monadvision.com/tx/0x760dcb5e1b83929201d8fe299ce9c3be2cf8981502117c5288386d7da3438882),
  block 109,833,597, sent to the Keystone Forwarder: 16 seconds from registration to the network's
  verdict.

Live from 2026-10-07:

- The look-alike step in the network workflow.
- The verify service's look-alike routes and its Google web check on the hosted service.
- The hosted index rebuild that lets the live site's marks and counts see the network flag. Before
  that rebuild the live site's index could not tell a network verdict from a test run.

## Look-alikes

### What "Registered after a look-alike" means

Anyone can save a copy of someone else's picture and register it as a new original, because a new
file is a new hash. The look-alike check is how Moolam catches that after the fact.

The look-alike step is built and tested, and it is in the network deployment from 2026-10-07, with the
verify service's look-alike routes. What follows is how it works.

When Chainlink's workflow has written its verdict on a new original passport, and its own
measurement of the picture matched, it asks Moolam's verify service for up to three earlier
passports with fingerprints close to this one. The service only names candidates. The workflow then
reads each candidate from the registry itself and keeps it only when it was registered in a strictly
earlier second, by another creator, and lands within both thresholds of the workflow's own
measurement, in any of the picture's eight turns and mirrors. The earliest one kept, or "none", is
written to `MoolamLookalikes`
([0xC0f3984A8116dB8BE514F649e3605A2a3aCd454C](https://monadvision.com/address/0xC0f3984A8116dB8BE514F649e3605A2a3aCd454C)).
That contract accepts a report only from Chainlink's forwarder, for one workflow owner and one
workflow name, and its ownership was given up after those were set, so nobody can point it anywhere
else. A run every ten minutes catches any passport whose check was missed.

Two passports registered in the same second are never "earlier" than each other. Monad seals more
than one block a second and the registry keeps whole seconds, so the seconds alone cannot order them.

On the later passport the page shows the record in amber, headed "Earlier passport found":
"Chainlink's network measured this picture itself and found {title}, registered on {date}, {bits} of
64 bits apart. Written on Monad on {at}." Under it: "Registered first is not the same as made first.
Anyone can challenge either passport with evidence." When the earlier passport is sealed, the line
says instead: "An earlier sealed passport carries a fingerprint like this picture's. Its picture was
never shown, so nobody can compare the two." The earlier passport gets a quiet line: "A later
passport looks the same: {title}, registered on {date}." Explore has a chip for each side,
"Registered after a look-alike" and "Has later look-alikes".

Before the network has written anything, Moolam's own search may already see an earlier passport.
That shows in grey, never as a mark: "Moolam's search found an earlier passport like this: {title},
registered on {date}. Chainlink has not confirmed it yet." A network record that names no earlier
passport reads "Chainlink found no earlier look-alike among the candidates Moolam's search
proposed." It never says the picture is original.

### Labels, not refusals

Moolam registers the look-alike anyway. Refusing it would hand the picture to whoever registers
first, and a thief who got there before the maker would lock the maker out for good. A label shows
everyone the order the chain recorded, and a challenge can settle who is right.

### The warning before the passkey

The check also runs before anyone signs. When a person prepares a picture in the studio, or a
platform prepares one through the kit, the verify service searches the earlier passports and the
answer comes back in one of four ways:

- "A picture like this is already registered": "{title} was registered by someone else on {date}. If
  it is yours too, carry on. If it is not, stop here: your passport would show it came later, and
  anyone can challenge it."
- "You registered a picture like this before": "If this is a new version, register it as an edit of
  that passport, so the two stay linked."
- "Moolam's search found no earlier passport like this one, as of {time}."
- "Moolam could not search for earlier passports just now, so this picture was not compared with
  them. You can still register it."

On the first two, and when the web check below finds pages, the studio stops before the passkey
opens and shows the warning where the register button was. The first warning adds: "If you go
ahead, your passport records that you were shown this one." A passport signed past that warning
says on its page: "Before signing, they were shown an earlier passport like this one."

### The web check

A public photo uploaded in the studio is also checked against the web before signing. The studio
says so beside the upload: "A public photo is checked against the web. Moolam sends its small public
copy to Google, which looks for the same picture on web pages. Sealed pictures and pictures the agent
draws are never sent."

What leaves Moolam is the picture's public thumbnail, at most 512 pixels on its longest side, the
same one Moolam pins for the passport. It goes to Google Cloud Vision's web detection with Moolam's
key in a header. A
picture from a platform, a generated picture and a sealed one are never sent. When Google names
pages, the studio shows "Already on the web" with the list before signing, and the passport records
the count and up to ten page addresses. The passport page draws them as text, never as links,
under "Already on the web", and says the registrant's web check found the picture on that many pages
before it was registered. When Google finds nothing, fails or is slow, nothing is recorded and nothing is said. No page ever
says a picture was not found online, because silence proves nothing.

## The sworn line and a platform's statement

Beside every sign button in the studio, on the co-sign page and for every edit, the person reads:

> By signing, you state: "I made this picture, or I hold the rights to register it." This line goes
> into the passport you sign, for anyone to read.

The line and its version are written into the document whose address the passkey signs, so a
passport always shows the exact words it was signed under, in English, whatever language the site
was read in. A platform registering in its own name through the kit may send its own
statement instead, one line of at most 1,000 bytes, and the page shows it as that platform's
statement. A
document never carries both.

These are the registrant's own words, and the page draws them that way, never as a fact the chain
proved. A passport registered straight on chain, outside Moolam's studio and the kit, carries
neither, and its page says so: "Registered outside Moolam's studio: no sworn statement, no web
check."

## Read more

- [Threat model: look-alikes, the trust mark and challenges](../security/threat-model#look-alikes-the-trust-mark-and-challenges)
  holds every rule above with the file and function that keeps it, and the weaknesses not fixed.
- [Disputes](../guides/disputes) is how a challenge runs, who decides it, and how the holder answers.
- [Verify a copy](../guides/verify-a-copy): hand Verify any copy and it names the first registration
  of that picture.
