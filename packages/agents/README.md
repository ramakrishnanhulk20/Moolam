# Moolam agents

The TypeScript client every other piece of Moolam talks to the chain through: the generator agent,
the prove-it command, and the app. One place builds the digests, one place signs, one place sends
the transactions, so the app and the agent can never drift apart on what a passport commits to.

## What is in here

**`src/chain/eip712.ts`** builds the two digests the registry checks. `passportDigest` is the 32
bytes a creator's passkey and the generator agent both sign, and it is also the WebAuthn challenge.
`bindDigest` is what a passkey signs to attach itself to a wallet. The field order in
`PASSPORT_TYPES` is copied from `PASSPORT_TYPEHASH` in `MoolamRegistry.sol`; change the order and
every signature stops verifying, which is why the test suite compares both digests against the
contract's own `hashPassport` and `hashBind` for three different inputs.

**`src/chain/passkey.ts`** is `SoftwarePasskey`, a P-256 key that signs the way a device passkey
does. See the honest caveat below.

**`src/chain/registry.ts`** is `RegistryClient`: read the bind nonce, bind a passkey, sign as a
generator, register, append an edit, read a passport, mint an agent identity on the ERC-8004
registry, and turn a revert into the custom error name the contract raised.

**`src/chain/addresses.ts`** reads the deployed addresses from
`packages/contracts/deployments/monad-mainnet.json` and fails with the deploy command when that
file is not there yet.

**`src/ipfs/pinata.ts`** pins bytes and JSON to public IPFS through Pinata's v3 files endpoint at
`https://uploads.pinata.cloud/v3/files`, which their docs mark as the current upload API; the older
`pinFileToIPFS` route is kept only for folder uploads, which we do not do. It reads `PINATA_JWT`
from the root `.env` and checks it at import, so a run fails before it spends gas rather than after.

**`src/media/prepare.ts`** turns a raw picture into everything a passport needs: the C2PA signed
JPEG, the fingerprint of those signed bytes, the sha256 of the manifest store the chain commits to,
and a small thumbnail. It refuses to continue if signing moved the perceptual hash, because a
manifest that describes different pixels than the registered ones is worse than no manifest.

**`src/seed/registerSeed.ts`** puts one passport on Monad mainnet: prepare, pin the four files,
build the passport input, sign it with the creator's passkey and with the agent owner's wallet,
then register. Everything is pinned before the transaction is sent, so a failed upload costs no gas.

**`src/privy/`** is the Privy side: `client.ts` builds the client and the authorization context
from the root `.env`, `policies.ts` writes the rulebooks Privy's enclave enforces, `serverWallet.ts`
creates and reuses the wallets and sends transactions from them, `generatorSigner.ts` gets the
agent's EIP-712 signature out of the enclave, and `sessionSigner.ts` grants, uses and revokes the
standing permission a creator gives the app.

**`src/chain/anvil.ts`** starts a local anvil forked from Monad mainnet and deploys the three
contracts onto it. Tests and the local proof only. It repeats what `script/Deploy.s.sol` does
rather than running it, because that script writes the mainnet deployment file and would overwrite
the record of the real deploy.

## How the software passkey differs from a real one

Byte for byte, the assertion is the same. The authenticator data is 37 bytes with user presence and
user verification set, the client data JSON says `"type":"webauthn.get"` and carries the digest
base64url encoded as the challenge, the signature is P-256 over
`sha256(authenticatorData || sha256(clientDataJSON))`, and `s` is normalised into the lower half of
the curve order because OpenZeppelin's `P256` library rejects the upper half. The contract cannot
tell the two apart, and it should not be able to: that is what makes this client testable.

What is different is everything around the key. A real passkey lives in a secure enclave or a
security key, it never leaves the device, and the user verification flag means a human actually
touched the sensor and passed a biometric or a PIN. Here the key sits in process memory and nobody
touched anything. So: use `SoftwarePasskey` for agents, tests and scripts. A human creator's key
must come from their own device through the browser's WebAuthn API, never from this class.

## Commands

