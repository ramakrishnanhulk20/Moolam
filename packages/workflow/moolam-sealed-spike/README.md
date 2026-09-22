# Sealed re-check spike

One question, answered before any product work starts: can Chainlink re-check a picture that nobody
else can download?

The production workflow in `../moolam-verifier` fetches a public thumbnail on every node and the
nodes have to agree on the verdict. That only works for pictures anyone can fetch. This spike is the
other case. The picture sits on private storage, the only way to it is a credential, and the
credential is handed to a handler running inside a Chainlink enclave. The bytes are decoded and
fingerprinted inside that handler, and the only thing that leaves it is the verdict.

Nothing here ships. No transaction is sent, no wallet is used, and the production workflow folder is
untouched.

## What runs, in order

1. **Trigger.** A cron trigger, registered with `handlerInTee(...)` instead of `handler(...)`, with
   an empty TEE constraint, meaning any registered enclave in any region.
2. **The credential.** `runtime.getSecret({ id: "SEALED_FETCH_KEY" })`. In a deployed run the Vault
   DON releases this only into an attested enclave. In simulation it comes from an environment
   variable named in `secrets.yaml`.
3. **The link.** One POST to the storage provider's private download link endpoint, carrying the
   credential in the Authorization header, made with `HTTPClient.sendRequest(runtime, ...)` where
   `runtime` is the TEE runtime. It answers with a link that is good for two minutes.
4. **The bytes.** One GET on that link. The response body arrives as bytes, 36,589 of them for the
   file used here, against the HTTP capability's 250 KB response cap.
5. **The fingerprint.** `../moolam-verifier/decode.ts` and `../moolam-verifier/phash.ts`, imported
   directly rather than copied, so this spike hashes with exactly the code the production workflow
   hashes with. Decode took 519 ms and the 32 by 32 DCT took 310 ms inside the handler, against a
   five minute execution budget.
6. **The crossing.** `runtime.usingTheDons()`, then one `report` over the ABI encoded verdict in the
   same six fields the production workflow signs for `MoolamReceiver`:
   `(uint256 chainId, uint64 executedAt, bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed)`.
   The credential, the signed link and the image bytes never cross that line.

## What it proves

The file really is private. A plain GET of its content id gets nothing:

| Where | Answer |
| --- | --- |
| `https://gateway.pinata.cloud/ipfs/<cid>` | no answer inside 20 seconds, 0 bytes |
| `https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/<cid>` | 403, "The owner of this gateway does not have this content pinned to their Pinata account" |
| `https://lavender-personal-grasshopper-978.mypinata.cloud/files/<cid>` | 404, "peer does not have" |

The same public gateway serves the registered public thumbnail in the same 20 second budget, so the
probe works and the refusals are about the file, not about the network.

The verdict is right. The fingerprint recomputed inside the handler is `0x6ccf137087789a25` and the
fingerprint registered on chain for passport `0xcdb25d37...1638` is `0x6ccf137087789a25`, so the
distance is 0 bits against a match threshold of 10.

A wrong credential produces nothing. With `SEALED_FETCH_KEY` set to a wrong value the same run ends
at the link call with `the access link endpoint refused the sealed credential: status 401`. No
fingerprint is computed, no verdict is returned, no report is built.

## What it does not prove

- **The simulator is one machine, not an enclave.** It says so itself: "The simulator is not a real
  TEE, and is meant to debug. Do not use it for sensitive information." So this run proves the shape
  of the code and that the capability accepts it. It does not prove hardware isolation, and there is
  no node consensus behind the verdict either.
- **Deploying this needs access Moolam does not have.** Confidential Workflows is a private beta,
  invite only, separate from ordinary CRE deploy access. Chainlink's own guidance is that you do not
  wait for that to simulate, which is exactly what this folder does.
- **The logic is public, only the data is private.** Chainlink is blunt about it: the workflow binary
  handed to the enclave, including the code that runs inside it, is revealed. What the enclave keeps
  from the machine's operator is the data: the credential, the request and response bodies, the
  intermediate values.
- **The logs would have to go.** This handler logs sizes, timings and the verdict, which is fine for
  a simulation and is how the numbers above were measured. A deployed confidential workflow should
  log nothing, because a log leaves the enclave.
- **Only baseline JPEG.** Same limit as the production workflow: `jpeg-js` reads baseline files
  only.

## The credential, and what a real design would hand over

For this spike `SEALED_FETCH_KEY` is the Pinata account token, because that is what mints a private
download link today. That is deliberately the wrong credential for a real product: it can read,
write and delete everything in the account.

A real design gives the enclave a narrow bearer token for Moolam's own verify service instead, with
one power, to read the one file under re-check, for a few minutes. The verify service holds the
storage account token and never shares it. Then a leak out of the enclave costs one picture's bytes
rather than the whole account.

## Running it

```bash
cd packages/workflow
set -a; . ../../.env; set +a
export CRE_SEALED_FETCH_KEY="$PINATA_JWT"
cre workflow simulate moolam-sealed-spike --target staging-settings --non-interactive \
  --trigger-index 0 -e ../../.env
```

The negative run is the same command with `export CRE_SEALED_FETCH_KEY="not-the-sealed-fetch-key"`.
Never add `--broadcast`: this spike has no receiver and no chain to write to.

`secrets.yaml` names the environment variable and nothing else. No token is written into any file in
this repo.

## Files

| File | What it holds |
| --- | --- |
| `workflow.ts` | The TEE handler: the secret, the two HTTP calls, the fingerprint, the crossing |
| `main.ts` | The runner |
| `config.json` | The passport, the fingerprint read off chain, the private file's URL, the endpoint |
| `secrets.yaml` | Which environment variable holds the credential |
| `workflow.yaml` | Workflow name and artifact paths for the `staging-settings` target |
| `../moolam-verifier/decode.ts`, `../moolam-verifier/phash.ts` | Imported, not copied |

## Versions

`@chainlink/cre-sdk` 1.19.1 (Confidential Workflows need 1.18.0 or newer), CRE CLI v1.32.0,
`jpeg-js` 0.4.4, `viem` 2.34.0, `zod` 3.25.76.

One catch worth writing down: `z.string().url()` fails inside the sandbox, because the URL global is
not there, so the two addresses in `config.json` are checked with a pattern that also forces https.
