---
title: VerifierPolicy and MoolamReceiver
---

# VerifierPolicy and MoolamReceiver

The contracts around the registry: the one that says who may attest, and the receivers a Chainlink
workflow writes through. Since 2026-09-27 those are two `SimulationReceiver` contracts, one per
workflow. `MoolamReceiver`, below, is the contract they replaced, and its verdicts stay on chain.

## VerifierPolicy

`0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821` on Monad mainnet. ABI in
`packages/contracts/abi/VerifierPolicy.json`.

The only mutable piece of Moolam. It holds the list of addresses allowed to write attestations, the
dispute resolver, the treasury and the bond size. Every change that widens trust waits 24 hours in
the open. Removing a receiver is immediate.

### Constants

| Constant | Value |
| --- | --- |
| `CHANGE_DELAY()` | `24 hours` |
| `OP_ADD_RECEIVER()` | `keccak256("ADD_RECEIVER")` |
| `OP_SET_RESOLVER()` | `keccak256("SET_RESOLVER")` |
| `OP_SET_TREASURY()` | `keccak256("SET_TREASURY")` |
| `OP_SET_DISPUTE_BOND()` | `keccak256("SET_DISPUTE_BOND")` |

### Reads

| Function | Returns |
| --- | --- |
| `isReceiver(address who)` | True when that address may call `attest` on the registry |
| `resolver()` | The address allowed to settle disputes |
| `treasury()` | Where a rejected challenger's bond goes |
| `disputeBond()` | The exact bond a `flag` must carry, in wei |
| `bootstrapped()` | False until the setup window is closed. Once true it can never go back |
| `getPendingChange(bytes32 id)` | The queued change. A zero `executeAfter` means nothing is queued under that id |

### The setup window

```solidity
function bootstrapAddReceiver(address who) external   // onlyOwner
function finalizeBootstrap() external                 // onlyOwner
```

`bootstrapAddReceiver` lists a receiver at once, during the setup window only. `finalizeBootstrap`
closes that window for good. The deploy script does both in the same batch as the deploy.

| Reverts | When |
| --- | --- |
| `BootstrapClosed` | The window is already closed |
| `ZeroAddress` | `who` is the zero address |
| `AlreadyReceiver` | The address is already listed |

Emits `ReceiverAdded` and `BootstrapFinalized`.

### Removing a receiver

```solidity
function removeReceiver(address who) external   // onlyOwner
```

No delay. A compromised verifier has to stop writing in the same block the owner notices. Reverts
`NotAReceiver` when the address is not listed. Emits `ReceiverRemoved`.

### The 24 hour queue

```solidity
function queueAddReceiver(address who)      external returns (bytes32 id)   // onlyOwner
function queueSetResolver(address who)      external returns (bytes32 id)   // onlyOwner
function queueSetTreasury(address who)      external returns (bytes32 id)   // onlyOwner
function queueSetDisputeBond(uint256 bond)  external returns (bytes32 id)   // onlyOwner
function execute(bytes32 id)                external                        // onlyOwner
function cancel(bytes32 id)                 external                        // onlyOwner
```

The change id is `keccak256(abi.encode(op, data))`, so the same change cannot be queued twice.

`queueSetTreasury` probes a candidate that has code with an empty zero value call before it can be
queued, which catches the common mistake of pointing the treasury at a contract with no way to take
native token at all. It is a heuristic and nothing more: a contract can pass this probe and still
refuse a real payout. The registry's `withdrawTo` is the actual escape hatch.

| Reverts | When |
| --- | --- |
| `ZeroAddress` | An address argument is zero |
| `AlreadyReceiver` | `queueAddReceiver` on an address already listed |
| `TreasuryCannotReceive` | The treasury probe failed |
| `ChangeAlreadyQueued` | That exact change is already in the queue |
| `UnknownChange` | `execute` or `cancel` on an id with nothing queued |
| `ChangeNotReady` | `execute` before `executeAfter` |

Each `queue*` call emits `ChangeQueued`. `execute` emits `ChangeExecuted` plus the event for the
specific change (`ReceiverAdded`, `ResolverSet`, `TreasurySet` or `DisputeBondSet`). `cancel` emits
`ChangeCancelled`.

Ownership uses `Ownable2Step`.

## MoolamReceiver

`0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04` on Monad mainnet (retired 2026-09-26). ABI in
`packages/contracts/abi/MoolamReceiver.json`.

The door a Chainlink CRE workflow used to write a verification result into the registry until
2026-09-26, when it and its sealed twin `0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A` came off the
policy. Every attestation they wrote stays on chain under their addresses. It inherits Chainlink's
`ReceiverTemplate` unchanged, so the forwarder check and the workflow identity checks are
Chainlink's, not Moolam's.

