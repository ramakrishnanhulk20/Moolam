# Moolam contracts

Three contracts. A permanent record of where an image came from, the small policy contract that
says who is allowed to check it, and the door a Chainlink workflow writes its answer through.

## What each contract does

**MoolamRegistry.** The passport book. A creator signs the image fingerprint with the passkey on
their own phone or laptop, and the AI agent that generated the image signs the same fingerprint
with the wallet that owns its ERC-8004 identity. Only when both signatures check out on chain does
the contract write the record and mint an ERC-721 whose token id is the image hash itself. It also
holds the edit history (every edit hangs off its parent), the verification results, and the dispute
bonds. It is immutable: there is no upgrade path, and the owner can pause and rescue stranded funds
but can never touch a passport or a user balance.

**VerifierPolicy.** The one moving part. It lists the addresses allowed to write verification
results, and holds the dispute resolver, the treasury and the bond size. Adding trust waits 24
hours in the open so anyone watching can react. Removing a receiver is immediate, because a
compromised verifier has to stop writing in the same block someone notices.

**MoolamReceiver.** Inherits Chainlink's own ReceiverTemplate, vendored word for word under
`src/vendor/chainlink/`. The Chainlink KeystoneForwarder is the only address it accepts a report
from. The report says which chain it was built for and the second the workflow ran, so a report
that is replayed, or delivered on a second chain, is refused instead of double counted. It then
calls `attest` on the registry, which checks the receiver against the policy list.

Why the passkey matters: the creator's signature is a real WebAuthn assertion, verified on chain
through OpenZeppelin's `WebAuthn` library, which uses Monad's P-256 precompile at `0x0100`. Both
user presence and user verification are required, so a passport can only be created by someone who
physically touched the device and passed its biometric or PIN. Take that away and the whole claim
collapses into self-reporting.

## Commands

Foundry lives at `~/.foundry/bin` on this machine and the secrets live in the repo root `.env`.
Start every session with these two lines in Git Bash, from `packages/contracts`:

```
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . ../../.env; set +a
```

Foundry needs `-n monad` on anything that touches Monad. Without it, `vm.createSelectFork` refuses
with "cannot create a monad fork with an EVM instantiated for ethereum", and the local EVM prices
gas as Ethereum rather than as the chain we ship on.

```
forge build                 compile, zero warnings
npm test                    109 tests: unit, fuzz, invariant and mainnet fork
npm run test:fork           the 5 fork tests only, against real Monad mainnet state
npm run gas                 the gas table saved in kitchen/reports/WO-1a-gas.txt
npm run abi                 regenerate the three ABIs in abi/
slither .                   static analysis, report in kitchen/reports/WO-1a-slither.txt
npm run lint                style, report in kitchen/reports/WO-1a-solhint.txt
```

## Going live on Monad mainnet

Chain 143. Every command below sends real MON, and every one of them declares its gas limit with
`--gas-estimate-multiplier 110`, because Monad bills the limit you declare rather than the gas you
use, so Foundry's default 130 would overpay by a fifth.

```
npm run deploy:mainnet      deploy the three contracts, list the receiver, close the bootstrap
npm run agent:register      register the demo generator agent on the ERC-8004 registry
npm run prove:live          the prove-it run: bind a passkey, write three passports
```

Each of those wraps one forge command, so nothing here is a manual step. The deploy is:

```
forge script script/Deploy.s.sol --rpc-url monad_mainnet -n monad --gas-estimate-multiplier 110 --slow --broadcast
forge script script/Deploy.s.sol --sig "record()" --rpc-url monad_mainnet -n monad
```

`deploy:mainnet` runs in two halves. The first sends the five transactions and writes
`deployments/monad-mainnet.json`; the second reads Foundry's own broadcast artifact and fills in the
transaction hashes, because a script cannot see hashes for transactions it has not sent yet.

### Verifying on the explorers

Sourcify, through MonadVision. This needs no API key and is the path we use:

```
forge verify-contract --chain-id 143 --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/ \
  <address> src/MoolamRegistry.sol:MoolamRegistry
```

`npm run verify:mainnet` runs that for all three contracts. Fill the three addresses first, from
the deployment file:

```
POLICY=$(node -p "require('./deployments/monad-mainnet.json').policy")
REGISTRY=$(node -p "require('./deployments/monad-mainnet.json').registry")
RECEIVER=$(node -p "require('./deployments/monad-mainnet.json').receiver")
```

Monadscan is Etherscan style and needs an API key nobody has created yet. Once `MONADSCAN_API_KEY`
is in `.env`, the same three contracts verify there with:

