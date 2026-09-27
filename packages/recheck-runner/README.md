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

`MoolamReceiver` `0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04` (retired 2026-09-26; since 2026-09-27 the workflows send to the two `SimulationReceiver` contracts named in their `config.json`, which need none of this section's owner transactions) inherits Chainlink's `ReceiverTemplate` unchanged
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
# 1. point the receiver at the mock forwarder (a record: this receiver is retired since 2026-09-26)
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
2. Answers, with no run, the requests it already knows the answer to, up to 20 a pass: a passport
   it re-checked itself gets its report transaction back; one it settled as not re-checkable gets
   the reason; one whose paid run got no verdict within the cooldown gets the time it will be tried
   again; one that missed three times in a row for a passing reason gets that reason. Each is a
   claim and a done, so it leaves the queue's page instead of holding its place in it, and fifty of
   them can never hide a newer request. A request in a short passing wait is left for now.
3. Reads the index for passports with no re-check at all, registered more than
   `RUNNER_SETTLE_SECONDS` ago, leaving out by id every passport it is already leaving alone:
   settled, re-checked by this runner, set aside, cooling or waiting (up to the newest 1,000). The
   exclusion is in the query, so passports that can never be re-checked cannot fill the page and
   hide an older real picture. Requests come first; the sweep fills the rest of the pass.
4. For each passport in turn, one at a time, every read that can end its turn comes before any
   claim or spend:
   - its report memory: a passport this runner already sent a report for is never sent another.
     A report whose receipt could not be read yet is read again first: landed means done, not
     landed counts as a refusal.
   - the index row gives the registration transaction, which is the only place it is written down.
     A hash that is not `0x` and 64 hex digits, the queue's own predicate for an id, is settled,
     because it would end up on the CLI's command line. A passport the index shows with an
     attestation is settled. One the index has not caught up on yet waits.
   - the pinned document is fetched only from `ipfs://<cid>`, through the configured gateway, with
     redirects refused and the body cut off at 32,000 bytes. An http(s) address a registrant wrote
     is refused before any request: the workflows apply the same rule, `pinnedContentId` in
     `packages/workflow/moolam-verifier/pinned.ts`, held byte for byte to the runner's copy by
     `test/workflow-picture.test.ts`. An inline `data:application/json,` document makes no request.
     A body that is not a JSON object is settled; a gateway that did not answer is a passing miss.
   - the document's picture goes through the public workflow's own picture rule (`choosePicture`
     in `picture.ts`, copied and held to its answers by the same test file): a document that names
     no picture, or names one that is not `ipfs://<cid>`, is settled before anything is spent.
   - a seed test card is set aside by the sweep, though it still runs if somebody asked for it.
   - a sealed document sends one more question to the verify service, `GET /unseal/<id>` with a ten
     second timeout, because the document on chain says sealed for ever and only the unseal record
     beside it says the holder has published the picture since. A record means the passport is
     re-checked with the same command as a public one, on the record's `ipfs://` thumbnail; a 404
     or a record about another passport sets it aside, answering a request with the reason, and a
     later request looks again; any other status, a timeout or a body that is not JSON is a
     passing miss. Pointed at `deploy/queue-stub.mjs`, which has no unseal route, a sealed passport
     reads as never published.
   - a document that is sealed, asks for a private re-check and names no picture (the same
     `privatelyRecheckable` predicate as the verify service and the sealed workflow, held byte for
     byte by `test/sealed-private-copy.test.ts`) goes to `moolam-sealed-verifier` instead.
     `GET /sealed/status/<id>` is read on every turn: kept goes on; gone is handled exactly as a
     plain sealed passport, through the unseal record; unknown is a passing miss. The env file must
     carry `CRE_SEALED_LINK_TOKEN`, checked by name, or the passport is set aside with that reason.
   - for a public run, the picture itself is read through the same gateway under the workflow's
     rules (a 200 only, redirects refused, 60,000 byte cap) and its size taken off the JPEG frame
     header. A picture over the cap, not a JPEG, or under 32 px on a side, which is what a picture
     more than 16 times wider than tall becomes as a 512 px thumbnail, is settled: the fingerprint
     refuses it with `fingerprintSizeRefusal` in `phash.ts`, and the runner's copy is held to that
     text and to the decoder's own sizes by `test/workflow-picture.test.ts`. A JPEG whose size the
     runner cannot find is left to the workflow rather than refused on a guess.
   - the CRE wallet's balance is read again, because the passport before it spent from the same
     wallet. Under the floor the pass stops, with nothing claimed.
   - the receipt gives the event index: the position of `PassportRegistered` among the logs of its
     own transaction, 0 for a plain register and 1 for one sent through the ERC-4337 entry point. A
     reverted registration or one with no log for this passport is settled; any other failure of
     that read is a passing miss.
   - a stop signal that came in by now ends the pass here, before anything is claimed.
   - only now the claim, `POST /recheck/claim`. A queued request must answer claimed, or it is left.
     A sweep candidate is claimed only to catch a request that came in meanwhile: a request
     somebody is running means skip; a finished one (the service's 409 `not-pending`) or none means
     run with nothing to tell. A private run needs a live claim for the service to mint its link, so
     a private sweep candidate places a request of its own first, `POST /recheck/request`.
   - the spend is counted, then
     `cre workflow simulate moolam-verifier --target monad-mainnet --non-interactive
     --trigger-index 0 --evm-tx-hash <tx> --evm-event-index <n> -e <env file> --broadcast`.
   - the report transaction and the recomputed fingerprint are read out of the output, and the
     report is written into the runner's memory before anything else. The run is done only when that
     transaction's receipt carries the registry's own `VerificationAttested` log for this passport,
     whichever receiver wrote it: Chainlink's mock forwarder mines a report its receiver refused
     with status 1, so the status alone proves nothing. Every report is sent with the workflows'
     explicit gas limit of 1,000,000, which nothing on the command line changes, because an
     estimated limit starves the receiver inside the mock.
   - from the claim on, every way out hands the request back exactly once, `POST /recheck/done`: the
     report transaction when it landed, a redacted reason otherwise, and a reason when the simulator
     threw or would not start.
   - one log line, and the state file is written.

How a turn ends decides when the passport is looked at again:

| Outcome | Examples | The request | The passport | Counted |
| --- | --- | --- | --- | --- |
| Landed | the registry recorded the attestation | done, with the report transaction | never run again: its report is remembered for a week and the index shows it after that | the report |
| Settled, not re-checkable | no picture, a picture that is not `ipfs://<cid>`, over the cap, not a JPEG, under 32 px, a malformed registration hash, already attested, the receiver refused two reports | failed, with the reason, then answered from memory | never read or run again | nothing, or the reports already sent |
| Set aside | a seed card in the sweep, sealed and not published, no sealed link token | failed, with the reason | the sweep leaves it for the cooldown; a new request looks again | nothing |
| Passing miss before the spend | the gateway, the index or the node did not answer, a 429 or 5xx, the private copy's state unknown | stays pending, unclaimed | tried again after `RUNNER_RETRY_SECONDS`, doubling with each miss in a row up to the cooldown; a request is answered after three misses | nothing |
| Passing failure of a paid run | a gateway timeout or a 5xx inside the workflow, the runner's own time limit, a receipt not served yet | handed back with the reason, then placed again so it reads waiting, not failed | the same short, doubling wait | the report and one failure |
| Final failure of a paid run | a 404 inside the workflow, a decode error, the first refused report | failed, with the reason | left for the cooldown | the report and one failure |

Only lines matching one of three known patterns are ever taken out of the simulator's output, so
nothing the CLI happens to print can reach a log by accident. Every reason, every line the runner
logs, and every reason it keeps in its state file for a later answer is then stripped of
addresses, bearer values, the parameters of a signed download link, the verify service's host, and
every value of eight characters or more in the env file and in the runner's own token and
addresses, with each address's host and key-bearing path segments, because the queue serves
reasons on a public route. Every value handed to the CLI is checked for its shape first: the tx
hash as above, the event index a whole number from 0 to 1,000, and the target, the env file and the
workflow folder never starting with a dash or holding a control character. A request that fails
any of them is not run.

### The guards

| Guard | Default | What it does |
| --- | --- | --- |
| `RUNNER_MAX_REPORTS_PER_DAY` | 40 | Counted in the state file, per UTC day, and counted before the run rather than after, so a machine that dies mid-run comes back having already paid for it. A count read back that is not a whole number from zero up reads as the day used up. A passport settled before the spend never counts |
| `RUNNER_MIN_MON` | 1.5 | The pass stops when the CRE wallet is under this, read again before every passport and before any claim |
| `RUNNER_MAX_PER_PASS` | 5 | One passport at a time, and no more than this run in one pass. Up to 20 requests a pass are also answered from memory, with no run |
| `RUNNER_SIMULATE_TIMEOUT_SECONDS` | 600 | A hung compile or a silent gateway is killed rather than held. Keep it at least two minutes under the unit's `TimeoutStopSec` of 720 |
| `RUNNER_FAILURES_BEFORE_BACKOFF` / `RUNNER_BACKOFF_MINUTES` | 3 / 30 | Three failures in a row and the runner sits out half an hour |
| `RUNNER_COOLDOWN_SECONDS` | 21600 | A passport whose paid run got no verdict is left alone for six hours, and so is one the sweep set aside. It is also the longest a passing wait grows to |
| `RUNNER_RETRY_SECONDS` | 600 | The first wait after a passing miss. It doubles with each miss in a row, up to the cooldown |
| One report per passport | always | The runner remembers every report it sent for a week and never sends a second for that passport, whatever the index says. See "The index-lag assumption" below |
| Two refusals | always | A passport whose report the receiver refused twice is settled: a third would be refused and paid for too |
| Circuit breaker | 3 | Three reports in a row refused by the receiver (mined with `ReportProcessed` false and no `VerificationAttested`), on three different passports, trip it. The pass ends there and the runner sends nothing more: it keeps its loop alive, reads and answers nothing, spends nothing, and logs one `CIRCUIT BREAKER TRIPPED` line a pass saying when and why. A report that lands starts the count again. The trip is kept in the state file, so a restart leaves it tripped. The operator clears it by restarting once with `RUNNER_RESET_BREAKER=1`, then taking that line out of the env file again, below |
| Stop signal | always | Read between passports and just before any claim. The passport in hand finishes, hands back and the process exits; nothing new starts. The unit sends SIGTERM to the runner alone (`KillMode=mixed`) and waits 720 seconds, longer than one run |
| `RUNNER_DRY_RUN` | off | Everything except `--broadcast`, and no claim, no request and no done: the live queue is only read. A private re-check needs a live claim for its link, so a dry run names it and does not start it. Nothing is sent and nothing is spent |

### Clearing the circuit breaker

A tripped breaker means the receiver is refusing every report, usually a forwarder or author pin
that no longer matches what the simulator stamps, or a sending wallet it does not expect (see "How
the receiver is held during judging" above). Fix that first; a reset with the cause still there
trips again after three more paid reports.

```bash
journalctl -u moolam-recheck-runner -n 5 --no-pager      # the CIRCUIT BREAKER TRIPPED line says why
sudo sh -c 'echo RUNNER_RESET_BREAKER=1 >> /etc/moolam/runner.env'
sudo systemctl restart moolam-recheck-runner             # logs "circuit breaker cleared by RUNNER_RESET_BREAKER=1"
sudo sed -i '/^RUNNER_RESET_BREAKER=/d' /etc/moolam/runner.env
```

The last line matters. While `RUNNER_RESET_BREAKER=1` stays in the env file, every restart clears
the breaker, including the automatic one after a crash, and the runner says so at every start.
Editing the state file by hand is not the way: the runner rewrites it on every change.

### The index-lag assumption

Before the runner's own report memory, "never re-checks a passport twice" rested on the index
being less than six hours behind: a stale row reading zero attestations after the cooldown would
buy a second report. Now the runner writes down every report it sends, before it reads the receipt,
and refuses a second report for that passport for a week, from its own state file, without asking
the index. So the assumption is that the hosted index is less than a week behind, and that the
state file survives: a machine that loses its state file, or a second runner with a state file of
its own, is back to trusting the index for passports re-checked before.

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
| `RUNNER_STATE_PATH` | Where the day's count and the runner's memory of each passport are kept: reports sent, passports settled with their reasons, set aside, cooling and waiting |
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
| Gateway reads | about 160: the runner's document and picture reads, and the metadata and thumbnail the simulator fetches | 1M requests a month on the Pinata plan |
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

**3. Create the runner token.** Invent a long random token, put
it in `/etc/moolam/runner.env` as `RUNNER_TOKEN` and set the same value on Railway so the verify
service will answer the queue routes. No receiver transaction is needed any more: the two
`SimulationReceiver` contracts the workflow configs name have been listed since 2026-09-27 and
accept a report only from the CRE wallet. The transactions in "The narrowest state that works"
above were for the retired `MoolamReceiver`. The deployer key is never on the VM.

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

That pass ran before the review fixes of 2026-09-26. The same pass today claims nothing from the
queue, reads each picture's size before it runs it, words the seed card line "has no title", and
ends with the number of requests answered from memory.

When that reads right, take `RUNNER_DRY_RUN` out of the env file and restart. Watch the first live
pass to the end, then check the passport page for whichever picture it handled.

## Running it here

```bash
npm test
npx tsc --noEmit
RUNNER_DRY_RUN=1 npm run once   # one pass reading the live index and queue; claims and sends nothing
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
- It cannot read a private copy before a private re-check, since that needs the link the run
  itself asks for. A sealed picture too small to fingerprint is found out by the sealed workflow,
  as a final failure after the spend, not settled before it as a public one is.
- It does not stop the whole runner when every report is refused, for example while the receiver
  points at the wrong forwarder. Each passport stops after two refusals and three failures in a row
  start the backoff, so a standing refusal costs a few reports a passport, bounded by the daily cap.
