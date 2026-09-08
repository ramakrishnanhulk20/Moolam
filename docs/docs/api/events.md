---
title: Events
sidebar_label: Events
sidebar_position: 3
---

# Events

Every event across the three contracts, what its fields carry, and when it fires. Indexed
parameters are marked.

## MoolamRegistry

### PasskeyBound

```solidity
event PasskeyBound(address indexed wallet, bytes32 qx, bytes32 qy, uint256 nonce)
```

Fires on every successful `bindPasskey`, both the first bind and a rotation.

| Field | Meaning |
| --- | --- |
| `wallet` | The wallet the key now belongs to |
| `qx`, `qy` | The passkey public key coordinates |
| `nonce` | The bind nonce this signature consumed |

### PassportRegistered

```solidity
event PassportRegistered(
    bytes32 indexed passportId,
    address indexed creator,
    uint256 indexed generatorAgentId,
    bytes32 parentId,
    uint64  phash,
    bytes32 blockhash256,
    bytes32 manifestHash,
    uint8   kind,
    uint8   fingerprintVersion,
    string  metadataURI
)
```

Fires on `register` and on `appendEdit`. Indexers build the whole provenance graph from this one
event. It is also the trigger for the Chainlink CRE workflow.

| Field | Meaning |
| --- | --- |
| `passportId` | The sha256 of the exact image bytes, and the token id |
| `creator` | The wallet that owns the token |
| `generatorAgentId` | The ERC-8004 agent that generated the image, zero if none |
| `parentId` | The passport this one was edited from, zero for an original |
| `phash` | The 64 bit perceptual hash |
| `blockhash256` | The 256 bit block hash recorded with the image |
| `manifestHash` | The sha256 of the C2PA manifest store, zero when there is none |
| `kind` | 0 Generated, 1 Captured, 2 Edited |
| `fingerprintVersion` | Which fingerprint algorithm produced `phash` |
| `metadataURI` | Where the image, manifest and thumbnail live |

The ERC-721 `Transfer` from the zero address fires in the same transaction.

### VerificationAttested

```solidity
event VerificationAttested(
    bytes32 indexed passportId, address indexed receiver,
    bool matched, uint16 distance, bytes32 recomputed
)
```

Fires when a listed receiver rechecks a passport and records the result, which in practice means a
Chainlink CRE report landed through `MoolamReceiver`.

| Field | Meaning |
| --- | --- |
| `passportId` | The passport that was rechecked |
| `receiver` | The listed receiver that wrote the result |
| `matched` | Whether the recomputed fingerprint matched the recorded one |
| `distance` | The perceptual hash distance measured |
| `recomputed` | The fingerprint the verifier computed |

### PassportFlagged

```solidity
event PassportFlagged(
    bytes32 indexed passportId, address indexed challenger,
    uint256 bond, bytes32 evidenceHash, string evidenceURI
)
```

Fires on `flag`, when someone challenges a passport and posts a bond.

| Field | Meaning |
| --- | --- |
| `passportId` | The passport being challenged |
| `challenger` | Who opened the dispute |
| `bond` | The bond now held by the registry until the dispute is settled |
| `evidenceHash` | The keccak256 of the evidence URI, stored so the URI cannot be swapped |
| `evidenceURI` | Where the evidence lives |

### DisputeResolved

```solidity
event DisputeResolved(bytes32 indexed passportId, bool upheld, address indexed resolver)
```

Fires on `resolve`. `upheld` true means the challenge stood and the passport is now marked disputed
for good.

### Withdrawn and WithdrawnTo

```solidity
event Withdrawn(address indexed who, uint256 amount)
event WithdrawnTo(address indexed who, address indexed to, uint256 amount)
```

Fire when someone pulls what they are owed. `WithdrawnTo` also names where the money went. In both
the credit spent is `who`'s own, zeroed before the transfer.

### Rescued

```solidity
event Rescued(address indexed token, address indexed to, uint256 amount)
```

Fires on `rescueERC20` and `rescueNative`. `token` is the zero address for native token. It never
covers a bond or an unclaimed credit.

### Inherited

`Transfer`, `Approval` and `ApprovalForAll` from ERC-721. `Paused` and `Unpaused` from `Pausable`.
`OwnershipTransferStarted` and `OwnershipTransferred` from `Ownable2Step`. `EIP712DomainChanged`
from `EIP712`.

## VerifierPolicy

| Event | Fires when |
| --- | --- |
| `ChangeQueued(bytes32 indexed id, bytes32 indexed op, bytes data, uint64 executeAfter)` | A change is put in the queue and its 24 hour clock starts |
| `ChangeExecuted(bytes32 indexed id)` | A queued change runs, alongside the event for that specific change |
| `ChangeCancelled(bytes32 indexed id)` | A queued change is dropped before it runs |
| `ReceiverAdded(address indexed receiver)` | An address may now write attestations, from either `bootstrapAddReceiver` or an executed `queueAddReceiver` |
| `ReceiverRemoved(address indexed receiver)` | An address may no longer write attestations. No delay |
| `ResolverSet(address indexed resolver)` | The dispute resolver changed, and once in the constructor |
| `TreasurySet(address indexed treasury)` | The treasury changed, and once in the constructor |
| `DisputeBondSet(uint256 bond)` | The dispute bond changed, and once in the constructor |
| `BootstrapFinalized()` | The setup window closed. From here on every widening of trust waits 24 hours |

Plus `OwnershipTransferStarted` and `OwnershipTransferred`.

## MoolamReceiver

Every one of these is an owner action, and each emits so the change is visible on chain.

| Event | Fires when |
| --- | --- |
| `ForwarderAddressUpdated(address indexed previousForwarder, address indexed newForwarder)` | The forwarder allowed to call `onReport` is swapped |
| `ExpectedAuthorUpdated(address indexed previousAuthor, address indexed newAuthor)` | The pinned workflow author changes |
| `ExpectedWorkflowNameUpdated(bytes10 indexed previousName, bytes10 indexed newName)` | The pinned workflow name changes |
| `ExpectedWorkflowIdUpdated(bytes32 indexed previousId, bytes32 indexed newId)` | The pinned workflow id changes |
| `SecurityWarning(string message)` | Chainlink's template warns that a pin has been loosened |

Plus `OwnershipTransferred`.

A successful `onReport` emits nothing of its own. The `VerificationAttested` on the registry is the
record.

## What the indexer consumes

The Envio indexer subscribes to six registry events and two policy events:

- `MoolamRegistry`: `PasskeyBound`, `PassportRegistered`, `VerificationAttested`,
  `PassportFlagged`, `DisputeResolved`, `Transfer`
- `VerifierPolicy`: `ReceiverAdded`, `ReceiverRemoved`

`Transfer` is what keeps `Passport.owner` current on a sale while `Passport.creator` never moves.
