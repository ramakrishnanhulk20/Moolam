---
title: Threat model
---

# Moolam threat model

Every claim below has been attacked. The Proof column says what happened and
names the file the output is saved in: an attack sent against the live contracts
on Monad mainnet where that is possible, and a Foundry test where mainnet cannot
reach the code path. `npm run prove` runs the whole set again. Weaknesses we did
not fix are listed last, on purpose.

## What Moolam promises

1. A passport, once registered, cannot be altered or removed by anyone.
2. A passport carries a creator signature made by a passkey the creator bound,
   and, for generated images, a signature by the generator agent that the
   ERC-8004 registry says owns that agent id.
3. An edit can only be appended by the current owner of the parent passport.
   ERC-721 approvals and operators are refused; a marketplace listing grants no authoring power.
4. Only receivers listed by the policy can attest, and the list changes only
   through a public 24-hour delay.
5. Any copy of the image that survives as a picture (re-encoded, resized,
   re-uploaded, rotated, mirrored, metadata stripped) resolves to its passport.
6. Nobody can take money out of the registry except the person it is owed to.

## Who attacks, and what they want

| Attacker | Wants |
|---|---|
| Impostor creator | To register someone else's image as their own, or to attach their name to a popular image |
| Rogue generator | To claim an image was made by a reputable agent, or to hide that it was AI-generated |
| Compromised editing app | To use a session signer beyond the edit permission, or after revocation |
| Fake verifier | To attest false matches, or to spam attestations |
| Griefer | To flood disputes, oversized uploads, or the paid API |
| Platform | To break provenance by re-encoding, cropping or stripping metadata |
| Us | A judge must be able to check that the operators cannot rewrite records |

## Entry points and what stops each attack

| Entry point | Attack | What stops it | Proof |
|---|---|---|---|
| `register` | Replay a valid registration on another contract or chain | EIP-712 domain includes chain id and contract address | refused, `MoolamRegistry.t.sol` test_theSameInputOnAnotherContractCannotBeReplayed |
| `register` | Reuse the same signatures for a second passport | exactHash is the id; duplicates revert | refused on mainnet, PassportAlreadyExists, section 4 of the `npm run prove` output |
| `register` | Forge the creator signature | WebAuthn assertion verified against the bound P-256 key; the digest is the challenge | refused on mainnet, InvalidPasskeySignature, `attacks/passkey-replay.txt` |
| `register` | Forge the generator signature | ECDSA recovery must equal `ownerOf(agentId)` on the ERC-8004 registry | refused on mainnet, InvalidGeneratorSignature, `attacks/generator-signature-forged.txt` |
| `register` | Point at a nonexistent agent | `ownerOf` reverts; wrapped and turned into UnknownAgent | refused on mainnet, UnknownAgent, `attacks/unknown-agent.txt` |
| `register` | Use a stale signature | deadline in the signed struct | refused on mainnet, SignatureExpired, `attacks/expired-deadline.txt` |
| `bindPasskey` | Bind a key the caller does not hold | the assertion signs the wallet, key and nonce | refused, `MoolamRegistry.t.sol` test_bindPasskeyRejectsASignatureOverTheWrongDigest and test_bindPasskeyNonceStopsAnOldAssertionBeingReplayed |
| `appendEdit` | Append an edit to someone else's passport | caller must own the parent; approvals and operators are refused | refused on mainnet, NotParentOwner, `attacks/edit-by-non-owner.txt` |
| `appendEdit` | Use a revoked session signer | Privy refuses the signature server-side; the chain sees no transaction. Proof shows the refusal | refused by Privy, no transaction, `attacks/revoked-session-signer.txt` |
| `attest` | Attest from a random address | policy.isReceiver check | refused on mainnet, NotReceiver, `attacks/attest-from-stranger.txt` |
| `attest` | Attest through the receiver from a fake forwarder | ReceiverTemplate checks msg.sender is the forwarder | refused on mainnet, InvalidSender, `attacks/report-from-fake-forwarder.txt` |
| `attest` | Spam attestations | 64 per passport cap | refused at 64, `MoolamRegistry.t.sol` test_attestStopsAtTheCap |
| Receiver `onReport` | Replay a report whose first transmission reverted, or replay it on another chain | the report carries the chain id and a per-passport monotonic timestamp; the receiver rejects a repeat, an older one, or a foreign chain | refused, StaleReport and WrongChain, `attacks/receiver-replay-and-wrong-chain.txt`, proved by `MoolamReceiver.t.sol` because only Chainlink's forwarder can reach the check |
| `flag` / `resolve` | Take the bond without resolving | resolver-only, pull payments, balance invariant | refused on mainnet, InvalidBond and NotResolver, `attacks/dispute-money-rules.txt` |
| `withdraw` | Reentrancy | ReentrancyGuard and checks-effects-interactions | no reentrancy path found: testFuzz_withdrawNeverPaysTwice and invariant_balanceCoversEveryLiability; the live refusal with nothing owed is NothingToWithdraw in `attacks/dispute-money-rules.txt` |
| `rescueNative` | Owner drains bonds | rescue amount excludes totalBonds and totalOwed | refused, `MoolamRegistry.t.sol` test_rescueNativeCannotTouchBondsOrCredits |
| VerifierPolicy | Add a receiver instantly after bootstrap | 24-hour queue; only removal is instant | refused, `VerifierPolicy.t.sol` test_queueAddReceiverWaitsTheFullDelay and test_finalizeBootstrapClosesTheWindowForGood |
| Verifier API | Oversized or non-image upload | 20 MB cap, schema validation, 400 | refused live, 413 and 400, `attacks/verifier-api-limits.txt` |
| Verifier API | Request floods | 60 per minute per caller, read from the hop named in `TRUST_PROXY` rather than the socket, 429 | refused live, 429 on the 61st request, `attacks/verifier-api-limits.txt` |
| Image itself | Re-encode, resize, re-upload, strip metadata | perceptual fingerprints, measured: 0 bits moved | measured in WO-0a |
| Image itself | Rotate or mirror | eight dihedral fingerprints at query time | measured in WO-2 |