From the repo root, with Foundry on the path and the root `.env` loaded:

```
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . .env; set +a
```

```
npm run test:agents     16 tests: the digests against the contract, the whole write path on a
                        fork of Monad mainnet, and six refusals decoded to their error names
npm run proof:anvil     deploy, bind, three passports and an edit on a fork, with gas per step
npm run seed            one real passport on Monad mainnet, files pinned to IPFS. Spends MON.
npm run prove:privy     the four Privy features, live on Monad mainnet. Spends MON.
npm run prove           the prove-it run: one image, six mangled copies, a stripped copy, a
                        forgery and twelve attacks, live on Monad mainnet. Spends about 0.4 MON.
npm run agent -- "..."  the demo agent: draws a picture, signs it, pins it, registers its
                        passport on Monad mainnet. Spends MON and a cent or two of OpenAI credit.
npm run agent -- --verify path/to/file.jpg
                        the same agent answering "who made this?" for any copy of an image.
```

Both need `MONAD_MAINNET_RPC_URL` in the root `.env` and `anvil` on the path. Neither spends MON:
they fork Monad mainnet locally, so the ERC-8004 Identity Registry at
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` is the real contract with real state, while the
balances are anvil's play money. The contracts are compiled by Foundry, so run `forge build` in
`packages/contracts` first if `out/` is missing.

## The prove-it run

`npm run prove` from the repo root is the one command that exercises the whole promise against
Monad mainnet and prints a table anyone can read. It takes about two minutes and prints six
sections, each ending in PASS or FAIL with a transaction hash or the exact refusal.

1. **Register.** Draws a picture nobody has registered before, signs a C2PA manifest into it, pins
   four files to IPFS, has the creator's passkey and the generator agent sign the same digest, and
   registers the passport on mainnet. Prints the token id and the explorer link.
2. **Survive.** Puts that image through six real journeys: re-encoded at quality 60, resized to a
   quarter, rotated 90 degrees, mirrored, screenshotted, and passed through two rounds of social
   resizing. Every copy goes through the verify service over HTTP. Prints the bit distance and the
   confidence for each.
3. **Strip.** Removes every scrap of metadata, checks the C2PA manifest is really gone, and asks
   again. This is the case the soft binding exists for.
4. **Forge.** Tries to register the same bytes again under a second creator, which the chain
   refuses with PassportAlreadyExists. Then registers a re-encoded copy as a fresh original under
   that second creator, which the chain cannot refuse, and shows the verify service naming both
   records with the older one first. Moolam records who registered first, and says so.
5. **Attacks.** The twelve attacks in `docs/security/threat-model.md`, executed. Each one
   writes its full output to `docs/security/attacks/<name>.txt`.
6. **Summary.** One table of the sections, one of the attacks, with the file each is saved in.

Every section also prints one line saying what it does not prove.

The run starts the verify service itself, the same way `npm run dev:verifier` does, on
`VERIFIER_PORT` (4010 by default) with `PASSPORT_SOURCE=json`, and stops it at the end. It refuses
to start if something is already listening on that port, so stop your own dev copy first. The
passport file it reads is written from what the chain says, never from what the run sent, and it
lives in the gitignored `.moolam/prove-passports.json`.

Needs in the root `.env`, all read automatically:

| variable | why |
| --- | --- |
| `MONAD_MAINNET_RPC_URL` | where every read and transaction goes |
| `DEPLOYER_PRIVATE_KEY` | the creator's wallet: it owns the demo ERC-8004 agent and pays the gas |
| `PROOF_P256_PRIVATE_KEY` | that creator's passkey, the P-256 key the WebAuthn assertion is made with |
| `PINATA_JWT` | pinning the image, the thumbnail, the manifest and the metadata to IPFS |
| `VERIFIER_PRIVATE_KEY` | the outsider wallet the attacks are sent from. It holds no role in Moolam |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` | the two attacks that Privy's enclave refuses, and the second creator's wallet in the forgery |

