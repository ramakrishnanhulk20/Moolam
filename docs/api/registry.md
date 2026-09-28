---
title: MoolamRegistry
---

# MoolamRegistry

`0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0` on Monad mainnet, chain 143. ERC-721
`Moolam Content Passport` (`MOOLAM`), EIP-712 domain name `Moolam`, version `1`. The ABI is in
`packages/contracts/abi/MoolamRegistry.json`.

The token id of a passport is `uint256(passportId)`, and `passportId` is the sha256 of the exact
image bytes.

## Types

```solidity
enum Kind { Generated, Captured, Edited }
enum DisputeStatus { None, Open, Upheld, Rejected }

struct PassportInput {
    bytes32 exactHash;
    bytes32 parentId;
    address creator;
    uint256 generatorAgentId;
    uint64  phash;
    bytes32 blockhash256;
    bytes32 manifestHash;
    Kind    kind;
    uint8   fingerprintVersion;
    string  metadataURI;
    uint64  deadline;
}

struct Passport {
    bytes32 exactHash;
    bytes32 parentId;
    address creator;
    uint256 generatorAgentId;
    uint64  phash;
    bytes32 blockhash256;
    bytes32 manifestHash;
    Kind    kind;
    uint8   fingerprintVersion;
    uint64  registeredAt;
    bool    disputed;
    string  metadataURI;
}

struct Attestation {
    address receiver;
    bool    matched;
    uint16  distance;
    bytes32 recomputed;
    uint64  at;
}

struct Dispute {
    address        challenger;
    uint256        bond;
    bytes32        evidenceHash;
    DisputeStatus  status;
    uint64         openedAt;
}
```

Every field of `PassportInput` is inside the EIP-712 digest, so a change to any field invalidates
both the passkey signature and the agent signature. `registeredAt` and `disputed` are set by the
contract and are not part of the signed input.

## Writes

### bindPasskey

```solidity
function bindPasskey(bytes32 qx, bytes32 qy, WebAuthn.WebAuthnAuth calldata auth) external
```

Binds a passkey to `msg.sender`, or rotates the one already bound.

| Parameter | Meaning |
| --- | --- |
| `qx` | Passkey public key x coordinate |
| `qy` | Passkey public key y coordinate |
| `auth` | WebAuthn assertion over `hashBind(msg.sender, qx, qy, bindNonce(msg.sender))` |

Preconditions: neither coordinate is zero, and the assertion verifies against the pair with user
presence and user verification both set. The wallet proves it holds the key by signing the bind
digest with it, so a stolen public key cannot be parked on someone else's wallet. Each successful
bind consumes one nonce.

| Reverts | When |
| --- | --- |
| `InvalidPublicKey` | `qx` or `qy` is zero |
| `InvalidPasskeySignature` | The assertion does not check out |

Emits `PasskeyBound`.

### register

```solidity
function register(
    PassportInput calldata p,
    WebAuthn.WebAuthnAuth calldata creatorAuth,
    bytes calldata generatorSig
) external returns (uint256 tokenId)
```

Registers an original image and mints its passport token to `p.creator`. Refused while paused.

Anyone may send this transaction. Authority comes from the two signatures, not from `msg.sender`,
which is what lets a relayer pay the gas for a creator.

| Parameter | Meaning |
| --- | --- |
| `p` | The passport input. `parentId` must be zero and `kind` must not be `Edited` |
| `creatorAuth` | The creator's WebAuthn assertion over `hashPassport(p)` |
| `generatorSig` | The agent owner's ECDSA signature over the same digest. Empty for a `Captured` image |

| Reverts | When |
| --- | --- |
| `EnforcedPause` | The registry is paused |
| `InvalidExactHash` | `p.exactHash` is zero |
| `PassportAlreadyExists` | That image hash already has a record |
| `ParentNotAllowed` | `p.parentId` is set |
| `InvalidCreator` | `p.creator` is the zero address |
| `InvalidKind` | `p.kind` is `Edited` |
| `InvalidFingerprintVersion` | `p.fingerprintVersion` is zero |
| `EmptyMetadataURI` | `p.metadataURI` is empty |
| `SignatureExpired` | `p.deadline` is in the past |
| `PasskeyNotBound` | `p.creator` has no passkey bound |
| `InvalidPasskeySignature` | The creator's assertion does not verify against the bound key |
| `InvalidAgentId` | `kind` is `Generated` and `generatorAgentId` is zero, or `kind` is not `Generated` and it is non-zero |
| `UnknownAgent` | The agent id does not exist on the ERC-8004 registry |
| `InvalidGeneratorSignature` | Recovery fails, the recovered address is not `ownerOf(agentId)`, or a signature was supplied for a non-`Generated` passport |

