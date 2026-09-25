---
title: Prove it
---

# Prove it

`npm run prove` from the repo root is the one command that exercises the whole promise against
Monad mainnet and prints a table anyone can read. It takes about two minutes, spends about 0.4 MON,
and prints six sections, each ending in PASS or FAIL with a transaction hash or the exact refusal.

Every section also prints one line saying what it does not prove.

## What it checks

**1. Register.** Draws a picture nobody has registered before, signs a C2PA manifest into it, pins
four files to IPFS, has the creator's passkey and the generator agent sign the same digest, and
registers the passport on mainnet. Prints the token id and the explorer link.

**2. Survive.** Puts that image through six real journeys: re-encoded at quality 60, resized to a
quarter, rotated 90 degrees, mirrored, screenshotted, and passed through two rounds of social
resizing. Every copy goes through the verify service over HTTP. Prints the bit distance and the
confidence for each.

**3. Strip.** Removes every scrap of metadata, checks the C2PA manifest is really gone, and asks
again. This is the case the soft binding exists for.

**4. Forge.** Tries to register the same bytes again under a second creator, which the chain
refuses with `PassportAlreadyExists`. Then registers a re-encoded copy as a fresh original under
that second creator, which the chain cannot refuse, and shows the verify service naming both
records with the older one first. Moolam records who registered first, and says so.

**5. Attacks.** The twelve attacks in the [threat model](../security/threat-model), executed. Each
one writes its full output to `docs/security/attacks/<name>.txt` inside the docs site.

**6. Summary.** One table of the sections, one of the attacks, with the file each is saved in.

## The twelve attacks

| Attack | What refuses it |
| --- | --- |
| `passkey-replay` | `InvalidPasskeySignature` |
| `generator-signature-forged` | `InvalidGeneratorSignature` |
| `unknown-agent` | `UnknownAgent` |
| `expired-deadline` | `SignatureExpired` |
| `edit-by-non-owner` | `NotParentOwner` |
| `attest-from-stranger` | `NotReceiver` |
| `report-from-fake-forwarder` | `InvalidSender`, from Chainlink's own `ReceiverTemplate` |
| `receiver-replay-and-wrong-chain` | `StaleReport` and `WrongChain`, proved by Foundry tests because only Chainlink's forwarder can reach the check |
| `privy-policy-refusal` | Privy's enclave answers `policy_violation`. Nothing is signed, so nothing reaches Monad |
| `revoked-session-signer` | Privy refuses the key. The permission lives on Privy's side, not in Moolam's code |
| `dispute-money-rules` | `InvalidBond`, `NotResolver`, `NothingToWithdraw` |
| `verifier-api-limits` | 413, 400, 403, 429 |

Every on-chain attack runs twice. First as a read against the deployed contract, which is how the
exact custom error is decoded. Then as a real transaction with the same gas limit, so the refusal
is on Monad mainnet where anyone can open it in the explorer. Using the same gas limit for both is
what rules out a revert that is really an out-of-gas. If the read had gone through, the run would
say so and would not send the transaction.

## What a reader can check in one command each

None of these needs a clone, a key or any MON. They are `eth_call` against contracts anyone can
read, and every one was run on 2026-09-21 with its real output pasted in the page it comes from.

| Question | Command |
| --- | --- |
| What does this passport's holder allow AI to do today | `cast call 0x1151E69a82947920546e779c4C8c785b2a3C1277 "consentOf(bytes32)(bool,(uint64,address,(uint8,uint8,uint8,uint8),string))" <passportId> --rpc-url https://rpc.monad.xyz` |
| What was in force on a given day | the same with `"consentAt(bytes32,uint64)(...)"` and the unix second |
| How many times has the holder changed their mind | `cast call 0x1151E6... "historyLength(bytes32)(uint256)" <passportId> --rpc-url https://rpc.monad.xyz` |
| Which vocabulary is this | `cast call 0x1151E6... "STANDARD()(string)" --rpc-url https://rpc.monad.xyz` |
| Can a stranger write for a passport they do not hold | `cast call --from 0x000000000000000000000000000000000000dEaD 0x1151E6... "setConsent(bytes32,(uint8,uint8,uint8,uint8),string)" <passportId> '(2,2,2,2)' '' --rpc-url https://rpc.monad.xyz` |

The last one is a simulation, so it sends nothing and signs nothing, and it comes back
`NotPassportHolder` with the passport and the caller inside the error. The worked versions of all
five, with their output, are in [MoolamConsent](../api/consent). The eight refusals that make up the
consent register's part of the threat model are in
[consent-attacks.txt](../../proofs/consent-attacks.txt).

## Running it

```bash
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . .env; set +a
npm run prove
```

Run `npm run prove:privy` once first. It creates the Privy wallets, the second creator and its
passkey, which the forgery and two of the attacks use. The contracts must be compiled, so run
`forge build` in `packages/contracts` if `out/` is missing.

The run starts the verify service itself, the same way `npm run dev:verifier` does, on
`VERIFIER_PORT` (4010 by default) with `PASSPORT_SOURCE=json`, and stops it at the end. It refuses
to start if something is already listening on that port, so stop your own dev copy first. The
passport file it reads is written from what the chain says, never from what the run sent.

