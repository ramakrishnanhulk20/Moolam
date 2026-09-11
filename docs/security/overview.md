---
title: Security overview
---

# Security overview

What is actually in the code, and what Moolam does not defend against. The full list of claims,
attacks and saved outputs is in the [threat model](threat-model).

## On chain

**No upgrade path.** `MoolamRegistry` is immutable. Records, edits and attestations are only ever
added. The `VerifierPolicy` and ERC-8004 registry addresses are `immutable` fields set at
deployment. The owner can pause new writes and rescue stranded value, and can never edit or delete
a passport or touch a user balance.

**Reentrancy guard.** `flag`, `resolve`, `withdraw`, `withdrawTo`, `rescueERC20` and `rescueNative`
are all `nonReentrant`. `_takeCredit` zeroes the caller's balance and decrements `totalOwed` before
`_payOut` makes any external call, so the guard is a second line rather than the only one.

**Pull payments.** `resolve` records a credit and never pushes native token, so a resolver cannot be
blocked by a challenger or treasury that refuses a transfer. `withdraw` and `withdrawTo` keep
working while the registry is paused, so a pause can never trap someone's money. `withdrawTo` only
ever spends the caller's own credit.

**`_mint`, not `_safeMint`.** There is no `ERC721Received` callback, so minting hands control to
nobody and there is no reentrancy surface at the end of `register` or `appendEdit`.

**No `receive` function.** Native token only arrives as a dispute bond through `flag`.
`rescueNative` computes its amount as `balance - totalBonds - totalOwed`, so an open bond and an
unclaimed credit can never be swept.

**Replay guards, four of them.**

| Replay | What stops it |
| --- | --- |
| The same registration on another contract or another chain | The EIP-712 domain includes the chain id and the contract address |
| The same signatures used for a second passport | `exactHash` is the id. A duplicate reverts `PassportAlreadyExists` |
| An old bind assertion reused | `bindPasskey` consumes a nonce per wallet |
| A stale signature | `deadline` is inside the signed struct and is checked against `block.timestamp` |

**Report replay.** `MoolamReceiver` refuses a report built for another chain (`WrongChain`) and any
report whose `executedAt` is not newer than the last one recorded for that passport
(`StaleReport`). Both values travel inside the signed payload, because Chainlink's own guidance is
that a report whose first transmission reverted can be sent again.

**Access control.** `Ownable2Step` on both owned contracts, so a typo cannot lose one. `attest` is
gated on `VerifierPolicy.isReceiver`. `resolve` is gated on `VerifierPolicy.resolver()`.
`appendEdit` is gated on owning the parent token, and an ERC-721 approval is explicitly not enough.
`onReport` is gated on the Chainlink forwarder plus the pinned workflow author and name.

**Timelock.** Every change that widens trust waits 24 hours in the open. Removing a receiver is the
one immediate action, because a compromised verifier has to stop writing in the same block someone
notices.

**Caps.** A passport holds at most 64 attestations, which bounds storage growth and keeps a full
read comfortably inside one block.

## Off chain

**SSRF guard.** Any URL handed to `/verify` is checked before every connection and again after
every redirect. The address is normalised first, so `127.0.0.1`, `0x7f000001`, `2130706433` and
`[::ffff:127.0.0.1]` are all recognised as loopback, and private, link-local, unique-local,
carrier-grade NAT, multicast, reserved and cloud metadata ranges are refused with 403. The
connection is then pinned to the addresses that were checked, so a name that answers differently
the second time fails instead of reaching an internal service. The paid route does not accept a URL
at all, so those checks live in exactly one place.

**Rate limits.** 60 requests a minute, keyed on the socket address. `trustProxy` is off, so nobody
can pick their own bucket by sending a header. Every rejection is logged with its reason.

**Byte and pixel limits.** 20 MB per upload, enforced on the multipart part and again chunk by
chunk as a remote body streams in, because a `Content-Length` header is a claim and not a fact. 40
megapixels, refused with 413 before a single pixel is decoded, because a 572 KB JPEG can unpack to
100 megapixels.

**Concurrency gate.** Two matches run at a time. Matching decodes the picture nine times over, so
the rate limit alone does not bound memory. A third caller waits. The studio's prepare route runs
its decode, manifest and thumbnail behind the same gate.

**The studio's upload route.** `POST /prepare` takes a creator's image straight from their browser,
which makes it the one route that spends money on Moolam's behalf: four IPFS pins a call. It is
gated on a Privy access token, checked against the app's published key set for the right issuer,
this app id in the audience, ES256 and an expiry that has not passed. A token minted by another
Privy app fails on the audience, and that is the check that stops a stranger's app spending the
pinning account. Twenty prepares an hour, counted on the verified Privy user id, which a caller
cannot choose. The route is mounted only when the host holds both a Pinata token and a Privy app id,
so a verify-only deployment does not carry the surface at all, and the service holds no key that can
write to the chain either way: the browser signs the passport and sends the transaction itself.

**Browser origins.** Only the exact origins listed in `CORS_ORIGINS` get an allow header back, and
an entry with a wildcard, a path or a trailing slash stops the boot instead of widening the list.
`PRIVY_JWKS_OVERRIDE_PATH`, which points the token check at a local key file so tests can sign their
own tokens, is refused when `NODE_ENV` is production, because anyone holding that key could
otherwise mint tokens the service would accept.

**Environment validation.** Every variable is checked at boot and a bad value names itself, so a bad
configuration stops the service before it listens rather than after. The C2PA certificate and key
have to be set together or not at all.

**Keys.** No private key, seed phrase or API key is hardcoded anywhere. Everything is read from
`.env`, and `.env.example` lists what has to go in it. The generator agent's key never leaves
Privy's enclave, and its policy allows one function on one contract.

## What Moolam does not defend against

These are the weaknesses the threat model states plainly rather than papers over.

- **First registered wins.** A passport proves who registered first, not who created. For AI output
  the two are the same moment. For a human photo it is a timestamped claim.
- **Crops.** A crop of more than a few percent breaks both fingerprints. The measured numbers are
  published rather than hidden.
- **Adversarial perturbation.** Someone who knows the algorithms can craft an image that
  fingerprints close to another. Moolam does not defend against that. The exact hash and the
  signatures still separate the two records.
- **The verifier's fetch.** The Chainlink workflow fetches a downscaled copy through an image proxy
  because of its 100 KB response cap. If the proxy lies, the attestation is wrong. An attestation is
  one signal next to the signatures, not the source of truth.
- **A stolen wallet can rebind the passkey.** Rotating a passkey needs the wallet plus an assertion
  from the new key, not the old one, so whoever controls the wallet controls the binding. That was
  chosen so a lost passkey does not strand the account. Passports already registered keep their
  original signatures either way.
- **Tunnelled IPv6 forms.** The fetch guard does not decode the IPv4 embedded in 6to4, NAT64 or
  Teredo addresses, so on a host with one of those tunnels configured they remain a path inward. The
  verifier is deployed without such tunnels.
- **Software keys.** Persona keys derived in the browser are software keys in page memory while a
  session is open. A malicious dependency in the page could read them.
- **IPFS liveness.** If the pinned files disappear, the on-chain record still proves the hashes but
  the image is gone from Moolam's storage. Anyone holding a copy can re-verify it.
- **Self-audited.** No third party has audited these contracts. See [Audits](audits).
