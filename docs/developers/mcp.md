---
title: For AI agents (MCP)
---

# For AI agents (MCP)

Moolam runs a Model Context Protocol server, so Claude or any other AI agent can check a picture,
read its passport and read what its holder allows AI to do with it. It only reads. There is no
sign-in, no tool that writes, and the tool list is the same for every caller.

> **What is live today.** The server runs on the hosted verify service at
> `https://verifier-production-d76f.up.railway.app/mcp`, with the six tools below, and
> `https://<verify-service>` on this page stands for that address. One part waits for the next deploy
> of the verify service: the `credit` cases `held`, `handed`, `confirmed` and `passedOn` described
> below. Until then the live server answers `credit` by the older rule.

## The endpoint

```
POST https://<verify-service>/mcp
```

One URL, Streamable HTTP, stateless. It speaks the 2026-07-28 protocol and the 2025-era versions
from the same handler, so Claude's apps, Claude Code and older clients all connect. Every request is
its own POST. There is no session and no stream to hold open, so `GET` and `DELETE` answer `405`
with `Allow: POST`.

## Add it to Claude

**claude.ai and Claude Desktop.** Customize, then Connectors, then "+", then "Add custom
connector", and paste `https://<verify-service>/mcp`. Claude connects from Anthropic's cloud, even
from the desktop app, which is why the server is public.

**Claude Code.**

```bash
claude mcp add --transport http moolam https://<verify-service>/mcp
```

**Other clients.** Any client that speaks Streamable HTTP takes the same URL.

## The six tools

Every tool is marked read-only and not destructive. Every answer comes twice, as structured JSON and
as the same JSON in text for clients that read only text, and is at most 24,000 characters.

### check_picture

