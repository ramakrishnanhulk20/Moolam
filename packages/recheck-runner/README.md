# The re-check runner

Every real picture on the Moolam registry gets a Chainlink second opinion within minutes of being
registered, and a re-check somebody asks for runs the same way, without anyone pressing anything.

Today that only happens when the maintainer runs a local launch script by hand: each run opens the
receiver with the deployer's key, broadcasts one simulated report per passport, and closes the
receiver again. Fourteen pictures have a verdict that way and nothing has run since 2026-09-17. A
picture registered on a judging day would sit there with an empty verdict card under it.

This package is the same work, on a small Linux machine, every two minutes. It is a loop with no
framework and no runtime dependencies: Node's own `fetch` for the index, the verify service and the
RPC, and `child_process` for the CRE CLI.

## How the receiver is held during judging

This is the part that decides whether the runner is safe to leave alone, so it is written with the
evidence rather than the conclusion.

### What the receiver actually checks

`MoolamReceiver` inherits Chainlink's `ReceiverTemplate` unchanged
(`packages/contracts/src/vendor/chainlink/ReceiverTemplate.sol`). `onReport(metadata, report)` does
two things before the report is decoded:

1. `msg.sender` must be the stored forwarder address.
2. If any of the three identity fields is set, the template reads three values out of the
   `metadata` bytes the forwarder passes: `workflowId` at offset 32, `workflowName` at offset 64,
   `workflowOwner` at offset 74. Each set field must match. A name set without an author reverts
   `WorkflowNameRequiresAuthorValidation`, so those two always move together.

The pinned name is not the string. `setExpectedWorkflowName` takes `sha256(name)`, writes it as
hex, and keeps the first ten characters as ASCII. `sha256("moolam-verifier")` begins `4b8c03df04`,
so the pinned `bytes10` is `0x34623863303364663034`. Read from the live receiver on 2026-09-22:

| Field | Today |
| --- | --- |
| forwarder | `0x76c9cf548b4179F8901cda1f8623568b58215E62`, the production KeystoneForwarder |
| expected author | `0xC79620AF233a4434b03f6B57239F8A9E71B3C178`, the CRE wallet |
| expected workflow name | `0x34623863303364663034`, which is `4b8c03df04` |
| expected workflow id | unset |

Then `_processReport` checks that the report's chain id is 143 and that its `executedAt` is newer
than the last one this receiver recorded for that passport, and calls `attest` on the registry.

### What the simulator stamps in those fields

Not guessed, and not taken from a doc page. Read off the chain, out of the calldata of three
report transactions written on two different days:
`0x1da14e98…c0a8d12` (2026-09-14), `0x085d8500…5b6a3602` and `0x51ead7c9…13bb64469` (2026-09-17).
Each is a call to `report(address,bytes,bytes,bytes[])` on the mock forwarder, and each raw report
carries a 109 byte header in front of the six-field payload. All three headers are byte for byte
identical where identity is concerned:

| Field | What the simulator puts there |
| --- | --- |
| workflow id | `0x1111111111111111111111111111111111111111111111111111111111111111` |
| workflow name | `0x34623863303364663034`, the real one, derived from `workflow.yaml` |
| workflow owner | `0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA` |

The simulator's own log corroborates the first of those: a failed run on 2026-09-22 named its
trigger `trigger_reg_1111111111111111111111111111111111111111111111111111111111111111_0`
(`test/fixtures/simulate-failed.txt`).

And the forwarder is the CLI's own answer. `cre workflow supported-chains` prints, for
`monad-mainnet`, a forwarder of `0x76c9cf54…15E62` and a mock forwarder of `0x9eF6468C…9A784d`.
That second address answers `typeAndVersion()` with `MockKeystoneForwarder 1.0.0`.

So the author does not vary per run, and the name the simulator stamps is our real one. The pin can
hold. It does not have to be cleared.

### The narrowest state that works

Two owner transactions from the deployer wallet, sent once before judging opens:

```bash
# 1. point the receiver at the mock forwarder
cast send 0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04 "setForwarderAddress(address)" \
  0x9eF6468C5f37b976E57d52054c693269479A784d \
  --rpc-url "$MONAD_MAINNET_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"

# 2. pin the author to what the simulator stamps, keeping the same workflow name
cd packages/contracts
CRE_WALLET_ADDRESS=0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA \
CRE_WORKFLOW_NAME=moolam-verifier \
RECEIVER=0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04 \
forge script script/ConfigureReceiver.s.sol --rpc-url monad_mainnet -n monad \
  --gas-estimate-multiplier 110 --broadcast

# 3. optional, and worth it: pin the workflow id too
cast send 0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04 "setExpectedWorkflowId(bytes32)" \
  0x1111111111111111111111111111111111111111111111111111111111111111 \
  --rpc-url "$MONAD_MAINNET_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
```

Step 1 before step 2 leaves no dangerous moment: between them the receiver is on the mock forwarder
but still pinned to the CRE wallet as author, which refuses every simulated report.

Putting it back afterwards runs the same script with `CRE_WALLET_ADDRESS` set to the CRE wallet
again, then `setExpectedWorkflowId(0x0)`, then the forwarder back to
`0x76c9cf548b4179F8901cda1f8623568b58215E62`. Identity first and the forwarder last, so the door is
never wider than it was a moment before.

### What that keeps out, and what it does not

Being honest about the size of it. The pin narrows the door. It does not lock it.

It keeps out any workflow not named `moolam-verifier`. That is the whole of the protection, because
the other two fields are placeholders the CLI puts there for everybody. And the name is public:
`packages/workflow/moolam-verifier/workflow.yaml` is in this repository. Anyone who reads it can
name their own workflow the same and produce a report whose three identity fields match ours
exactly. The mock forwarder is a public contract owned by Chainlink, not by us, and the signatures
on a simulated report come from the simulator's own local keys.

So, plainly: **while the receiver points at the mock forwarder, anyone who installs the CRE CLI,
copies this workflow, names it `moolam-verifier`, points its `config.json` at our receiver and pays
about 0.102 MON of gas can append an attestation of their choosing to any passport in the
registry.** `VerifierPolicy` does not stop it, because our receiver is the one on its list. What is
left is inside the report: the chain id must be 143, and `executedAt` must be newer than the last
one recorded for that passport, which makes it one forged attestation per passport per run rather
than a flood. Attestations are appended, never replaced, so a forged one would sit beside the
honest one on the passport page with the same delivery label.

That exposure already exists for the few minutes each by-hand run lasts. The runner turns a few
minutes three times into the whole judging window. That is the trade, with the number in front of
it.

What would change it, in the order worth trying:

1. **Deploy access from Chainlink.** A deployed workflow writes through the production forwarder
   and the receiver keeps its real pin, with no open window at all. It also removes the login
   problem below. This is the only thing that closes the door rather than narrowing it.
2. **A watcher.** The runner reads back the attestations on every passport it handled and shouts
   about any it did not write. Not built here: it needs a registry read per passport and the
   queue's own record of what was asked for. It is the first follow-up.
3. **Keep the window to the judging days.** Two transactions to open, three to close.
4. **Do not put the deployer key on the VM.** The other shape, opening and closing the receiver
   around each run the way the launch scripts do, needs that key on a rented box, and a key that
   can re-point the receiver and spend the treasury is a worse thing to leave lying about than the
   window is.

## What the runner does, in order

Every `RUNNER_INTERVAL_SECONDS`, by default two minutes:

1. Reads the request queue, `GET /recheck/queue` with the runner token. A service with no token set
   answers 503 and the runner carries on from the index alone.
2. Reads the index for passports with no re-check at all, registered more than
   `RUNNER_SETTLE_SECONDS` ago. Requests come first; the sweep fills the rest of the pass.
