---
title: Read a passport
---

# Read a passport

A passport page is one registered image and everything the chain and the index know about it. Every
block on it is a live read: nothing is cached into the page and nothing is written by hand.

You get to one from a verify result, from "Your passports" in the studio, from an agent's contact
sheet, or from the id directly. The id is the sha256 of the registered bytes, so the URL of a
passport is a fact about the file rather than a database key.

If the id is not 64 hex characters, or no passport holds it, the page says "No passport with that
id. Check the id, or find it from the verify page."

## The poster

The registered picture, full bleed, with the title and four facts over it.

| On the poster | Where it comes from |
| --- | --- |
| The picture | The IPFS metadata pinned at registration, fetched through the gateway |
| The title | The `name` field of that same metadata |
| One word of standing | Worked out from the record: "Checked by a verifier on chain", "A re-check did not match", "Disputed", or "Not re-checked yet" |
| Generated, Captured or Edited | The `kind` field on the chain record |
| The date and time | `registeredAt` on the chain record, the block timestamp |
| The fingerprint version | `fingerprintVersion` on the chain record |

Standing follows a strict order. A dispute outranks everything, because it is the only state with
money behind it. A re-check that did not match comes next, because a passport nobody has checked
and a passport that failed a check must never read the same. Everything else is simply not
re-checked yet, which is the honest word for registered and nothing more.

If the gateway will not hand the picture over, the poster shows the seal and says "Image
unavailable from IPFS right now" rather than a broken image icon. The record is on chain either
way.

## Checked again, by someone else

The loudest block on the page, and the one that separates a passport from a caption. Its own line
says why: "Anyone can say a picture is theirs. This part is different: a Chainlink CRE workflow
fetched the image, hashed it again and wrote the answer back on Monad."

Each entry is one attestation stored on the registry. Above its fields the page draws both
fingerprints as the 64 bits they are, the registered one and the recomputed one side by side with
every disagreeing cell marked, and states the verdict in a sentence: a Chainlink CRE workflow
re-fetched this picture and recomputed its fingerprint, so many of 64 bits apart, counted on the
page from those two values rather than copied from the figure the receiver wrote.

Under that sentence the page says how the report reached the chain. It reads the `to` address of the
report transaction: the CRE simulation forwarder means one machine ran the workflow with no network
consensus, which is what every re-check on chain today came from, and the Chainlink network forwarder
means a quorum of nodes agreed on the answer. An address that is neither gets no line at all.

| Field | What it is |
| --- | --- |
| matched or did not match | Whether the recomputed hash was inside the threshold |
| Who wrote it | "Re-checked by a Chainlink CRE workflow" when the writer is the `MoolamReceiver` deployed with the registry, otherwise "Written by an allowed receiver" and the address |
| "As the receiver wrote it" | How many of 64 bits the receiver itself said the two hashes were apart |
| "At" | The block timestamp on the attestation |
| "Written by" | The receiver address, linked to MonadVision |
| "Recomputed pHash" | The hash the verifier computed, printed in full |
| The transaction | From the Envio index, which carries the transaction hash for each attestation |

The Chainlink line is not a badge Moolam awards itself. A log-triggered Chainlink CRE workflow wakes
on `PassportRegistered`, reads the passport back out of the registry rather than trusting the event,
downloads the thumbnail on each node, decodes the JPEG and recomputes the 64-bit hash inside the
sandbox, and the verdict is signed into a report. Chainlink's KeystoneForwarder delivers it to
`MoolamReceiver`, which calls `attest`. The registry checks the receiver against `VerifierPolicy`
before it writes. The workflow is written so that on Chainlink's network a quorum of nodes must
produce the identical verdict before that report is signed, which is the difference the forwarder
line above names.

A passport with no attestation says so plainly: "No verification has been written for this passport
yet. The Chainlink workflow adds one when it re-checks the image." Where the index has no
transaction for one, it says "The index does not carry the transaction for this one." rather than
linking somewhere it cannot back up.

The workflow is described in full in [Chainlink workflow](../developers/chainlink-workflow).

## The record

Two columns that deliberately do not match: who and when on the wide side, the hashes on the narrow
one.

**The wide side, all read from the chain.**

- "Creator", the address that signed the registration, linked to MonadVision, with one line
  underneath: "This creator's wallet has a passkey bound on chain." or "No passkey is bound to this
  creator's wallet."
- "Owner", `ownerOf` for this token id today. It starts as the creator and changes if the token is
  transferred.
- "Generator agent", a link to the agent page for a Generated passport, or "No generating agent.
  This one was registered as a photograph." for a Captured one.
- "About" and "Prompt", when the pinned metadata carries them. These are the only two fields on the
  page that come from a document rather than from the chain.