Since 2026-09-27 14:18 UTC the policy lists two `SimulationReceiver` contracts instead:
`0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95` for `moolam-verifier`, listed in transaction
`0xac642cc5c89290a2659e0ee7aaa78d7b729643f22138725815590dd2abbc0bfb`, and
`0x52b8fE549B432920eeB061c26cAc5c2D527657f6` for `moolam-sealed-verifier`, listed in transaction
`0x0e1e2937ee4593cb8aad78d4bb6696b14584080b216d4c3c028f0c32eecf457d`. They take the same
`onReport` call and payload as below, from Chainlink's MockKeystoneForwarder, and add one lock in
front of the payload checks: the transaction must be signed by Moolam's CRE wallet
`0xC79620AF233a4434b03f6B57239F8A9E71B3C178`, or it reverts `WrongSendingWallet`. A report more
than an hour ahead of the block reverts `ReportFromTheFuture`. The full account is in
[Chainlink CRE workflow](../developers/chainlink-workflow), "The receiver, and what a simulation
needs". ABI in `packages/contracts/abi/SimulationReceiver.json`.

### onReport

```solidity
function onReport(bytes calldata metadata, bytes calldata report) external
```

Called by the Chainlink KeystoneForwarder. Three locks run before anything is written, the first
two from the template:

1. `msg.sender` must be the configured forwarder, or it reverts `InvalidSender`.
2. The report metadata must carry the workflow author and workflow name this receiver is pinned to,
   or it reverts `InvalidAuthor`, `InvalidWorkflowName` or `InvalidWorkflowId`.
3. The decoded payload must be for this chain and newer than the last report for that passport.

The payload is:

```solidity
abi.decode(report, (uint256 chainId, uint64 executedAt, bytes32 passportId,
                    bool matched, uint16 distance, bytes32 recomputed))
```

`chainId` and `executedAt` are inside the signed payload because Chainlink's own consumer guidance
says a report whose first transmission reverted can be sent again, and the same signed report can
be delivered on another chain. Both are checked before anything is written, which turns a replay
into a revert instead of a duplicate attestation.

| Reverts | When |
| --- | --- |
| `InvalidSender` | The caller is not the configured forwarder |
| `InvalidAuthor` | The report author is not the pinned one |
| `InvalidWorkflowName` | The workflow name is not the pinned one |
| `InvalidWorkflowId` | The workflow id is not the pinned one |
| `WrongChain` | `chainId` is not `block.chainid` |
| `StaleReport` | `executedAt` is not newer than the last one recorded for that passport |
| Whatever the registry refuses | `NotReceiver`, `PassportNotFound`, `AttestationCapReached` |

On success it calls `attest` on the registry, which emits `VerificationAttested`.

### Reads

| Function | Returns |
| --- | --- |
| `REGISTRY()` | The registry this receiver writes into, immutable |
| `lastExecutedAt(bytes32 passportId)` | The `executedAt` of the newest report accepted for that passport, zero when none has landed |
| `getForwarderAddress()` | The forwarder allowed to call `onReport` |
| `getExpectedAuthor()` | The pinned workflow author |
| `getExpectedWorkflowName()` | The pinned workflow name, `bytes10` |
| `getExpectedWorkflowId()` | The pinned workflow id |

### Owner-only

```solidity
function setForwarderAddress(address _forwarder) external
function setExpectedAuthor(address _author) external
function setExpectedWorkflowName(string calldata _name) external
function setExpectedWorkflowId(bytes32 _id) external
```

Chainlink's template setters. The workflow author and name are not set in the constructor because
the template stores them through these owner-only setters, so the deploy script pins them in the
same transaction batch and `script/ConfigureReceiver.s.sol` can repin later. Each one emits an
event: `ForwarderAddressUpdated`, `ExpectedAuthorUpdated`, `ExpectedWorkflowNameUpdated`,
`ExpectedWorkflowIdUpdated`.

None of the four setters checks its argument; each reverts only `OwnableUnauthorizedAccount` for a
caller who is not the owner. A workflow name pinned without an author is accepted by the setter and
makes every later `onReport` revert `WorkflowNameRequiresAuthorValidation`. A zero forwarder is
accepted too, with a `SecurityWarning` event, and turns the forwarder check off.
`InvalidForwarderAddress` is raised only by the constructor.

The `VerifierPolicy` list is a separate control. It decides which receivers the registry will
listen to at all, and it is not a second lock on this door.
