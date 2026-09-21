---
title: Contracts
---

# Contracts

Four contracts on Monad mainnet: the permanent record, the small policy that says who may check it,
the door a Chainlink workflow writes its answer through, and the register where a creator states how
AI may use their picture. Solidity 0.8.30, OpenZeppelin
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

## MoolamConsent

`0x1151E69a82947920546e779c4C8c785b2a3C1277`, deployed in block 105828247. Where a passport's holder
states whether their picture may be used to train AI, and the record of every statement they have
made. Full reference in [MoolamConsent](../api/consent).

**Why it is its own contract.** The registry was already deployed and is immutable, so a new field
could not be added to it. That turned out to be the better shape anyway. A statement about AI use is
written by a different person at a different time than the registration, sometimes years later, and
it changes while the registration never does. Keeping them apart means the record of what a picture
is can never be touched by a statement about how it may be used, and a reader who wants one does not
have to parse the other. It is immutable too, with no owner, no pause, no upgrade path and no way to
send it money.

**How holder-only is enforced without trusting the caller.** The contract asks the registry
`ownerOf(uint256(passportId))` inside the same call and compares the answer with `msg.sender`. Both
sides of that comparison come from the same place at the same moment: the address the EVM says sent
the call, and the address the registry says holds the token right now. Nothing is cached, nothing is
parsed out of a string, and a transfer takes effect immediately. An ERC-721 approval or an operator
is refused: approval is permission to move a token, granted to marketplaces and escrows, and it must
never become permission to speak for the creator. A passport nobody minted makes `ownerOf` revert,
which is caught and returned as `NotPassportHolder` so a caller never has to read another contract's
error.

**Why a time query is a binary search.** The product's claim is "what was allowed on the day you
took it", so `consentAt(id, timestamp)` has to answer for any past second. The history is append
only and a write is refused unless its timestamp is strictly later than the one before it, which
means the list is sorted by construction and a binary search over it is exact rather than
approximate. The loop runs log2 of the history length times, so a passport with a thousand
statements costs ten steps. The same raw `uint64` orders an entry on the way in and finds it on the
way out, never a rounded or derived value, so the two can never drift apart.

**The write limits, and what they are for.** Moolam sponsors the fee on statements made through the
app, so a holder's writes are Moolam's bill. Three caps bound it. The same writer waits
`MIN_INTERVAL`, ten minutes, before changing the same passport again, and the wait follows the
writer rather than the passport so a seller cannot lock a buyer out by writing just before a sale.
The conditions text is capped at 256 bytes of printable ASCII, checked as one predicate over every
byte rather than a list of shapes to refuse. A batch is capped at 32 passports, because the loop
walks calldata the caller chose and needs a ceiling that is provably inside one transaction.

**Gas.** Measured in Foundry's Monad network family, so the pricing matches the chain this ships on.

| Action | Gas | Per picture |
| --- | --- | --- |
| A first statement for a passport | 117,337 | 117,337 |
| A later statement, no conditions text | 91,036 | 91,036 |
| A statement with 256 bytes of text | 326,489 | 326,489 |
| A batch of 32 first statements | 2,371,445 | 74,107 |
| A batch of 32 with 256 bytes of text | 8,144,656 | 254,520 |
| `consentAt` with 256 entries in the history | 35,539 | read, costs a caller nothing |

At the 102 gwei Monad was quoting when this was measured, one statement about one picture is about
0.014 MON all in. Stating one policy across 32 pictures in a single call is about 0.245 MON, roughly
half the price of saying the same thing 32 times. The worst batch is 8,144,656 gas, a bit over a
quarter of Monad's 30,000,000 gas per transaction limit, which is what sets `MAX_BATCH` at 32.