## Weaknesses we did not fix, stated plainly

- **First registered wins.** A passport proves who registered first, not who
  created. For AI output the two are the same moment, because the generator
  registers before publication. For a human photo it is a timestamped claim.
- **Crops.** A crop of more than a few percent breaks both fingerprints. We
  publish the measured number rather than pretend otherwise.
- **Adversarial perturbation.** Someone who knows the algorithms can craft an
  image that fingerprints close to another. We do not defend against that; the
  exact hash and the signatures still separate the two records.
- **The verifier's fetch.** The Chainlink workflow fetches a downscaled copy
  through an image proxy because of its 100 KB response cap. If the proxy lies,
  the attestation is wrong. The attestation is one signal next to the
  signatures, not the source of truth.
- **A stolen wallet can rebind the passkey.** Rotating a passkey needs the
  wallet plus an assertion from the new key, not the old one, so whoever
  controls the wallet controls the binding. We chose that so a lost passkey
  does not strand the account. Passports already registered keep their
  original signatures either way.
- **Tunnelled IPv6 forms.** The fetch guard normalises IPv4-mapped IPv6 and blocks every private, loopback, link-local and metadata range, pinning the socket to the address it checked. It does not decode the IPv4 embedded in 6to4, NAT64 or Teredo addresses, so on a host with one of those tunnels configured they remain a path inward. The verifier is deployed without such tunnels.
- **Software keys.** The seed, agent and proof scripts sign with a software passkey (a P-256 key held in
  process memory on the operator machine) so they can run unattended; a creator in the studio signs with the
  passkey in their own device authenticator, which never leaves it. The verifier posts reputation feedback
  from a plain key in its host environment, so a compromised host could post feedback in its name.
- **IPFS liveness.** If the pinned files disappear, the on-chain record still
  proves the hashes but the image is gone from our storage. Anyone holding a
  copy can re-verify it.
- **The digest the passkey signs comes from the RPC.** Today the browser asks the
  registry for the EIP-712 digest of the passport it is about to register and
  hands that answer straight to the passkey. A hostile RPC endpoint, or anyone
  sitting between the browser and it, could return a digest for different bytes,
  and the creator's device would sign something they never saw. The damage is
  bounded, because the signed struct still names the creator as the signer and
  the registry mints to that address, so an attacker gets a passport written in
  the creator's name rather than one written in their own. The fix in flight
  derives the digest locally in the browser from the same struct, which turns the
  RPC answer into a cross-check instead of the source of truth.
- **The passkey's rpId is a deployment constraint, not a contract rule.** A
  passkey is scoped to a registrable domain, and any page served under that
  domain can ask the authenticator for an assertion from the same key. So the app
  must never share a registrable domain with a page we do not control, including
  anything user-generated. On vercel.app the public suffix list gives us that for
  free: each subdomain is its own registrable domain, so no other deployment can
  reach our keys. On a custom domain the rule has to be kept by hand, which means
  every subdomain under it stays ours.
- **Self-audited.** No third party has audited these contracts. The attack
  scripts and their outputs are the evidence, and they are in this repo.