Run `npm run prove:privy` once before the first prove run: it creates the Privy wallets, the second
creator and its passkey, which the forgery and two of the attacks use. The contracts must be
compiled, so run `forge build` in `packages/contracts` if `out/` is missing.

The last run cost 0.2745 MON from the creator's wallet and 0.0919 MON from the outsider's, so about
0.37 MON in all, at roughly 100 gwei. Ten of those transactions are meant to revert, and Monad
charges the gas limit that was declared whether a transaction succeeds or not. The full transcript
is saved to `proofs/prove-it.txt`.

## Seeding a passport

`npm run seed` from the repo root is the script that gives judges something to look at. Each run
draws a fresh 1024 by 768 picture from its own seed number, so no two runs register the same image,
and then does the whole flow end to end on Monad mainnet:

1. Reads the addresses and the demo agent id from `packages/contracts/deployments/monad-mainnet.json`.
2. Uses the deployer wallet as both the creator and the generator, because that wallet owns agent
   10248 on the ERC-8004 registry. The creator key is `PROOF_P256_PRIVATE_KEY` from the root `.env`,
   loaded as a `SoftwarePasskey`. If the wallet has no passkey bound on the live registry, or a
   different one, the script binds it first and prints that transaction.
3. Signs a C2PA manifest into the picture carrying the soft binding, which is the 64 bit perceptual
   hash and the 256 bit blockhash of the same pixels.
4. Pins four files to IPFS: the signed image, the thumbnail, a readable copy of the manifest, and
   the metadata JSON that points at the other three.
5. Registers a Generated passport, co-signed by the agent owner, and prints the passport id, the
   transaction with its MonadVision link, and the gas.
6. Fetches the thumbnail back through the public gateway and fingerprints it, to prove the file the
   Chainlink verifier will download really matches the fingerprint on chain.

The output of every run is appended to `proofs/seed.txt`. The run counter lives in
`packages/agents/.moolam/seed-state.json`, which is gitignored, so deleting it starts the numbering
over and draws the same pictures again.

The thumbnail is a baseline JPEG, longest side 512 pixels, and the script drops the quality until
the file is under 60,000 bytes. Two constraints set that: the Chainlink workflow fetches through
`https://gateway.pinata.cloud/ipfs/` with a 100 KB cap, and it decodes with jpeg-js, which reads
baseline files only. A progressive thumbnail would fail every verification.