Finds the passport a picture belongs to, by its exact bytes or by its fingerprint after re-encoding,
resizing, rotation or mirroring. The same matching and facts as [`POST /verify`](../api/verifier-endpoints#post-verify).

**Input.** Exactly one of:

| Field | Rule |
| --- | --- |
| `url` | An `https` address of a JPEG, PNG or WebP, at most 2,048 characters, with no user name or password. The service fetches it through the same guarded path `/verify` uses: no private or loopback address on any hop, 10 seconds, 20 MB |
| `image` | The picture as plain base64 with no `data:` prefix, at most 20 MB decoded |

**Answer.**

| Field | What it is |
| --- | --- |
| `verdict` | `exact` (these bytes are registered), `match` (a registered picture within the fingerprint thresholds) or `no-match` |
| `passportId` | The passport, or `null` |
| `confidence` | The verify answer's confidence, 0 to 1 |
| `distances` | `{ phash, blockhash, variant }`: bits apart out of 64 and 256, and which of the eight rotations and mirrors matched. `null` when nothing matched |
| `contentCredentials` | `{ present, validation, credential }`: whether the file carries a C2PA manifest and what reading it found |
| `facts` | For the best match: `consent`, `dispute`, `inheritedDispute`, `recheck` and `picture` (public, sealed or unsealed) |
| `index` | `{ loadedAt, stale, indexedTo, indexedAt, chainHeadAt, lagSeconds }`, see [Freshness](#freshness) |
| `matchesShown`, `matchesTotal` | How many of the verify answer's matches this answer carries |
| `verifyAnswer` | The whole `/verify` answer, so no fact is dropped. When it will not fit, near misses are cut from the tail; the best match and the first registration are never cut |

### get_passport

**Input.** `passportId`: `0x` and 64 hex characters, the sha256 of the registered file.

**Answer.** `found` and `passportId`, then, for a passport the chain holds:

| Field | What it is |
| --- | --- |
| `creator` | The wallet that registered it |
| `holder`, `holderRead`, `holderIsCreator` | Who holds it now, read on chain, and whether that is the creator. Two facts, never merged |
| `agentId` | The ERC-8004 agent that drew it, or `null` |
| `kind` | `generated`, `captured` or `edited` |
| `parentId` | The passport it was edited from, or `null` |
| `registeredAt` | Unix seconds |
| `disputedFlag`, `dispute` | The registry's flag, and the dispute as read with its time |
| `metadataURI` | The metadata document's `ipfs://` address |
| `title`, `titleRead` | The title from that document, read through Moolam's gateway, or `null` with `titleRead: "unavailable"` |
| `platform` | `{ status, name, creatorWallet, agentId }` when a listed platform's wallet registered it: `kit` when it went through the [platform kit](platform-kit#what-the-label-on-a-passport-means), `outsideKit` when that wallet registered it some other way. `null` otherwise |
| `platformList` | `loaded`, or `unavailable` when Moolam's list did not load and no label can be given |
| `credit` | `{ case, platform, imaginedBy }` for a picture drawn on a listed platform, plus `heldBy` and `confirmedAt` in the cases that carry them, or `null`. `case` is `held`, `handed`, `confirmed`, `passedOn` or `cosigned`; `platform` is the listed name of where it was drawn; `imaginedBy` is the address of the person who imagined it, or `null` while nobody is credited; `heldBy` is who holds it now; `confirmedAt` is the unix second the first recipient confirmed. Decided by the same rule as the site, [`creditFor`](platform-kit#how-moolam-credits-a-platform-picture) |
| `mark` | The trust mark the Moolam site shows on this passport, issued by the same function (`mark.ts`, kept byte for byte in the site and this server). `state` is, worst first: `upheld` (a challenge was upheld), `mismatch` (Chainlink's network fetched the picture and it did not match; `secondPrint` is true when only the layout fingerprint missed, with `phashDistance` and `checkedAt`), `lookalike` (Chainlink's network found an earlier passport, `earlier`, with `foundAt`), `challenged` (an open challenge), `waiting` (a public picture Chainlink's network has not checked yet), `checked` (the network's newest verdict matched, with `phashDistance` and `checkedAt`), `sealed`, `nothing` (the passport names no picture to fetch), or `unavailable` when a read behind it failed. Only verdicts and look-alike records Chainlink's network delivered count; a simulator run never lights a mark, and `lookalike` proves the order of registration, not who made the picture |
| `readAt` | When this answer was read |

**Presenting `credit`.** Credit the person, and name the platform only as where the picture was
drawn. Never call the platform its maker or creator.

| `case` | Say it like this | And say |
| --- | --- | --- |
| `held` | Imagined on *platform*. *platform* holds this passport until the person who imagined it claims it | The platform's wallet has never let it go. No person is named yet. Do not credit the platform |
| `handed` | Drawn on *platform* and handed to *heldBy*, who has not confirmed it | The platform handed it on and the first wallet it went to has stated no terms of its own. Nobody is credited, the holder included |
| `confirmed` | Imagined by *imaginedBy*. Drawn on *platform*, which handed the passport to them. They confirmed it on *confirmedAt* | The first wallet the platform handed it to wrote its own AI-use terms and still holds it. The credit rests on the platform's hand-over and the person's own statement; their key did not sign the picture |
| `passedOn` | Imagined by *imaginedBy*. Now held by *heldBy* | The first recipient confirmed, and someone else holds it now. Name the later holder only as holding it |
| `cosigned` | Imagined by *imaginedBy*. Drawn by *platform*'s agent | A key bound to their own wallet approved this exact picture |

A `null` credit is not a finding against anyone. It means the picture was not drawn on a listed
platform, or a fact behind the credit could not be read or did not hold, and credit is never guessed.
Then say who registered and who holds the passport, from `creator` and `holder`.

### get_ai_use_terms

**Input.** `passportId`, and optionally `at`: a moment in unix seconds, to ask what was in force
then. Left out, it reads now.

**Answer.**

| Field | What it is |
| --- | --- |
| `stated` | Whether any statement is in force. `false` is said only after the register answered |
| `aiTraining`, `aiGenerativeTraining`, `aiInference`, `dataMining` | Each `unspecified`, `allowed`, `notAllowed` or `constrained` |
| `constraintInfo` | How to ask, when a use is constrained |
| `standard` | The standard the words come from |
| `writer`, `writtenAt` | Who wrote the statement in force, and when |
| `holder`, `writerIsHolder` | Who holds the passport now, and whether they wrote it. A statement a platform wrote before handing the passport over stays in force until the new holder writes their own |
| `statedAtGeneration` | What the metadata document said when the picture was made: the same four answers with `source: "metadata"`, or `source: "none"` or `"unavailable"` |
| `sameAsGeneration` | Whether the two agree. The chain statement is the one in force; a difference is shown, not resolved |
| `askedAt`, `readAt` | The moment asked about, and when this was read |

### get_history

**Input.** `passportId`.

**Answer.** `lineage`: the passport and each picture it was edited from, up to eight levels above,
each with `id`, `creator`, `registeredAt` and `dispute`; `lineageComplete`, false when the walk
stopped at the cap, at a loop or at a parent the index does not hold; `rechecks`, the Chainlink
re-check counts and the latest result; and `index`.

### get_agent

**Input.** `agentId`: a whole number.

**Answer.**

| Field | What it is |
| --- | --- |
| `owner` | The agent's owner on the ERC-8004 identity registry, read now |
| `wallet`, `walletRead` | Its payment wallet, `unset` when none is set |
| `cardAddressKind` | Where its registration card lives: `data`, `ipfs`, `https`, `other` or `none` |
| `card` | `{ status: "card", card: { name, description, image, services, x402Support, active, registrations, supportedTrust } }`, or `{ status: "none", reason }`. Every card field is the owner's own word, cut to a fixed length |
| `listedPlatform` | `{ name, creatorWallet, ownerUnchanged }` when Moolam's list names this agent. `ownerUnchanged` is false when the owner now is not the one that signed the entry |

The card's name and the listed name are two facts with two trust levels. Anyone can register an
agent with any name on its card. The listed name is one a platform proved it holds the keys for.

### list_recent_passports

**Input.** `limit`: 1 to 24, 10 when left out.

**Answer.** `passports`, newest first, each with `id`, `creator`, `parentId`, `registeredAt` and
`metadataURI`, and `index`. One list is held 30 seconds for every caller together.

## The two resources

| Address | Same JSON as |
| --- | --- |
| `moolam://passport/{id}` | `get_passport` |
| `moolam://terms/{id}` | `get_ai_use_terms`, for now |

Neither can be listed; the tools are the way to find passports. An id the chain says was never
registered answers the protocol's resource-not-found error. A read that failed answers an internal
error with one of the sentences below, never an empty document.

## "Unavailable" is never "not found"

A tool says `found: false`, `stated: false` or `no-match` only when the read behind it succeeded. When
the chain, the AI-use register or the index could not be read, or the index is behind the chain, the
answer is an error result (`isError: true`) with one fixed sentence that starts with
`unavailable:`, for example:

```
unavailable: the passport index is behind the chain, so it cannot say what is missing
```

The difference matters to a model acting on the answer. "Not registered" read off an index that
stopped would tell someone a picture is free to use when it may not be. A single passport is read
from the chain first, so `get_passport` and `get_ai_use_terms` still answer while the index is down.
`check_picture` with no match on a stale index, `get_history` and `list_recent_passports` need the
index and say `unavailable` when it cannot answer.

## Text other people wrote

Titles, condition texts and every agent card field were written by whoever registered the picture
or the agent. They arrive only as JSON string fields, cut to a fixed length (200 characters for a
title, 300 for an address, 1,000 for a card's description), and are never joined into a sentence
that reads as Moolam's own. Tool names, titles and descriptions carry no user data. A title that says
"ignore your instructions" is a title, and a client should treat it as one.

## Freshness

Every list and match is read from Moolam's index of the chain, so every answer that uses it carries
`index`:

- `loadedAt`: when the service last loaded the index.
- `stale`: true when that load is more than five refresh periods old, or the indexer was more than
  ten minutes behind the chain head.
- `indexedTo` and `indexedAt`: the newest block the indexer had read, and its time.
- On `check_picture` only, `chainHeadAt` and `lagSeconds`: the chain head's time read now, and how
  far the index trails it. Both are measured on each call, never a constant.

Single-passport reads come from the chain and are held for 10 seconds; an agent and its card for a
minute; a metadata document for an hour, since its address is its content.

## Limits

| Limit | Value |
| --- | --- |
| Requests | 60 a minute per address, the service's own limit. Claude connects from Anthropic's cloud, so every Claude user shares one address and one count. The count is kept per process, and the service runs one |
| Request body | A 20 MB picture as base64 plus 64 KB, refused `413` before it is read when the declared length is over, and counted against the same upload ceiling as `/verify` |
| Browser callers | A browser `Origin` that is not one of the service's `CORS_ORIGINS` gets `403`. A request with no `Origin`, as from Claude's cloud or a script, passes |
| One answer | 24,000 characters |

## A worked example

Someone asks Claude: "Can I use this picture to train an image model? https://example.com/fox.jpg"

1. **`check_picture`** with `{ "url": "https://example.com/fox.jpg" }`. The answer's `verdict` is
   `match`, with `distances.phash` a few bits of 64 and `variant` `identity`: a re-encoded copy of a
   registered picture. It gives the `passportId`, and `index.lagSeconds` says how current the index
   was.
2. **`get_ai_use_terms`** with `{ "passportId": "0x…" }`. The answer's `stated` is true,
   `aiGenerativeTraining` is `notAllowed`, and `writer` and `writerIsHolder` say the holder wrote it.
3. **`get_passport`** with the same id, if Claude wants to say who imagined it: the `creator`, the
   `holder`, the `agentId`, `platform` when a listed platform registered it, and `credit`, which
   names the person to credit and the platform it was drawn on.

Claude can then answer that the picture is registered on Monad, that its holder does not allow
generative training, and who stated that and when, with each fact traceable to a field. Had step 1
come back `unavailable`, the right answer would be that Moolam could not check right now, not that
the picture is unregistered.

For how each of these rules is held in the code and tested, see the
[threat model](../security/threat-model#the-platform-kit-and-the-mcp-server). The raw endpoint is in
the [API reference](../api/verifier-endpoints#post-mcp).