Emits `PassportRegistered` and the ERC-721 `Transfer`. Returns `uint256(p.exactHash)`.

### appendEdit

```solidity
function appendEdit(PassportInput calldata p, bytes calldata generatorSig)
    external returns (uint256 tokenId)
```

Records an edit of an existing passport and mints the child token. Refused while paused.

No passkey signature here. Holding the parent token is the authority, which is what lets an editing
session sign many edits without a fresh biometric prompt each time. An ERC-721 approval is not
enough: approval is permission to move the token, granted to marketplaces and escrows, and it must
never become permission to write history under the owner's name. A session signer works because it
acts from the owner's own wallet.

| Parameter | Meaning |
| --- | --- |
| `p` | The passport input with `parentId` set and `kind` set to `Edited` |
| `generatorSig` | The agent owner's ECDSA signature. Empty when `generatorAgentId` is zero |

| Reverts | When |
| --- | --- |
| `EnforcedPause` | The registry is paused |
| `InvalidParent` | `p.parentId` is zero |
| `ParentNotFound` | The parent has no record |
| `InvalidExactHash` | `p.exactHash` is zero |
| `PassportAlreadyExists` | That image hash already has a record |
| `InvalidKind` | `p.kind` is not `Edited` |
| `InvalidFingerprintVersion` | `p.fingerprintVersion` is zero |
| `EmptyMetadataURI` | `p.metadataURI` is empty |
| `SignatureExpired` | `p.deadline` is in the past |
| `NotParentOwner` | `msg.sender` does not own the parent token |
| `InvalidCreator` | `p.creator` is not the parent owner |
| `UnknownAgent` | A non-zero agent id does not exist on the ERC-8004 registry |
| `InvalidGeneratorSignature` | Recovery fails or the recovered address is not `ownerOf(agentId)` |

Emits `PassportRegistered` and the ERC-721 `Transfer`. The child is appended to the parent's
`getChildren` list. Returns `uint256(p.exactHash)`.

### attest

```solidity
function attest(bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed) external
```

Writes one verifier's recheck of a passport. Only an address `VerifierPolicy.isReceiver` returns
true for may call it, which in practice is the two `SimulationReceiver` contracts listed since
2026-09-27; before 2026-09-26 it was the `MoolamReceiver` pair. It stays open while the registry is
paused, so a verification already in flight can still land.

| Reverts | When |
| --- | --- |
| `NotReceiver` | The caller is not on the policy's receiver list |
| `PassportNotFound` | No record for that id |
| `AttestationCapReached` | The passport already holds `MAX_ATTESTATIONS` (64) |

Emits `VerificationAttested`.

### flag

```solidity
function flag(bytes32 passportId, string calldata evidenceURI) external payable
```

Opens a dispute against a passport, backed by a bond. Reentrancy guarded, and refused while paused.
The bond is held by the contract and never sent anywhere until `resolve` runs, so a flag costs the
challenger nothing but the gas if they turn out to be right. Only the keccak256 of `evidenceURI` is
stored, so the URI cannot be swapped.

| Reverts | When |
| --- | --- |
| `EnforcedPause` | The registry is paused |
| `PassportNotFound` | No record for that id |
| `DisputeAlreadyOpen` | A challenge is already open on that passport |
| `PassportAlreadyDisputed` | A previous challenge was upheld |
| `InvalidBond` | `msg.value` is not exactly `VerifierPolicy.disputeBond()` |

Emits `PassportFlagged`.

### resolve

```solidity
function resolve(bytes32 passportId, bool upheld) external
```

Settles an open dispute. Callable only by `VerifierPolicy.resolver()`. Reentrancy guarded.

`upheld` true marks the passport disputed and credits the bond back to the challenger. False
credits the bond to `VerifierPolicy.treasury()`. Credits are recorded, never pushed, so a resolver
can never be blocked by a challenger or treasury that refuses native token.