Needs in the root `.env`: `MONAD_MAINNET_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `PROOF_P256_PRIVATE_KEY`
and `PINATA_JWT`. The two mainnet runs recorded in the report cost 376,178 and 376,166 gas, about
0.0384 MON each at the price of the day, because Monad bills the gas limit rather than the gas used.

## Proving the Privy side

`npm run prove:privy` from the repo root runs the four Privy features that Moolam is built on,
against Monad mainnet, and prints a transaction hash or the exact refusal for every one. The output
is saved to `proofs/privy.txt`.

**Server wallets with a policy.** The generator agent's key lives in Privy's secure enclave, not on
our server. Its policy allows exactly two things: send a `register` call to the Moolam registry on
chain 143 carrying no MON, and sign an EIP-712 message whose domain is that same registry. Privy
denies any method or destination no rule names, so the agent cannot move funds, cannot call another
contract, and cannot sign for another app even if this machine is taken over.

**The agent's signature comes out of the enclave.** `register` only writes a Generated passport if
the owner of the ERC-8004 agent signed the same digest the creator's passkey signed. That signature
is produced by Privy typed data signing, and the script recovers the address from it locally before
spending gas, so the run fails on this machine rather than on chain if the two ever disagree.

**Session signers.** The creator owns their wallet. They grant the app a separate key, registered
with Privy as a one of one key quorum, permission to sign on that wallet, scoped by a second policy
that allows `appendEdit` and nothing else. That is what lets an editing session write ten edits
without ten passkey prompts. When the permission is taken back, the same call from the same key is
refused by Privy before it can reach Monad.

**Gas sponsorship.** The creator's first transaction is attempted with `sponsor: true`. With
sponsorship configured for Monad in the dashboard, under Wallet Infrastructure, App pays, Privy
submits it through its own relayer and answers with a transaction id, sometimes before it has a
hash to give. The client waits on that id until Privy reports the hash, rather than handing back an
empty string that a receipt wait would sit on until it timed out.

Only an HTTP 4xx from Privy, sent before anything was submitted, counts as a refusal: a policy
violation, or sponsorship that is not configured. Then the refusal text is printed and the wallet
pays instead. A wait that ran out is not a refusal, because that send may still be on its way. In
that case the script re-reads the creator's bind nonce on the registry, which only moves when a
bind succeeded. If it moved, the sponsored bind is already written, so the script finds that
transaction through Privy or through the registry's `PasskeyBound` logs and reports it. If it did
not move, the run stops and names the Privy transaction to look up. It never sends a second bind on
top of one that may have landed, because the first one consumed the nonce the second was signed
for. Line 2 of `proofs/privy.txt` says which of these happened on the last run, and nothing in the
output claims a sponsored transaction that did not happen.

What a judge sees, in the order the script prints it:

1. The generator's wallet address, its policy id, and the ERC-8004 agent id it owns.
2. The creator's wallet and the passkey bind transaction: sponsored, with the user operation
   Privy routed it through when it came back with one, or not sponsored with Privy's own words.
3. A passport registered by the generator wallet under that policy, with the token id.
4. The same wallet refused when it tries to send MON: `policy_violation`, no transaction.
5. The same wallet refused when it tries `appendEdit`: same contract, wrong function.
6. An edit written on the creator's wallet by the app's session signer, co-signed by the agent.
7. The permission revoked, and the same call refused with Privy's own error text.

Two honest notes. There is no browser in this proof, so the creator's wallet is a Privy server
wallet standing in for the embedded wallet a user would get on login, and the session signer is
granted through `wallets().update` with `additional_signers`, which is the server side of what the
React SDK calls `addSigners`. And the generator mints its ERC-8004 identity before its policy goes
on, because the policy forbids calls to any other contract; a rerun skips that step and the wallet
stays locked down.

The wallet ids, the policy ids and the agent id are cached in `packages/agents/.moolam/wallets.json`
so a second run reuses everything and only sends the three transactions. The app's session key and
the creator's passkey key live next to it in the same gitignored folder and are never printed.

Needs in the root `.env`: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`,
`MONAD_MAINNET_RPC_URL`, `DEPLOYER_PRIVATE_KEY` and `PINATA_JWT`. The first run funds the two
Privy wallets with 12 MON each from the deployer, because Monad reserves 10 MON per account and a
wallet below that cannot pay for anything.

Gas, in plain English. On the last recorded run, binding the passkey cost 0.0072 MON, registering
a passport 0.0434 MON and appending an edit 0.0492 MON, all at 102 gwei, and the script prints the
limit, the price and the MON for each one at the end. Monad bills the gas limit that was declared
rather than the gas that was used, which is why the limit is what those numbers are worked out
from. When sponsorship is on, the app pays for the creator's bind and the creator's own MON is
untouched; the generator's `register` and the session signer's `appendEdit` are always paid by the
wallet that sends them.

The quorum the `/edit` route needs is a different one, and `npm run edit:quorum` from this package
is what makes it. The route signs with `PRIVY_AUTHORIZATION_KEY`, so what a creator grants on their
wallet has to be the key quorum whose single member is the public half of that key, not the session
key the proof above uses. The script finds that quorum or creates it under the name
`moolam-edit-signer`, prints the id, and writes it into the root `.env` as `PRIVY_EDIT_SIGNER_ID`.
Run it twice and the second run prints the same id: Privy has no call that lists key quorums, so
the id in `.env` is how a later run finds it, and the members are read back from Privy before that
id is trusted. Adding `-- --grant-proof-wallet` grants the quorum on the proof creator wallet with
the edit policy, asks Privy for one signature, checks it recovers to that wallet, and takes the
grant away again. It sends no transaction and spends no MON. The proof wallet is a server wallet
these scripts own while a real creator's is an embedded wallet granted from the browser with
`addSigners`, and the same quorum id serves both.

