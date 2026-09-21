---
title: MoolamConsent
---

# MoolamConsent

`0x1151E69a82947920546e779c4C8c785b2a3C1277` on Monad mainnet, chain 143, deployed in block
105828247 and verified on MonadVision through Sourcify. The ABI is in
`packages/contracts/abi/MoolamConsent.json`.

Where a passport's holder states whether their picture may be used to train AI, and the record of
every statement they have made. It is a separate contract from the registry, immutable, with no
owner, no upgrade path and no way to send it money. It reads one thing from the registry,
`ownerOf`, and that answer is the only authority over who may write.

The vocabulary is the Creator Assertions Working Group's Training and Data Mining assertion, version
1.1. The contract names it on chain so a reader never has to guess what a value means.

## Types

```solidity
enum Use { Unspecified, Allowed, NotAllowed, Constrained }

struct Consent {
    Use aiTraining;
    Use aiGenerativeTraining;
    Use aiInference;
    Use dataMining;
}

struct Entry {
    uint64  at;             // block timestamp of the write
    address writer;         // the holder who wrote it
    Consent consent;
    string  constraintInfo; // empty unless a field is Constrained
}
```

The four uses are independent: a holder can refuse training and still allow inference.
`Unspecified` is where every passport starts and is also the way back, because a holder who no
longer wants to say anything writes all four fields `Unspecified` again. Per the standard, a reader
with no way to reach the creator treats `Constrained` the same as `NotAllowed`.

## Constants

| Function | Value | What it is for |
| --- | --- | --- |
| `STANDARD()` | `"cawg.training-mining/1.1"` | The vocabulary, named on chain |
| `REGISTRY()` | `0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0` | The passport registry, fixed at deployment |
| `MIN_INTERVAL()` | `600` | Seconds the same writer waits before changing the same passport again |
| `MAX_INFO_BYTES()` | `256` | The longest the conditions text may be |
| `MAX_PAGE()` | `64` | The most history entries one read returns |
| `MAX_BATCH()` | `32` | The most passports one batch call may state for |

## Writes

### setConsent

```solidity
function setConsent(bytes32 passportId, Consent calldata consent, string calldata constraintInfo) external
```

Records what the passport's holder allows AI to do with their picture. Only the address the registry
returns from `ownerOf` during this same call may send it. An ERC-721 approval or an operator is
permission to move the token, granted to marketplaces and escrows, and it is refused here: it must
never become permission to speak for the creator.

| Parameter | Meaning |
| --- | --- |
| `passportId` | The passport the statement is about, the same id as everywhere else |
| `consent` | The four field values. All four `Unspecified` is a valid statement and takes an earlier one back without hiding it |
| `constraintInfo` | The conditions in free text. Required when any field is `Constrained`, refused otherwise |

| Reverts | When |
| --- | --- |
| `NotPassportHolder(passportId, caller)` | The caller is not what `ownerOf` returns, or the passport does not exist. A passport nobody minted makes `ownerOf` revert, which is caught and turned into this rather than handing the caller another contract's error |
| `TooSoon(passportId, nextAllowedAt)` | The same writer changed this passport less than `MIN_INTERVAL` ago, or the block timestamp has not moved past the last entry |
| `ConstraintInfoRequired` | A field is `Constrained` and the text is empty |
| `ConstraintInfoNotAllowed` | No field is `Constrained` and the text is not empty |
| `ConstraintInfoTooLong(length)` | The text is over `MAX_INFO_BYTES` |
| `ConstraintInfoNotPrintable(position)` | A byte outside 0x20 to 0x7E, naming which one |

Emits `ConsentSet`.

The text rule is one predicate over every byte rather than a list of shapes to refuse, so there is no
entry nobody thought of. It covers control characters, the newline that would split a log line, and
the raw bytes that start a UTF-8 escape. It does not judge what the text says or where a link inside
it points, so a reader that follows one still owes its own check.

### setConsentBatch

```solidity
function setConsentBatch(bytes32[] calldata passportIds, Consent calldata consent, string calldata constraintInfo)
    external
```

The same statement for a whole set of passports in one transaction, for a creator who wants one
policy across their work. All or nothing: if any one passport is refused, for any reason, nothing is
written for any of them and the caller gets that passport's own error.

Every passport goes through the same private write as a single statement, and `ownerOf` is read
again for each one, so no answer is carried over from the passport before it. Naming the same
passport twice in one call is refused as `TooSoon`, because the first write already happened this
second.

| Reverts | When |
| --- | --- |
| `EmptyBatch` | No passports |
| `BatchTooLarge(length)` | More than `MAX_BATCH` |
| anything `setConsent` reverts with | For the first passport in the list that is refused |

Emits one `ConsentSet` per passport, in the order given.

## Reads

Every view answers for any id and any timestamp. Nothing here can be made to fail.

| Function | Returns |
| --- | --- |
| `consentOf(bytes32 id)` | `(bool stated, Entry latest)`. `stated` is false with an empty entry when the holder has never said anything |
| `consentAt(bytes32 id, uint64 timestamp)` | `(bool stated, Entry inForce)`, the last entry written at or before that moment. False before the first statement |
| `historyLength(bytes32 id)` | How many statements a passport has collected, zero for one nobody has spoken for |
| `historyPage(bytes32 id, uint256 start, uint256 count)` | A page of entries, oldest first, clipped to what exists and to `MAX_PAGE`. Empty when `start` is past the end |