3. For each passport in turn, one at a time:
   - a request is claimed first, `POST /recheck/claim`. A claim somebody else holds means skip.
   - the index row gives the registration transaction, which is the only place it is written down.
     A hash that is not `0x` and 64 hex digits, the queue's own predicate for an id, is refused
     before anything is read or counted, because it would end up on the CLI's command line.
   - the pinned document is fetched only from `ipfs://<cid>`, through the configured gateway, with
     redirects refused and the body cut off at 32,000 bytes. An http(s) address a registrant wrote
     is refused before any request, with that reason, and nothing is spent on it: the workflows
     apply the same rule, `pinnedContentId` in `packages/workflow/moolam-verifier/pinned.ts`, held
     byte for byte to the runner's copy by `test/workflow-picture.test.ts`. An inline
     `data:application/json,` document makes no request and is read as before.
   - the document decides whether to go on: a seed test card is swept past, though it still
     runs if somebody asked for it by hand. A sealed document sends one more question to the verify
     service, `GET /unseal/<id>` with a ten second timeout, because the document on chain says
     sealed for ever and only the unseal record beside it says the holder has published the picture
     since. A record means the passport is re-checked with the same command as a public one; a 404
     means it is refused as sealed; a record about another passport is refused; any other status, a
     timeout or a body that is not JSON means try again next pass, with no report counted, no
     cooldown started and no failure counted. Pointed at `deploy/queue-stub.mjs`, which has no
     unseal route, a sealed passport reads as never published.
   - a document that is sealed, asks for a private re-check and names no picture (the same
     `privatelyRecheckable` predicate as the verify service and the sealed workflow, held byte for
     byte by `test/sealed-private-copy.test.ts`) goes to `moolam-sealed-verifier` instead, after the
     wallet check below. `GET /sealed/status/<id>` is read just before the spend: kept goes on; gone
     is handled exactly as a plain sealed passport, through the unseal record; unknown means try
     again next pass with nothing spent, claimed or counted. The env file must carry
     `CRE_SEALED_LINK_TOKEN`, checked by name before anything is asked of the queue, or the
     passport is refused with that reason. A sweep candidate then gets a request of its own,
     `POST /recheck/request`, and is claimed, because the service mints a private link only under a
     live claim. That claim is handed back through `/recheck/done` whatever happens, a failed run, a
     simulator that would not start and a dry run included.
   - the CRE wallet's balance is read again, because the passport before it spent from the same
     wallet.
   - the receipt gives the event index: the position of `PassportRegistered` among the logs of its
     own transaction, 0 for a plain register and 1 for one sent through the ERC-4337 entry point.
   - `cre workflow simulate moolam-verifier --target monad-mainnet --non-interactive
     --trigger-index 0 --evm-tx-hash <tx> --evm-event-index <n> -e <env file> --broadcast`.
   - the report transaction and the recomputed fingerprint are read out of the output. The run is
     done only when that transaction's receipt carries the registry's own `VerificationAttested`
     log for this passport, whichever receiver wrote it: Chainlink's mock forwarder mines a report
     its receiver refused with status 1, so the status alone proves nothing. Then
     `POST /recheck/done` carries them back. A refused report, or one whose receipt cannot be read,
     is a failure like any other: it is counted, it counts towards the backoff, and it goes back
     with a reason and no transaction. A failure carries the CLI's own last complaint. Every report
     is sent with the workflows' explicit gas limit of 1,000,000, which nothing on the command line
     changes, because an estimated limit starves the receiver inside the mock.
   - one log line, and the state file is written.

Only lines matching one of three known patterns are ever taken out of the simulator's output, so
nothing the CLI happens to print can reach a log by accident. Every reason, and every line the
runner logs, is then stripped of addresses, bearer values, the parameters of a signed download
link, the verify service's host, and every value of eight characters or more in the env file and
in the runner's own token and addresses, with each address's host and key-bearing path segments,
before it is logged or posted, because the queue serves reasons on a public route. Every value
handed to the CLI is checked for its shape first: the tx hash as above, the event index a whole
number from 0 to 1,000, and the target, the env file and the workflow folder never starting with a
dash or holding a control character. A request that fails any of them is not run.

### The guards

| Guard | Default | What it does |
| --- | --- | --- |
| `RUNNER_MAX_REPORTS_PER_DAY` | 40 | Counted in the state file, per UTC day, and counted before the run rather than after, so a machine that dies mid-run comes back having already paid for it. A count read back that is not a whole number from zero up reads as the day used up |
| `RUNNER_MIN_MON` | 1.5 | The pass stops when the CRE wallet is under this, read again before every passport |
| `RUNNER_MAX_PER_PASS` | 5 | One passport at a time, and no more than this in one pass |
| `RUNNER_SIMULATE_TIMEOUT_SECONDS` | 600 | A hung compile or a silent gateway is killed rather than held |
| `RUNNER_FAILURES_BEFORE_BACKOFF` / `RUNNER_BACKOFF_MINUTES` | 3 / 30 | Three failures in a row and the runner sits out half an hour |
| `RUNNER_COOLDOWN_SECONDS` | 21600 | A passport already handled is left alone for six hours, which is what stops an index that has not caught up from being re-checked twice |
| `RUNNER_DRY_RUN` | off | Everything except `--broadcast` and the done report. Nothing is sent and nothing is spent |

