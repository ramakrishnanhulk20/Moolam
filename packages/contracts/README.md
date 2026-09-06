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
from. It decodes the workflow's answer and calls `attest` on the registry, which then checks the
receiver against the policy list.

Why the passkey matters: the creator's signature is a real WebAuthn assertion, verified on chain
through OpenZeppelin's `WebAuthn` library, which uses Monad's P-256 precompile at `0x0100`. Both
user presence and user verification are required, so a passport can only be created by someone who
physically touched the device and passed its biometric or PIN. Take that away and the whole claim
collapses into self-reporting.

## Commands

```
forge build                 compile, zero warnings
forge test -vv              98 tests: unit, fuzz and invariant
forge test --gas-report     the gas table saved in kitchen/reports/WO-1a-gas.txt
slither .                   static analysis, report in kitchen/reports/WO-1a-slither.txt
npx --yes solhint@latest "src/**/*.sol"    style, report in kitchen/reports/WO-1a-solhint.txt
```

Foundry lives at `~/.foundry/bin` on this machine. Add it to PATH first:
`export PATH="$HOME/.foundry/bin:$PATH"`.

## What the tests prove

98 tests across five files. 16 on the policy timelock, 68 on the registry covering every rule,
every custom error and every event, 8 on the Chainlink receiver path, 5 fuzz tests on the register
and edit inputs and on the dispute money path, and an invariant suite that drove 8,192 random calls
through six actors and held all six invariants: the contract balance always covers every liability,
the bond total always equals the sum of open disputes, every edit points at a parent that exists,
no image id is ever minted twice, attestations only ever come from an address the policy lists, and
no passport appears while the registry is paused.

Each test file opens with a note saying what it does not cover.

## What each action costs

Median gas from `forge test --gas-report`, measured on Foundry's local EVM at the `osaka` EVM
version. Monad prices storage by 128 slot page rather than per slot, so the real numbers on Monad
will differ a little. Monad also bills the gas limit rather than the gas used, so a wallet should
set a tight limit around these figures rather than a fat safety buffer.

| Action | Median gas | In plain English |
| --- | --- | --- |
| `bindPasskey` | 110,578 | One time per wallet. Proves the passkey belongs to the wallet before it can sign anything. |
| `register` | 238,376 | The main one. Checks a real WebAuthn signature and an agent signature, writes the record, and mints the token. |
| `appendEdit` | 310,351 | Slightly more than a register because it also links the child to its parent. No passkey prompt: holding the parent token is the authority. |
| `attest` | 104,659 | What the Chainlink workflow pays to record one verification result. |
| `flag` | 149,739 | Opening a dispute, including the bond going into escrow. |
| `withdraw` | 28,713 | Pulling money out. Deliberately cheap and deliberately a pull, so nobody can be blocked. |

Deployment: the registry is about 3.05M gas and 20,790 bytes of runtime code, the policy about
939k gas, the receiver about 531k gas. The registry fits inside Ethereum's 24 KB limit and sits far
under Monad's 128 KB cap.

## Notes on choices

Solidity 0.8.30, `evm_version = "osaka"`, optimizer on at 200 runs, no via-IR. OpenZeppelin
contracts v5.6.1, pinned to that exact tag. The Chainlink `ReceiverTemplate` is copied verbatim
rather than rewritten so it can be diffed against Chainlink's published source; that is also why
Foundry's linter and solhint both skip `src/vendor/`.

The attestation list per passport is capped at 64. The cap bounds storage growth and keeps a full
read comfortably inside one block.

There is no `receive` function. Native token only arrives as a dispute bond through `flag`, and
`rescueNative` can only move a surplus that is not backing a bond or an unclaimed credit.