## The generator agent

`npm run agent -- "a cinematic poster of a lighthouse in a storm, film grain"` is the demo a judge
watches. A language model with four tools takes the prompt, and in one run it draws the picture,
signs it with a C2PA manifest, pins four files to IPFS, and registers the passport on Monad
mainnet. Every tool call and every tool result is printed as it happens, so nothing about the run
has to be taken on trust, and the whole transcript is appended to `proofs/agent-transcript.txt`.

The four tools are in `src/agent/tools.ts`:

- **generate_image** draws the picture and keeps the bytes on this side of the model. Image bytes
  never travel through the conversation, so the model cannot register a picture it imagined.
- **register_passport** runs the whole write path: `prepareImage` for the C2PA signature and the
  fingerprint, four pins to Pinata, the creator's passkey over the EIP-712 digest, this agent's own
  signature produced inside Privy's enclave, then `register` sent by the agent's server wallet under
  a policy that allows that one function on that one contract.
- **verify_image** posts the file to the verify service, which is the only thing that can match a
  re-encoded or rotated copy, then reads the passport it names straight off Monad, because the
  service is not the authority on who signed what.
- **lookup_agent** reads an owner and a registration card from the ERC-8004 Identity Registry.

The agent cannot spend the wallet it uses. Privy's policy names `register` on the Moolam registry
and typed data whose domain is that registry, and nothing else, so a compromised prompt cannot move
MON, cannot call another contract, and cannot register an edit.

### The models, and what they cost

| Job | Default model | List price | Override |
| --- | --- | --- | --- |
| Brain | `gpt-5.4-nano` | 0.20 dollars per million input tokens, 1.25 per million output | `AGENT_TEXT_MODEL` |
| Image | `gpt-image-1-mini` | 8 dollars per million image output tokens, about 1,200 tokens for one medium 1024 by 1024 picture | `AGENT_IMAGE_MODEL` |

Both were the cheapest current option on the account's own `/v1/models` list on 2026-09-08. A whole
generate run costs about one cent: the two recorded runs used 2,736 and 2,394 text tokens and one
picture each. The brain speaks the OpenAI chat completions API, so pointing it at OpenRouter is two
environment variables and no code change: set `AGENT_PROVIDER=openrouter` and, if you want a
different model, `AGENT_TEXT_MODEL=openai/gpt-5.4-nano`. The image model has no OpenRouter fallback,
because the images endpoint is OpenAI's own.

Needs in the root `.env`: `OPENAI_API_KEY`, plus everything `npm run prove:privy` needs, because the
agent uses the wallets that script created: the generator server wallet that owns ERC-8004 agent
10249, and the creator wallet with its passkey bound. The agent refuses to spend gas and says which
script to run if either is missing, or if the passkey on chain is not the one on this machine.

### Answering "who made this?"

The verify tool needs the verify service running:

```
PASSPORT_SOURCE=json PASSPORT_SOURCE_PATH=packages/agents/.moolam/passports.json \
  VERIFIER_PORT=4010 npm run dev:verifier
```

`register_passport` writes each new passport into that JSON file after reading it back off Monad, so
the file is a cache of the chain and never a source of its own. The service loads it once at boot,
which is why it is started after a registration. In production the same records come from Envio with
`PASSPORT_SOURCE=envio`.

On the recorded run, a copy of the agent's own picture re-encoded down to JPEG quality 60, 44 KB from
261 KB, came back matched at 0.97 confidence with the creator wallet, agent 10249 and the exact
registration time.

## Stating consent for the agent's pictures

`npm run consent:state` in this package reads the plan in `consent-plan.json` and writes it to
`MoolamConsent` at `0x1151E69a82947920546e779c4C8c785b2a3C1277` on Monad mainnet. These are
Moolam's own statements about its own demo pictures, made by the wallet that holds them, and they
speak for nobody else's work.