**Tests.** 60 of the suite's 182 are this contract: 45 unit, 8 fuzz at 512 runs each, an invariant
suite of six invariants over 256 runs and 8,192 calls, and 6 fork tests against live Monad mainnet
state. Coverage is 100 percent of lines, statements, branches and functions. The full pack, including
the invariant run and the three review questions, is in
[consent-contract.txt](../../proofs/consent-contract.txt).

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
npm test                    # 182 tests: unit, fuzz, invariant and mainnet fork
npm run test:fork           # the fork tests only, against real Monad mainnet state
npm run gas                 # the gas table
npm run abi                 # regenerate the four ABIs in abi/
slither .                   # static analysis
npm run lint                # solhint style check
```

## Going live

Chain 143. Every command below sends real MON, and every one declares its gas limit with
`--gas-estimate-multiplier 110`, because Monad bills the limit you declare rather than the gas you
use, so Foundry's default 130 would overpay by a fifth.

```bash
npm run deploy:mainnet      # deploy the first three, pin the receiver, close the bootstrap
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

`npm run verify:mainnet` runs that for all of them.

`MoolamConsent` went out on its own ten days later, from `script/DeployConsent.s.sol`, which reads the
registry address out of `deployments/monad-mainnet.json` rather than taking it typed, then asks that
address for its token symbol and gets `MOOLAM` back before it deploys anything. The dry run prints
the vocabulary and every cap the contract will carry for ever, so they are on the record before
anyone signs.

## What the tests prove

182 tests across eleven suites, run on 2026-09-21.

| File | Tests | What it covers |
| --- | --- | --- |
| `test/VerifierPolicy.t.sol` | 18 | The 24 hour timelock, the bootstrap window, immediate removal |
| `test/MoolamRegistry.t.sol` | 76 | Every rule, every custom error and every event |
| `test/MoolamReceiver.t.sol` | 16 | The Chainlink path, including the replay, wrong chain and wrong workflow identity refusals |
| `test/MoolamRegistry.fuzz.t.sol` | 5 | The register and edit inputs, and the dispute money path |
| `test/MoolamRegistry.invariants.t.sol` | 1 | 256 runs, 8,192 calls, 0 reverts |
| `test/MoolamConsent.t.sol` | 45 | Every rule of the consent register, every error and the batch |
| `test/MoolamConsent.fuzz.t.sol` | 8 | 512 runs each, including `consentAt` against a plain reference model |
| `test/MoolamConsent.invariants.t.sol` | 1 | Six more invariants, 256 runs and 8,192 calls, 0 reverts |
| `test/fork/MoolamConsent.fork.t.sol` | 6 | Real passports and real holders read off Monad mainnet |
| `test/fork/ERC8004Fork.t.sol` | 5 | Real Monad mainnet state and the real ERC-8004 registry |
| `test/RenounceOwnership.t.sol` | 1 | Ownership cannot be renounced into nobody's hands |

The eleven fork tests read the live chain, so they need `MONAD_MAINNET_RPC_URL` in the root `.env`.
Without it `forge test` runs 173 and skips the rest rather than failing, which is worth knowing
before quoting a count.

The registry's six invariants all held: the contract balance always covers every liability, the bond
total always equals the sum of open disputes, every edit points at a parent that exists, no image id
is ever minted twice, attestations only ever come from an address the policy lists, and no passport
appears while the registry is paused.

The consent register's six held too, with the single write and the batch competing for the same
three passports while those passports changed hands: an entry once written never changes, the
history only grows, the contract holds nothing, the latest entry is the one in force, the writer
held the passport, and timestamps strictly increase. The run is not vacuous, and it was proved the
hard way: temporarily asserting that no write had landed made the suite fail on the first call.

The fork tests matter most. They fork Monad mainnet, register a real agent on the real ERC-8004
Identity Registry at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, and show a Generated passport
landing when the agent's true owner signs, `UnknownAgent` when the agent id does not exist, and
`InvalidGeneratorSignature` when the signer does not own the agent. Delete the ERC-8004 dependency
and those three tests have nothing left to say.

The consent fork tests do the same against the passport registry: a real holder read off the chain
states a policy and it reads back, a stranger is refused for a real passport, a passport the live
registry has never minted is refused, and an address approved on the real registry inside the fork
is still refused, which is the whole point of reading `ownerOf` and never the approval. The batch
test needs one real wallet holding two real passports, so it reads both owners back on the fork
first and skips with a printed line if they have parted.

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

Runtime size: registry 20,954 bytes, policy 4,597, receiver 3,855, consent register 4,828, the last
read back off the chain with `cast code`. The registry has 3,622 bytes of headroom under the 24,576
byte contract size limit.
