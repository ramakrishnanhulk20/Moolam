# Moolam threat model

Draft one, written before the attack scripts exist. Every claim below gets a
script that tries to break it against the live network before submission, and
the results replace the "to be run" markers. Weaknesses we did not fix are
listed last, on purpose.

## What Moolam promises

1. A passport, once registered, cannot be altered or removed by anyone.
2. A passport carries a creator signature made by a passkey the creator bound,
   and, for generated images, a signature by the generator agent that the
   ERC-8004 registry says owns that agent id.
3. An edit can only be appended by the current owner of the parent passport or
   an operator the owner approved.
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
| `register` | Replay a valid registration on another contract or chain | EIP-712 domain includes chain id and contract address | to be run |
| `register` | Reuse the same signatures for a second passport | exactHash is the id; duplicates revert | to be run |
| `register` | Forge the creator signature | WebAuthn assertion verified against the bound P-256 key; the digest is the challenge | to be run |
| `register` | Forge the generator signature | ECDSA recovery must equal `ownerOf(agentId)` on the ERC-8004 registry | to be run |
| `register` | Point at a nonexistent agent | `ownerOf` reverts; wrapped and turned into UnknownAgent | to be run |
| `register` | Use a stale signature | deadline in the signed struct | to be run |
| `bindPasskey` | Bind a key the caller does not hold | the assertion signs the wallet, key and nonce | to be run |
| `appendEdit` | Append an edit to someone else's passport | caller must own the parent or be approved | to be run |
| `appendEdit` | Use a revoked session signer | Privy refuses the signature server-side; the chain sees no transaction. Proof shows the refusal | to be run |
| `attest` | Attest from a random address | policy.isReceiver check | to be run |
| `attest` | Attest through the receiver from a fake forwarder | ReceiverTemplate checks msg.sender is the forwarder | to be run |
| `attest` | Spam attestations | 64 per passport cap | to be run |
| `flag` / `resolve` | Take the bond without resolving | resolver-only, pull payments, balance invariant | to be run |
| `withdraw` | Reentrancy | ReentrancyGuard and checks-effects-interactions | to be run |
| `rescueNative` | Owner drains bonds | rescue amount excludes totalBonds and totalOwed | to be run |
| VerifierPolicy | Add a receiver instantly after bootstrap | 24-hour queue; only removal is instant | to be run |
| Verifier API | Oversized or non-image upload | 20 MB cap, schema validation, 400 | to be run |
| Verifier API | Request floods | 60 per minute per IP, 429 | to be run |
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
- **Software keys.** Mera-derived persona keys are software keys in page memory
  while a session is open. A malicious dependency in the page could read them.
- **IPFS liveness.** If the pinned files disappear, the on-chain record still
  proves the hashes but the image is gone from our storage. Anyone holding a
  copy can re-verify it.
- **Self-audited.** No third party has audited these contracts. The attack
  scripts and their outputs are the evidence, and they are in this repo.