The plan has two parts. `statements` names the policies: `open` allows all four uses, `closed`
refuses all four, and `ask` marks all four constrained and carries the line a user reads when they
want to ask. `passports` maps each picture to one of those names. The eleven pictures in it are
every picture the demo agent's Privy creator wallet
(`0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6`) holds on the live registry: four open, four closed,
three ask. The wallet holds twenty tokens in all, and the other nine are proof and forgery cards
from `npm run prove` and `npm run prove:privy` rather than pictures, told apart by the title in the
metadata each one points at. Monsoon Fishing Nets Drying is `closed` on purpose: it opens the film
on the home page, and a picture that says "do not train on me" is the clearer story to tell there.

The run with no flag is a dry run and sends nothing:

1. The plan is checked before anything touches the network. An unknown statement name, an id that
   is not 32 bytes of hex, the same picture written twice in different case, or a constraint text
   the contract would refuse all stop the run with every problem listed at once.
2. The registry is asked who holds each picture. A picture this wallet does not hold stops the
   whole run, because `setConsentBatch` is all or nothing and one refused picture would revert the
   batch it travels in.
3. `consentOf` is read for each one. A picture whose newest entry already says what the plan says
   is skipped, so a second run after a successful send has nothing left to do.
4. What is left is grouped by identical statement and cut into calls of at most 32 pictures, which
   is the contract's own cap.
5. Each call is run through `eth_call` from the creator wallet's address against the live
   contract. That proves the holder check, the ten minute rule and the text rules all pass for
   these exact bytes from this exact wallet, without spending anything.
6. The same call is then run from `0x000000000000000000000000000000000000dEaD`, which comes back
   `NotPassportHolder`. Holding the passport is the only authority the contract takes.

`npm run consent:state -- --send` does all of that and then sends each batch from the creator's
wallet through Privy, sponsored when the app allows it and paid by the wallet when it does not. It
waits for each receipt, reads `consentOf` back for every picture in the batch, and only then
appends the proof lines to `proofs/consent-statements.txt`: the picture, the statement, the
transaction, the block, and the timestamp and writer exactly as the contract reports them. If any
picture does not read back as the plan says, the run stops rather than write a line it cannot
stand behind.

The three calls in the current plan estimate at 361,582, 361,595 and 612,623 gas including the ten
percent margin, so about 1.34 million gas in all, roughly 0.13 MON at 100 gwei. The `ask` batch
costs more per picture than the other two because its 75 byte constraint text is stored once per
picture. Needs `MONAD_MAINNET_RPC_URL` in the root `.env` for the dry run, and the three Privy
variables as well for `--send`.

## What each action costs

Measured by `npm run proof:anvil`, saved in `proofs/anvil-proof.txt`. Anvil answers
the P-256 precompile at `0x0100` the same way Monad does, checked directly against OpenZeppelin's
own probe vector, so these figures are close to the real thing rather than the much larger cost of
the pure Solidity fallback. Monad bills the gas limit you declare, not the gas you use.

| Action | Gas on the fork | In plain English |
| --- | --- | --- |
| Bind a passkey | 117,538 | One time per wallet, before it can register anything. |
| Register a Captured photo | 308,911 | Checks the WebAuthn signature, writes the record, mints the token. |
| Register an agent on ERC-8004 | 450,903 | One time per agent. Paid to the ERC-8004 registry, not to us. |
| Register a Generated image | 371,986 | The Captured cost plus the agent signature check and the ERC-8004 ownership read. |
| Append an edit | 353,983 | No passkey prompt. Holding the parent token is the authority. |

On mainnet through Privy wallets, with the limit set to the estimate plus ten percent, the last
`npm run prove:privy` run paid 0.0072 MON to rebind the passkey, 0.0422 MON to register and 0.0492
MON to append an edit, all at 102 gwei. The two agent runs recorded in the transcript paid the same
0.0422 MON each, at limits of 413,769 and 413,782 gas.

The gas figures the contracts package publishes are the ones to quote for mainnet: they are
measured in Foundry's Monad network family, which prices gas the way the chain we ship on does.