## Configuration

Environment only, and no value is ever logged. The one file the runner opens is the CLI's env
file: to find `CRE_SEALED_LINK_TOKEN` in it before a sealed run, and to strip every value in it
out of what it logs and posts.

| Name | What it is |
| --- | --- |
| `VERIFY_SERVICE_URL` | The verify service holding the queue |
| `RUNNER_TOKEN` | The shared token, the same value set on Railway |
| `ENVIO_GRAPHQL_URL` | The hosted index |
| `MONAD_RPC_URL` | A public endpoint is enough: balances and receipts only |
| `CRE_WORKFLOW_DIR` | The folder holding `workflow.yaml` |
| `CRE_SEALED_WORKFLOW_DIR` | Optional. The sealed workflow's folder, by default `moolam-sealed-verifier` beside `CRE_WORKFLOW_DIR` |
| `CRE_ENV_FILE` | The file the CRE CLI reads for itself, holding `CRE_ETH_PRIVATE_KEY`, `MONAD_MAINNET_RPC_URL` and, for private re-checks, `CRE_SEALED_LINK_TOKEN`. The runner reads it to refuse a sealed run without that last name and to strip every value in it from what it logs and posts |
| `CRE_WALLET_ADDRESS` | The wallet watched against the floor |
| `RUNNER_STATE_PATH` | Where the day's count and the recent list are kept |
| `PINATA_GATEWAY_URL` | Optional. Defaults to the gateway the workflow's own `config.json` names |
| `MOOLAM_REGISTRY_ADDRESS` | Optional. Defaults to the mainnet registry |

`deploy/runner.env.example` is the whole list, ready to copy.

## What it costs a day

At the default two minute interval, 720 passes a day:

| Every day, doing nothing | Count | Against |
| --- | --- | --- |
| Index queries | 720, one a pass | About 100 a minute shared with the live site. This is 0.5 a minute |
| Verify service calls | 720, one a pass | Its own service |
| RPC calls | 0 | Nothing is read from the chain until a passport is worth running |

| At the daily cap of 40 reports | Count | Cost |
| --- | --- | --- |
| RPC calls | 120: a balance, a receipt and nothing else per passport | 3,600 QuickNode credits of about 2.67M a month |
| Gateway reads | about 120: the runner's document read, and the metadata and thumbnail the simulator fetches | 1M requests a month on the Pinata plan |
| Index queries | 760 | Still under one a minute |
| Report transactions | 40, at 1,000,000 gas and about 102 gwei | **4.08 MON a day from the CRE wallet** |

That last number is the one to look at. The CRE wallet held 28.266 MON on 2026-09-22 and Monad
reserves 10 that nothing can spend, so 18.266 is about 179 reports in total. At the cap that is
four and a half days. Across 21 judging days the wallet can sustain about eight a day. The cap of
40 is a ceiling on a bad afternoon, not a budget: real traffic is one report per new picture.

## Setting up the VM