| Reverts | When |
| --- | --- |
| `NotResolver` | The caller is not the policy's resolver |
| `NoOpenDispute` | No open challenge on that passport |

Emits `DisputeResolved`.

### withdraw and withdrawTo

```solidity
function withdraw() external
function withdrawTo(address to) external
```

Pull whatever the caller is owed. The balance is zeroed before the transfer, both are reentrancy
guarded, and both stay open while paused so a pause can never trap someone's money.

`withdrawTo` is the escape hatch for a credited address that cannot hold native token itself, such
as a treasury contract with no payable path. Nobody can move anyone else's credit: the balance
spent is always the caller's own.

| Reverts | When |
| --- | --- |
| `ZeroAddress` | `to` is the zero address (`withdrawTo` only) |
| `NothingToWithdraw` | The caller's credit is zero |
| `TransferFailed` | The send failed |

Emits `Withdrawn` or `WithdrawnTo`.

### Owner-only

```solidity
function pause() external
function unpause() external
function rescueERC20(address token, address to, uint256 amount) external
function rescueNative(address to) external
```

`pause` stops new registrations, edits and flags. Attestations and withdrawals keep working.

`rescueERC20` moves ERC-20 tokens sent here by mistake. The contract never holds ERC-20 for a user,
so there is no user balance to touch. Reverts `ZeroAddress`.

`rescueNative` moves native token that is not backing a bond or an unclaimed credit. The amount is
`address(this).balance - totalBonds - totalOwed`, so an open bond and an unclaimed credit can never
be swept. Reverts `ZeroAddress`, `NothingToRescue`, `TransferFailed`.

All four emit their own events, and rescue emits `Rescued`.

Ownership uses `Ownable2Step`, so a transfer takes `transferOwnership` then `acceptOwnership` from
the new owner and a typo cannot lose the contract.

## Reads

| Function | Returns |
| --- | --- |
| `hashPassport(PassportInput p)` | The 32 byte EIP-712 digest to sign. This is also the WebAuthn challenge |
| `hashBind(address wallet, bytes32 qx, bytes32 qy, uint256 nonce)` | The 32 byte digest a passkey signs to bind itself |
| `bindNonce(address wallet)` | The nonce to use in the next `bindPasskey` call |
| `getPassport(bytes32 id)` | The whole `Passport` record. Zeroed if it does not exist |
| `passportExists(bytes32 id)` | True when a record exists |
| `getPasskey(address wallet)` | `(qx, qy)`, both zero when nothing is bound |
| `attestationCount(bytes32 id)` | How many attestations, never more than 64 |
| `getAttestations(bytes32 id, uint256 offset, uint256 limit)` | A page of `Attestation`, oldest first, clipped to what exists |
| `childCount(bytes32 id)` | How many edits descend directly from a passport |
| `getChildren(bytes32 id, uint256 offset, uint256 limit)` | A page of child passport ids, oldest first, clipped to what exists |
| `getDispute(bytes32 id)` | The `Dispute` record. Status `None` means never challenged |
| `withdrawable(address who)` | What that address can pull, in wei |
| `totalBonds()` | Native token locked behind open disputes |
| `totalOwed()` | Native token credited but not yet pulled |
| `policy()` | The `VerifierPolicy` address, immutable |
| `agentIdentity()` | The ERC-8004 Identity Registry address, immutable |
| `MAX_ATTESTATIONS()` | 64 |
| `tokenURI(uint256 tokenId)` | The metadata URI recorded at registration. Reverts `ERC721NonexistentToken` for an unminted id |

`getAttestations` and `getChildren` are read only, so the loop costs an off-chain caller nothing
and no on-chain function ever walks either array. An `offset` past the end returns an empty page
rather than reverting.

The rest of the ERC-721 surface (`ownerOf`, `balanceOf`, `approve`, `setApprovalForAll`,
`transferFrom`, `safeTransferFrom`, `getApproved`, `isApprovedForAll`, `name`, `symbol`,
`supportsInterface`) is OpenZeppelin's, unmodified.

## Constructor

```solidity
constructor(address initialOwner, address policyAddress, address agentIdentityAddress)
```

Reverts `ZeroAddress` if either address is zero, and `NotAContract` if the identity registry
address has no code. `ownerOf` is read through `try/catch`, and a call to an address with no code
would return empty data that cannot be decoded, so deployment against a plain wallet is refused up
front.