```
forge verify-contract --chain-id 143 --etherscan-api-key $MONADSCAN_API_KEY \
  <address> src/MoolamRegistry.sol:MoolamRegistry
```

### What a full mainnet run costs

Measured from the dry run in `kitchen/reports/WO-1b-dryrun.txt`, priced at Monad's 100 gwei
minimum base fee. These are gas limits, which is what Monad actually charges.

| Step | Gas declared | Cost |
| --- | --- | --- |
| Deploy VerifierPolicy | 1,268,218 | 0.127 MON |
| Deploy MoolamRegistry | 5,219,478 | 0.522 MON |
| Deploy MoolamReceiver | 1,045,886 | 0.105 MON |
| List the receiver and close the bootstrap | 47,647 | 0.005 MON |
| Register the demo agent on ERC-8004 | 411,369 | 0.041 MON |
| The live proof: bind, two passports, one edit | 1,483,570 | 0.148 MON |
| **Everything, once** | **9,476,168** | **0.948 MON** |

The deployer wallet needs roughly 1 MON of headroom on top of Monad's 10 MON reserve balance, which
every account has to keep and cannot spend.

## What the tests prove

109 tests across six files. 16 on the policy timelock, 71 on the registry covering every rule,
every custom error and every event, 11 on the Chainlink receiver path including the replay and
wrong chain refusals, 5 fuzz tests on the register and edit inputs and on the dispute money path,
an invariant suite that drove 8,192 random calls through six actors, and 5 fork tests against real
Monad mainnet state.

The six invariants all held: the contract balance always covers every liability, the bond total
always equals the sum of open disputes, every edit points at a parent that exists, no image id is
ever minted twice, attestations only ever come from an address the policy lists, and no passport
appears while the registry is paused.

The fork tests are the ones that matter most. They fork Monad mainnet, register a real agent on the
real ERC-8004 Identity Registry at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, and then show a
Generated passport landing when the agent's true owner signs, `UnknownAgent` when the agent id does
not exist, and `InvalidGeneratorSignature` when the signer does not own the agent. Delete the
ERC-8004 dependency and those three tests have nothing left to say.

Each test file opens with a note saying what it does not cover.

## What each action costs

Median gas from `npm run gas`, measured in Foundry's Monad network family so the pricing matches the
chain we ship on. Monad bills the gas limit rather than the gas used, so a wallet should set a tight
limit around these figures rather than a fat safety buffer.

| Action | Median gas | In plain English |
| --- | --- | --- |
| `bindPasskey` | 117,165 | One time per wallet. Proves the passkey belongs to the wallet before it can sign anything. |
| `register` | 254,407 | The main one. Checks a real WebAuthn signature and an agent signature, writes the record, and mints the token. |
| `appendEdit` | 299,900 | A little more than a register because it also links the child to its parent. No passkey prompt: holding the parent token is the authority. |
| `attest` | 126,113 | What the Chainlink workflow pays to record one verification result. |
| `flag` | 173,050 | Opening a dispute, including the bond going into escrow. |
| `withdraw` | 40,700 | Pulling money out. Deliberately cheap and deliberately a pull, so nobody can be blocked. |

The live proof on a fork of mainnet came in a little higher per call, at 382,173 gas for the first
register and 537,870 for the edit, because those passports carry a longer metadata URI and the first
touch of the ERC-8004 registry in a block pays the cold account cost.

Runtime size: registry 20,954 bytes, policy 4,597, receiver 3,855. The registry has 3,622 bytes of
headroom under the 24,576 byte contract size limit, and far more under Monad's 128 KB cap.

## Notes on choices

Solidity 0.8.30, `evm_version = "osaka"`, optimizer on at 200 runs, no via-IR. OpenZeppelin
contracts v5.6.1, pinned to that exact tag. The Chainlink `ReceiverTemplate` is copied verbatim
rather than rewritten so it can be diffed against Chainlink's published source; that is also why
Foundry's linter and solhint both skip `src/vendor/`.

Every passport must name the fingerprint algorithm that produced its perceptual hash: a zero
version is refused, because a record nobody can recompute later is not evidence of anything.

A passport whose challenge was upheld cannot be flagged a second time. The record already says
disputed, so a second bond would be burned for nothing. A passport whose challenge was rejected can
be flagged again with new evidence.

The attestation list per passport is capped at 64. The cap bounds storage growth and keeps a full
read comfortably inside one block.

There is no `receive` function. Native token only arrives as a dispute bond through `flag`, and
`rescueNative` can only move a surplus that is not backing a bond or an unclaimed credit.

`fs_permissions` in `foundry.toml` gives scripts read and write access to `deployments/` and nothing
else on the disk.