`consentAt` is a binary search over the history, which is exact because a write is refused unless its
timestamp is strictly later than the one before it. The loop runs log2 of the history length times,
so a passport with a thousand statements costs ten steps.

## Events

### ConsentSet

```solidity
event ConsentSet(
    bytes32 indexed passportId,
    address indexed writer,
    uint256 indexed index,
    Consent consent,
    string  constraintInfo,
    uint64  at
)
```

One per successful write, carrying everything that was stored, so an indexer reading the logs and a
caller reading the storage cannot disagree. It is also in [Events](events) beside the registry's own.

## Worked examples

Every command below was run against `https://rpc.monad.xyz` on 2026-09-21 and its output is pasted
underneath. Foundry is at `~/.foundry/bin`. The passport is `monsoon-fishing-nets-drying`, whose
holder refused all four uses on 2026-09-18.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
CONSENT=0x1151E69a82947920546e779c4C8c785b2a3C1277
PASSPORT=0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638
ENTRY='(bool,(uint64,address,(uint8,uint8,uint8,uint8),string))'
```

**What stands right now.**

```bash
cast call $CONSENT "consentOf(bytes32)$ENTRY" $PASSPORT --rpc-url https://rpc.monad.xyz
```

```
true
(1789717128 [1.789e9], 0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6, (2, 2, 2, 2), "")
```

`(2, 2, 2, 2)` is `NotAllowed` on all four uses. `1789717128` is 2026-09-18T07:38:48Z. The empty
string is the conditions text, which is empty because nothing is `Constrained`.

**What was in force an hour before that statement.** This is the question a label inside a file
cannot answer.

```bash
cast call $CONSENT "consentAt(bytes32,uint64)$ENTRY" $PASSPORT 1789713528 --rpc-url https://rpc.monad.xyz
```

```
false
(0, 0x0000000000000000000000000000000000000000, (0, 0, 0, 0), "")
```

False means nothing had been stated yet at that moment. It is not permission.

**What was in force at a given second today**, 1789985411, which was 2026-09-21T10:10:11Z.

```bash
cast call $CONSENT "consentAt(bytes32,uint64)$ENTRY" $PASSPORT 1789985411 --rpc-url https://rpc.monad.xyz
```

```
true
(1789717128 [1.789e9], 0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6, (2, 2, 2, 2), "")
```

The statement from three days earlier is still the one that stands, which is what a dated record is
for.

**The whole history.**

```bash
cast call $CONSENT "historyLength(bytes32)(uint256)" $PASSPORT --rpc-url https://rpc.monad.xyz
cast call $CONSENT "historyPage(bytes32,uint256,uint256)((uint64,address,(uint8,uint8,uint8,uint8),string)[])" \
  $PASSPORT 0 64 --rpc-url https://rpc.monad.xyz
```

```
1
[(1789717128 [1.789e9], 0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6, (2, 2, 2, 2), "")]
```

A page past the end is an empty list rather than a revert:

```bash
cast call $CONSENT "historyPage(bytes32,uint256,uint256)((uint64,address,(uint8,uint8,uint8,uint8),string)[])" \
  $PASSPORT 5 64 --rpc-url https://rpc.monad.xyz
```

```
[]
```

**A statement with conditions**, on `madurai-tiffin-at-five`, whose holder said ask first:

```bash
cast call $CONSENT "consentOf(bytes32)$ENTRY" \
  0x7cb4aead3b37f16b78a203a43aba83db10fa5f2fc7629f353826183d8c9d693f --rpc-url https://rpc.monad.xyz
```

```
true
(1789717132 [1.789e9], 0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6, (3, 3, 3, 3), "Ask first: open an issue at https://github.com/ramakrishnanhulk20/Moolam/issues")
```

`(3, 3, 3, 3)` is `Constrained` on all four, and the text is where to ask.

**A passport nobody has spoken for.**

```bash
cast call $CONSENT "consentOf(bytes32)$ENTRY" \
  0x0000000000000000000000000000000000000000000000000000000000000001 --rpc-url https://rpc.monad.xyz
```

```
false
(0, 0x0000000000000000000000000000000000000000, (0, 0, 0, 0), "")
```

An unknown id answers rather than reverting, which is what lets a crawler ask about anything.

**The vocabulary, from the contract itself.**

```bash
cast call $CONSENT "STANDARD()(string)" --rpc-url https://rpc.monad.xyz
```

```
"cawg.training-mining/1.1"
```

## Constructor

```solidity
constructor(address registry)
```

Reverts `ZeroAddress` when the registry address is zero and `NotAContract` when it has no code.
`ownerOf` is read through `try/catch`, and a call to an address with no code returns empty data that
cannot be decoded, which would make every passport look unheld, so that is refused at deployment
rather than shipped as a contract nobody can ever write to.

The registry address is never settable afterwards. What a creator states here and what the verify
service returns is in [Verifier endpoints](verifier-endpoints); what the choices mean is in
[Say how AI may use a picture](../guides/ai-use-statements).