**The narrow side, the fingerprints.** Its own line explains the point: "A verifier fetches the
picture, hashes it again and compares it with these. Nothing here depends on the file name or on
anything the metadata claims."

- "pHash", the 64-bit perceptual hash as a hex word.
- "Blockhash", the 256-bit second perceptual hash.
- "Exact bytes", the sha256 of the registered file.
- "Manifest hash", the sha256 of the C2PA manifest store, or 32 zero bytes when nothing was
  embedded.
- "Metadata", the `ipfs://` URI, linked through the gateway.
- "Passport id", in full, with a note that it is also the ERC-721 token id.

These are shown in full rather than shortened, because they are the part a verifier recomputes.
What each hash is and how it is computed is in [Fingerprints](../concepts/fingerprints).

## How AI may use this picture

What the holder has said about AI training, read live from the consent register on Monad. Its own
line says why it is not simply a line in the file: a file can carry a line saying its creator
refuses AI training, and anyone can strip that line out on the way past. This is the same statement
written to a register where only the holder of this passport can write it and nobody can take it
back out.

The block leads with the passport's life drawn as one rule, from the day it was registered to today,
with every statement marked on it. Drag the thumb, or use the arrow keys, and the page asks the
chain what was in force on the day under it: `consentAt` for that second, not today's answer with an
old date printed over it. While it asks it says so, and if the chain does not answer for that day it
says that too rather than filling the gap. Above the rule is the reading itself, headed "On this day,
AI could", in one of five summaries: Open to AI use, Not for AI training, Ask the holder first,
Stated use by use, or Nothing stated yet.

Under the rule is what the summary loses.

| On the block | What it is |
| --- | --- |
| The four uses | AI training, Generative AI training, AI inference and Data mining, each Not stated, Allowed, Not allowed or Conditions apply. They are independent, which is where training and inference are allowed to differ |
| Conditions, in the holder's words | The text beside a statement that says conditions apply, with which uses it applies to. Present only when there is one |
| Stated by | The address that held the passport when the statement was written, linked to MonadVision |
| Written on | The block timestamp of that statement |
| The history | Every statement this passport has collected, oldest first, each with its date and who wrote it, and the one that stands today marked |

A passport nobody has spoken for is a designed state rather than an empty box: "Nobody has written a
statement for this picture. It is reported here as silence, because that is what it is: no use has
been allowed by it." The four marks are drawn in a colder family than the accent so a creator's no
never reads as a fault.

If the register cannot be read, the block says the chain could not be asked and that this is not
permission either. It does not fall back to anything.

**The control is the holder's alone.** A wallet that holds the passport sees "Say how AI may use it"
under the block, with the same three plates the studio offers and a use-by-use expander. Anyone else
sees only the reading. The send is sponsored, so it costs the holder nothing, and the page confirms
it by reading the chain back rather than by trusting the send. The register takes one statement per
wallet every ten minutes for the same picture, so after one lands the control locks and prints the
time it opens again.

What the choices mean and what they do not do is in
[Say how AI may use a picture](ai-use-statements).

## Challenged

This block only appears when a dispute exists. A passport nobody has challenged says nothing here,
because an empty dispute box on every page would read like an accusation.

It shows the status, one of "Open, and not yet settled", "Upheld: the challenge was right" or
"Rejected: the record stands", plus the challenger, the bond in MON, when it was opened and the
evidence hash. The rules behind it are in [Disputes](disputes).

## Edits

Where this picture came from and what was made out of it. An edit registers as its own passport
carrying its parent's id, so the chain of edits is a record rather than a claim in the metadata.

"Edited from" links to the parent when there is one. "Registered from this one" lists the children,
read from `getChildren` on the registry. With no children it says "No edit has been registered from
this passport." The rules are in [Edits and lineage](edits-and-lineage).

## Check a copy

The same verify run as the verify page, asked from the one place where you are already looking at
the original. Drop any copy on "Is your copy this picture?" and it answers against this passport
rather than against the whole registry:

- "Yes. Byte for byte, this is the file."
- "Yes. This is the same picture."
- "No. This copy belongs to a different passport."
- "This copy matches no passport at all."

The hint under it is honest about the limit: "A resized, re-encoded, turned or mirrored copy still
matches. A crop does not, yet."

## Where each number comes from

| Source | What it supplies |
| --- | --- |
| Monad, read directly | The record, the owner, the attestations, the edits, the dispute, whether the creator has a passkey bound, and every statement about AI use including the answer for a past day |
| The Envio index | The transaction hash for each attestation, and the block for a fresh registration |
| IPFS through the gateway | The picture, the title, the description and the prompt |

If Monad cannot be read, the page says so with the RPC's own reason and asks you to reload. It does
not fall back to a cached copy, because a passport page that might be stale is worse than one that
says it could not read the chain.