Ubuntu 24.04, the smallest instance a provider sells. From a root shell:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/master/packages/recheck-runner/deploy/install.sh | sudo bash
```

While the repository is private there is no URL to clone, so the code travels as a git bundle:

```bash
git bundle create moolam.bundle master
scp moolam.bundle packages/recheck-runner/deploy/install.sh root@<vm>:/root/
ssh root@<vm> 'REPO_URL=/root/moolam.bundle bash /root/install.sh'
```

The bundle is cloned whole and becomes the clone's origin, so an update is a new bundle copied over
the old one and the same command run again.

It installs Node 22 from NodeSource, bun 1.4.2 (each workflow folder is pinned with `bun.lock`) and
the CRE CLI v1.35.0, each from its release archive checked against the sha256 in its publisher's
own checksum file and put in `/usr/local/bin`, owned by root and on the unit's `PATH`, clones the repository to `/srv/moolam`, installs the dependencies of both workflows,
`moolam-verifier` and `moolam-sealed-verifier`, builds this package, and installs the systemd unit.
It leaves the service stopped, on purpose.

Three things are left to the operator, because nothing on that machine can do them.

**1. Paste the secrets into the env file.** Copy `deploy/runner.env.example` to
`/etc/moolam/runner.env`, owned by `root:moolam`, mode 0640, so the service user can read it and
cannot rewrite it, and fill in the five values marked PASTE: the CRE wallet's
private key, the Monad RPC URL the workflow uses, the runner token, the sealed link token, and the
index address. That
file is read by the CRE CLI as well as by the runner, which is why the wallet key and
`MONAD_MAINNET_RPC_URL` live in it.

**2. Put the CRE session in place.** `cre workflow simulate` refuses to run without one. Proven on
this machine on 2026-09-22: with an empty `HOME` it answers `Authentication required: not logged in
and no CRE_API_KEY set`. Two ways:

- Copy `~/.cre/cre.yaml` from the machine that is already logged in to
  `/var/lib/moolam-recheck-runner/.cre/cre.yaml`, owned by the service user, mode 0600. It holds a
  refresh token, so it renews itself.
- Or use `CRE_API_KEY`, which is the version that does not depend on a browser. Chainlink's own
  words: "API key authentication requires your account to have deploy access approval." Moolam does
  not have deploy access today, so this is the second option only after Chainlink grants it.

**3. Create the runner token and send the receiver transaction.** Invent a long random token, put
it in `/etc/moolam/runner.env` as `RUNNER_TOKEN` and set the same value on Railway so the verify
service will answer the queue routes. Then send the receiver transactions in "The narrowest state
that works" above, from the deployer wallet, on the machine that holds that key. It is never on
the VM.

## Checks after install

Run these in order. Nothing below sends a transaction.

```bash
# 1. the CLI is there and the session works
cre workflow supported-chains | grep monad-mainnet

# 2. the configuration is complete. A missing name is printed; no value ever is.
sudo systemctl start moolam-recheck-runner
journalctl -u moolam-recheck-runner -n 20 --no-pager
```

The first line names the caps and the files and says which mode it is in. Missing configuration is
printed by name and never by value. This is a real dry pass run on 2026-09-22 against the live
index, the live chain and a stub queue holding one request, with `RUNNER_DRY_RUN=1` set:

```
moolam re-check runner starting: interval 120s, at most 3 a pass, daily cap 40, MON floor 1.500,
  workflow D:/Projects/Monad/packages/workflow/moolam-verifier, env file D:/Projects/Monad/.env,
  target monad-mainnet, state ...dryrun-state.json, DRY RUN, nothing will be broadcast
dry run: passport 0xbcdb2f0f06 would be re-checked from tx 0x04d286385e event 1, asked for by the queue
passport 0xbcdb2f0f06 tx 0x04d286385e event 1 -> nothing written, this was a dry run,
  recomputed 0x198df3e566199e99 distance 0 matched true
passport 0x980549624f is sealed, so there is no published picture to re-check
passport 0xcf7bc9c06b is a seed test card or has no readable document, not sweeping it
pass finished: 3 considered, 1 run, 1 done, 0 failed
```

That is the whole shape in six lines: the request first, the event index read off a real receipt
(1, because that registration went through the entry point), the CRE CLI actually run with
`--broadcast` left off so it recomputed the fingerprint and wrote nothing, the sealed passport
refused with its reason, and a seed card swept past. The state file afterwards read `reports: 0`,
so the dry run took nothing from the day's cap.

When that reads right, take `RUNNER_DRY_RUN` out of the env file and restart. Watch the first live
pass to the end, then check the passport page for whichever picture it handled.

## Running it here

```bash
npm test
npx tsc --noEmit
RUNNER_DRY_RUN=1 npm run once   # one pass against the live index and queue, sends nothing
```

`--once` runs a single pass and exits, which is what the dry run above uses.

`deploy/queue-stub.mjs` stands in for the queue when the verify service is not to hand, or before
its routes exist. It answers the three runner routes from a list given on the command line:

```bash
node deploy/queue-stub.mjs 4099 dry-run-token 0x<passport id>
```

## What this does not do

- It does not watch for attestations it did not write. That is the first follow-up, and the reason
  is in "What that keeps out" above.
- It does not open or close the receiver. Those are owner transactions with the deployer's key, and
  that key is not on the VM.
- It does not deploy the workflow to Chainlink's network. Nothing here changes the fact that every
  re-check on chain came from the simulator on one machine, which is what the passport page says
  under each verdict.
- It does not re-check a passport more than once. A passport with any attestation is left alone,
  so a second opinion on a picture that already has one has to be asked for after the existing
  ones are accounted for.
