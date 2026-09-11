# Attack outputs

One file per attack in `../threat-model.md`, written by `npm run prove`. Each file is the whole
attempt: what was tried, what the live contract or the live service answered, and the transaction
hash where there is one. Nothing here is written by hand.

Every on-chain attack is run twice. First as a read against the deployed contract, which is how the
exact custom error is decoded. Then as a real transaction with the same gas limit, so the refusal is
on Monad mainnet where anyone can open it in the explorer. Using the same gas limit for both is what
rules out a revert that is really an out-of-gas. If the read had gone through, the run would say so
and would not send the transaction.

| File | What it tries | What refuses it |
| --- | --- | --- |
| `passkey-replay.txt` | Take the creator's WebAuthn assertion off a real passport and use it on a second passport with a different image hash | InvalidPasskeySignature. The assertion signs the digest, and the digest covers every field |
| `generator-signature-forged.txt` | Sign as the generator agent with a wallet that does not own its ERC-8004 identity | InvalidGeneratorSignature. Recovery has to equal `ownerOf(agentId)` on the live ERC-8004 registry |
| `unknown-agent.txt` | Claim an agent id nobody registered | UnknownAgent. The registry reads ownership from ERC-8004 and turns its revert into its own error |
| `expired-deadline.txt` | Use two perfectly valid signatures a minute after their deadline | SignatureExpired |
| `edit-by-non-owner.txt` | Hang an edit off a passport somebody else holds | NotParentOwner |
| `attest-from-stranger.txt` | Write a verification result straight into the registry from an unlisted wallet | NotReceiver. The policy is the only list, and adding to it waits 24 hours in the open |
| `report-from-fake-forwarder.txt` | Hand the receiver a well formed Chainlink report from the wrong sender | InvalidSender, from Chainlink's own ReceiverTemplate |
| `receiver-replay-and-wrong-chain.txt` | Deliver the same report twice, an older one, and one built for another chain | StaleReport and WrongChain. Behind the forwarder check, so it is proved by `MoolamReceiver.t.sol` rather than by a mainnet transaction, and the file says which tests |
| `privy-policy-refusal.txt` | Ask the generator agent's server wallet to send MON, and to call a function its policy does not name | Privy's enclave answers policy_violation. Nothing is signed, so nothing reaches Monad |
| `revoked-session-signer.txt` | Sign an edit with the app's session key after the creator took the permission back | Privy refuses the key. The permission lives on Privy's side, not in our code |
| `dispute-money-rules.txt` | Flag with no bond, settle a dispute without being the resolver, withdraw with nothing owed | InvalidBond, NotResolver, NothingToWithdraw |
| `verifier-api-limits.txt` | A 25 MB upload, a text file dressed as an image, a URL pointing back at 127.0.0.1, and 61 requests in a minute | 413, 400, 403, 429 |

## Running them again

```sh
npm run prove
```

That registers a fresh image on Monad mainnet, checks that six mangled copies and a metadata
stripped copy still resolve to it, answers a forgery, then runs every attack above and rewrites
these files. It spends about 0.4 MON. The full transcript lands in
`proofs/prove-it.txt`.

## What these outputs do not cover

An attack nobody thought of. This is the list from the threat model, written by the people who
built the thing, and no third party has audited it. The two known holes are stated in the threat
model rather than here: a crop of more than a few percent breaks the fingerprints, and a passport
proves who registered first, not who created.
