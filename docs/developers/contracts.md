---
title: Contracts
---

# Contracts

Three contracts on Monad mainnet: the permanent record, the small policy that says who may check
it, and the door a Chainlink workflow writes its answer through. Solidity 0.8.30, OpenZeppelin
v5.6.1 pinned to that tag, `evm_version = "osaka"`, optimizer on at 200 runs, no via-IR.

## MoolamRegistry

The passport book. A creator signs the image fingerprint with the passkey on their own device, and
the AI agent that generated the image signs the same fingerprint with the wallet that owns its
ERC-8004 identity. Only when both signatures check out on chain does the contract write the record
and mint an ERC-721 whose token id is the image hash itself. It also holds the edit history, the
verification results, and the dispute bonds.

It is immutable. There is no upgrade path. The owner can pause and rescue stranded funds and can
never touch a passport or a user balance.

The rules that are easy to miss:

- Every passport must name the fingerprint algorithm that produced its perceptual hash. A zero
  `fingerprintVersion` is refused, because a record nobody can recompute later is not evidence of
  anything.
- The attestation list per passport is capped at 64. The cap bounds storage growth and keeps a full
  read comfortably inside one block.
- Only the owner of the parent token may call `appendEdit`. An ERC-721 approval or an operator
  approved for all is permission to trade the token, not permission to sign the next chapter of its
  history, so both are refused. A session signer works because it acts from the owner's own wallet.
- A passport whose challenge was upheld cannot be flagged a second time. One whose challenge was
  rejected can be flagged again with new evidence.
- Money owed is pulled, never pushed. `withdrawTo` lets the caller name where it goes, which
  matters when the credited address is a contract with no payable path. The credit spent is always
  the caller's own and is zeroed before anything is sent.
- There is no `receive` function. Native token only arrives as a dispute bond through `flag`, and
  `rescueNative` can only move a surplus that is not backing a bond or an unclaimed credit.

## VerifierPolicy

The one moving part. It lists the addresses allowed to write verification results, and holds the
dispute resolver, the treasury and the bond size. Adding trust waits 24 hours in the open so anyone
watching can react. Removing a receiver is immediate, because a compromised verifier has to stop
writing in the same block someone notices.

A candidate treasury with code is probed with an empty zero value call before it can be queued,
which catches the common mistake of pointing the treasury at a contract with no way to take native
token. That probe is a heuristic and nothing more. The registry's `withdrawTo` is the actual escape
hatch.

## MoolamReceiver

Inherits Chainlink's own `ReceiverTemplate`, vendored word for word under `src/vendor/chainlink/`
so it can be diffed against Chainlink's published source. Two things have to line up before it
writes anything: the call comes from the Chainlink KeystoneForwarder, and the report metadata
carries the workflow author and workflow name this receiver is pinned to. The deploy script pins
both in the same batch as the deploy, and `script/ConfigureReceiver.s.sol` can repin or unpin the
receiver later.

The report also says which chain it was built for and the second the workflow ran, so a report that
is replayed, or delivered on a second chain, is refused instead of double counted. It then calls
`attest` on the registry, which checks the receiver against the policy list.

## Commands

Foundry lives at `~/.foundry/bin` on this machine and the secrets live in the repo root `.env`.
Start every session with these two lines in Git Bash, from `packages/contracts`:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . ../../.env; set +a
```

Foundry needs `-n monad` on anything that touches Monad. Without it, `vm.createSelectFork` refuses
with "cannot create a monad fork with an EVM instantiated for ethereum", and the local EVM prices
gas as Ethereum rather than as the chain this ships on.

```bash
forge build                 # compile, zero warnings
npm test                    # 119 tests: unit, fuzz, invariant and mainnet fork
npm run test:fork           # the 5 fork tests only, against real Monad mainnet state
npm run gas                 # the gas table
npm run abi                 # regenerate the three ABIs in abi/
slither .                   # static analysis
npm run lint                # solhint style check
```

## Going live

Chain 143. Every command below sends real MON, and every one declares its gas limit with
`--gas-estimate-multiplier 110`, because Monad bills the limit you declare rather than the gas you
use, so Foundry's default 130 would overpay by a fifth.

```bash
npm run deploy:mainnet      # deploy the three contracts, pin the receiver, close the bootstrap
npm run agent:register      # register the demo generator agent on the ERC-8004 registry
npm run prove:live          # the live proof: bind a passkey, write three passports
```

`deploy:mainnet` runs in two halves. The first sends the seven transactions and writes
`deployments/monad-mainnet.json`; the second reads Foundry's own broadcast artifact and fills in
the transaction hashes, because a script cannot see hashes for transactions it has not sent yet.

Verification goes through Sourcify on MonadVision, which needs no API key:

```bash
forge verify-contract --chain-id 143 --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/ \
  <address> src/MoolamRegistry.sol:MoolamRegistry
```

`npm run verify:mainnet` runs that for all three.

## What the tests prove

119 tests across six files.

| File | Tests | What it covers |
| --- | --- | --- |
| `test/VerifierPolicy.t.sol` | 18 | The 24 hour timelock, the bootstrap window, immediate removal |
| `test/MoolamRegistry.t.sol` | 75 | Every rule, every custom error and every event |
| `test/MoolamReceiver.t.sol` | 15 | The Chainlink path, including the replay, wrong chain and wrong workflow identity refusals |
| `test/MoolamRegistry.fuzz.t.sol` | 5 | The register and edit inputs, and the dispute money path |
| `test/MoolamRegistry.invariants.t.sol` | 1 | 256 runs, 8,192 calls, 0 reverts |
| `test/fork/ERC8004Fork.t.sol` | 5 | Real Monad mainnet state and the real ERC-8004 registry |

The six invariants all held: the contract balance always covers every liability, the bond total
always equals the sum of open disputes, every edit points at a parent that exists, no image id is
ever minted twice, attestations only ever come from an address the policy lists, and no passport
appears while the registry is paused.

The fork tests matter most. They fork Monad mainnet, register a real agent on the real ERC-8004
Identity Registry at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, and show a Generated passport
landing when the agent's true owner signs, `UnknownAgent` when the agent id does not exist, and
`InvalidGeneratorSignature` when the signer does not own the agent. Delete the ERC-8004 dependency
and those three tests have nothing left to say.

Each test file opens with a note saying what it does not cover.

## What each action costs

Median gas from `npm run gas`, measured in Foundry's Monad network family so the pricing matches
the chain this ships on.

| Action | Median gas | In plain English |
| --- | --- | --- |
| `bindPasskey` | 117,165 | One time per wallet. Proves the passkey belongs to the wallet before it can sign anything. |
| `register` | 254,429 | Checks a real WebAuthn signature and an agent signature, writes the record, mints the token. |
| `appendEdit` | 299,849 | A little more than a register because it also links the child to its parent. |
| `attest` | 126,113 | What the Chainlink workflow pays to record one verification result. |
| `flag` | 172,939 | Opening a dispute, including the bond going into escrow. |
| `withdraw` | 40,717 | Pulling money out. Deliberately cheap and deliberately a pull. |
| `withdrawTo` | 41,226 | The same pull, sent to an address the caller names. |

Runtime size: registry 20,954 bytes, policy 4,597, receiver 3,855. The registry has 3,622 bytes of
headroom under the 24,576 byte contract size limit.