Needs in the root `.env`, all read automatically: `MONAD_MAINNET_RPC_URL`, `DEPLOYER_PRIVATE_KEY`,
`PROOF_P256_PRIVATE_KEY`, `PINATA_JWT`, `VERIFIER_PRIVATE_KEY`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`
and `PRIVY_AUTHORIZATION_KEY`.

## What a passing run looks like

The recorded run of 2026-09-08 registered passport
`0x0e940dfadb10c49bf1a2578cc12167242a9e2aec06500337f4889556379cda80` in block 103059393 for 376,128
gas, on chain 143 against registry `0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0`.

Section 2, the six copies:

```
  copy            bytes  matched as  phash    blockhash  confidence  resolves to the passport
  ------------  -------  ----------  -------  ---------  ----------  ------------------------
  reencode-q60   52,453  identity    0 of 64  0 of 256         0.99  yes
  resize-25       8,806  identity    1 of 64  0 of 256         0.94  yes
  rotate-90     221,822  rot90       0 of 64  0 of 256         0.99  yes
  mirror        228,608  mirror      0 of 64  0 of 256         0.99  yes
  screenshot     65,902  identity    1 of 64  0 of 256         0.94  yes
  social-chain   35,238  identity    6 of 64  0 of 256         0.67  yes
```

Section 6, the summary:

```
  section      result  evidence
  -----------  ------  ---------------------------------------------------------------
  1. Register  PASS    https://monadvision.com/tx/0xa791425b6a048864fe5fd803c70377e2...
  2. Survive   PASS    6 of 6 copies matched
  3. Strip     PASS    manifest gone, confidence 0.99
  4. Forge     PASS    PassportAlreadyExists, oldest passport is the first one
  5. Attacks   PASS    12 of 12 refused
```

And the last two lines, which are what to check:

```
PASS: the Moolam prove-it run, end to end, against Monad mainnet.
finished 2026-09-08T14:10:42.572Z, 128 seconds
```

That run cost 0.2745 MON from the creator's wallet and 0.0919 MON from the outsider's, about 0.37
MON in all at roughly 100 gwei. Ten of those transactions are meant to revert, and Monad charges
the declared gas limit whether a transaction succeeds or not.

## Where the outputs live

Every proof output sits in `proofs/` at the root of the repository. The folder is public and
committed, and each file is the output of the command beside it, so anyone can rerun the command and
diff the result. The twelve attack transcripts are the exception: they stay under
`docs/security/attacks/` because the [security pages](../security/audits) link to them as assets.

| File | What it holds | Command |
| --- | --- | --- |
| [prove-it.txt](../../proofs/prove-it.txt) | This run, all six sections, rewritten each time | `npm run prove` |
| [consent-contract.txt](../../proofs/consent-contract.txt) | The consent register's tests, coverage, invariant run, deploy dry run, fork tests and the live reads back | `forge test -n monad` in `packages/contracts` |
| [consent-statements.txt](../../proofs/consent-statements.txt) | The thirteen real pictures that carry a statement, with the transaction and the read back for each | `npm run consent:state -- --send` in `packages/agents` |
| [consent-attacks.txt](../../proofs/consent-attacks.txt) | Eight refusals from the live consent register, decoded, plus the control that passes | read only, `cast call`, run on 2026-09-21 |
| [rechecks.txt](../../proofs/rechecks.txt) | The Chainlink re-check on each of the nineteen real pictures, read back from the registry, with the receiver restored and read back | read only, written on 2026-09-14 |
| [attacks/pass-2.txt](../../proofs/attacks/pass-2.txt) | Eight attacks on the paths hardened after the review, run against a fork of Monad mainnet and the browser libraries | `npm run attack:pass2` in packages/agents |
| [perf.txt](../../proofs/perf.txt) | Lighthouse on every judge-facing page, what the JavaScript is made of, and the film measured frame by frame | `node packages/web/scripts/perf/lighthouse.mjs` |
| [privy.txt](../../proofs/privy.txt) | The Privy wallet features, live on Monad mainnet | `npm run prove:privy` |
| [seed.txt](../../proofs/seed.txt) | One real passport per run, appended so the history stays | `npm run seed` |
| [agent-transcript.txt](../../proofs/agent-transcript.txt) | Every generator agent run, tool call by tool call, appended | `npm run agent -- "..."` |
| [anvil-proof.txt](../../proofs/anvil-proof.txt) | Deploy, bind, three passports and an edit on a mainnet fork, with gas per step | `npm run proof:anvil` |
| [spike.txt](../../proofs/spike.txt) | The verifier spike: a manifest signed into a generated image, then every transform measured against it | `npm run spike:verifier` |
| [robustness.txt](../../proofs/robustness.txt) | 24 images through 15 transforms, 360 copies, what survives and what does not | `npm run robustness` |
| [reputation.txt](../../proofs/reputation.txt) | The live reads of the ERC-8004 Reputation Registry and the feedback posted to it | Saved from `npm run reputation:post` |
| [gas.txt](../../proofs/gas.txt) | The Foundry gas report, priced the way Monad prices it | `npm run gas` in `packages/contracts` |
| [fork-tests.txt](../../proofs/fork-tests.txt) | The five fork tests against real Monad mainnet state | `npm run test:fork` |
| [slither.txt](../../proofs/slither.txt) | Static analysis, with every finding triaged by hand underneath | `slither .` |
| [solhint.txt](../../proofs/solhint.txt) | Style: no errors, no warnings | `npm run lint` in `packages/contracts` |
| [deploy-dryrun.txt](../../proofs/deploy-dryrun.txt) | The mainnet deploy simulated with nothing broadcast | `forge script script/Deploy.s.sol` without `--broadcast` |
| [indexer-tests.txt](../../proofs/indexer-tests.txt) | Envio codegen and the nine handler tests, run in WSL | `npm run test:indexer` |

## What it does not prove

An attack nobody thought of. The list is the threat model, written by the people who built the
thing, and no third party has audited it. The two known holes are in the threat model rather than
here: a crop of more than a few percent breaks the fingerprints, and a passport proves who
registered first, not who created.
