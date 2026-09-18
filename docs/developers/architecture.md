---
title: Architecture
---

# Architecture

Three diagrams: what the pieces are, what happens when one image gets a passport, and what the
contracts depend on.

## System overview

Five people or programs touch the system and each one enters through a different door. The creator
binds a passkey and registers. The generator agent registers on the creator's behalf, with both
signatures. An editing app appends edits through a Privy session signer. Anyone verifying uploads a
copy to the verify service and never touches the chain at all. On chain, `MoolamRegistry` reads the
P-256 precompile for passkeys, the ERC-8004 Identity Registry for agent ownership, and
`VerifierPolicy` for who may attest. Off chain, the Chainlink CRE workflow re-fetches and
re-fingerprints, Envio indexes the events, and the verify service reads passports out of Envio.

```mermaid
flowchart LR
    subgraph People and agents
        C[Creator<br/>Privy embedded wallet + passkey]
        G[Generator agent<br/>OpenAI model + Privy server wallet<br/>ERC-8004 identity]
        E[Editing app<br/>Privy session signer]
        V[Anyone verifying<br/>newsroom, platform, judge]
    end

    subgraph Monad mainnet
        R[MoolamRegistry<br/>ERC-721 passports, edit tree,<br/>attestations, disputes]
        P[VerifierPolicy<br/>who may attest, 24h delay]
        RC[MoolamReceiver<br/>Chainlink ReceiverTemplate]
        I8[ERC-8004 Identity Registry<br/>canonical, read only]
        PC[P-256 precompile 0x0100]
    end

    subgraph Off-chain
        S[Verifier service<br/>fingerprints, C2PA, Hamming search,<br/>x402-paid API]
        X[Envio HyperIndex<br/>passports, trees, trust scores]
        W[Chainlink CRE workflow<br/>independent re-fetch and re-fingerprint]
        F[IPFS via Pinata<br/>image, manifest, thumbnail]
    end

    C -- bindPasskey, register --> R
    G -- register on creator's behalf --> R
    E -- appendEdit --> R
    R -- WebAuthn verify --> PC
    R -- ownerOf agentId --> I8
    R -- isReceiver --> P
    W -- writeReport --> RC -- attest --> R
    R -- events --> X
    X -- GraphQL --> S
    S -- reads --> F
    W -- fetches image --> F
    V -- upload any copy --> S
```

```mermaid phone "Half one: who writes to the registry, and what the registry reads."
flowchart TD
    C[Creator<br/>passkey] -- register --> R[Moolam<br/>Registry]
    G[Generator<br/>agent] -- register --> R
    E[Editing<br/>app] -- appendEdit --> R
    R -- verify --> PC[P-256<br/>precompile]
    R -- ownerOf --> I8[ERC-8004<br/>registry]
    R -- isReceiver --> P[Verifier<br/>Policy]
```

```mermaid phone "Half two: the independent re-check and the readers, off chain."
flowchart TD
    R[Moolam<br/>Registry] -- events --> X[Envio<br/>index]
    X -- trigger --> W[CRE<br/>workflow]
    W -- fetches --> F[IPFS via<br/>Pinata]
    W -- writeReport --> RC[Moolam<br/>Receiver]
    RC -- attest --> R
    X -- GraphQL --> S[Verifier<br/>service]
    V[Anyone<br/>verifying] -- uploads --> S
```

## Main sequence: a generated image gets a passport and is verified

Everything before the `register` call is preparation that costs no gas: the fingerprint, the C2PA
manifest, the four IPFS pins, and the EIP-712 digest read back from the contract. Then two
signatures over that one digest, the creator's passkey and the agent owner's wallet, and one
transaction that checks both. The registration event is what wakes the Chainlink workflow, which
fetches the image itself, recomputes the fingerprint, reaches consensus and writes the result back
through `MoolamReceiver`.

```mermaid
sequenceDiagram
    participant A as Generator agent
    participant S as Verifier service
    participant F as IPFS
    participant C as Creator (passkey)
    participant R as MoolamRegistry
    participant X as Envio
    participant W as CRE workflow
    participant RC as MoolamReceiver

    A->>A: generate image (OpenAI image model)
    A->>S: fingerprint(bytes): sha256, pHash, blockhash
    A->>S: embedManifest(bytes, soft binding)
    A->>F: upload image + manifest + thumbnail
    F-->>A: ipfs://CID
    A->>R: hashPassport(input) (view)
    R-->>A: EIP-712 digest
    A->>C: sign digest with passkey (WebAuthn)
    C-->>A: r, s, authenticatorData, clientDataJSON
    A->>A: sign digest with server wallet (generator signature)
    A->>R: register(input, creatorAuth, generatorSig)
    R->>R: WebAuthn.verify via P-256 precompile
    R->>R: ownerOf(generatorAgentId) on ERC-8004
    R-->>A: tokenId, PassportRegistered event
    R-->>X: event indexed
    X-->>W: log trigger fires
    W->>F: fetch image (downscaled copy under 100 KB)
    W->>W: recompute fingerprint, nodes reach consensus
    W->>RC: writeReport(passportId, matched, distance)
    RC->>R: attest(...)
    R-->>X: VerificationAttested indexed
```

```mermaid phone "Half one: everything before the transaction, off chain and free."
flowchart TD
    A1[Agent generates image] --> A2[Service fingerprints image]
    A2 --> A3[Service embeds manifest]
    A3 --> A4[IPFS pins files]
    A4 --> A5[Registry returns digest]
    A5 --> A6[Creator signs<br/>passkey]
    A5 --> A7[Agent owner signs]
```

```mermaid phone "Half two: one transaction, then the re-check that follows it."
flowchart TD
    B1[register, both signatures] --> B2[P-256 precompile checks]
    B2 --> B3[ERC-8004 owner checked]
    B3 --> B4[Passport minted]
    B4 --> B5[Envio indexes event]
    B5 --> B6[CRE workflow wakes]
    B6 --> B7[Re-fetch and re-fingerprint]
    B7 --> B8[Receiver writes report]
    B8 --> B9[Registry records attestation]
```

Verification of a copy later runs entirely off chain: anyone uploads a file to the service, the
service computes the eight rotated and mirrored fingerprints, searches the index, and returns the
best passport with its attestations, its edit chain and a confidence score.

## Contract dependency graph

`MoolamRegistry` is built out of OpenZeppelin v5.6.1 and reads two contracts it does not own. It
holds `IVerifierPolicy` as an immutable address set at deployment and Monad's ERC-8004 Identity
Registry the same way. `MoolamReceiver` inherits Chainlink's `ReceiverTemplate` verbatim, vendored
under `src/vendor/chainlink/` so it can be diffed against Chainlink's published source, and the
Keystone Forwarder is the only address allowed to call `onReport`.

```mermaid
flowchart TD
    MR[MoolamRegistry] --> ERC721[OpenZeppelin ERC721]
    MR --> EIP712[OpenZeppelin EIP712]
    MR --> WA[OpenZeppelin WebAuthn + P256]
    MR --> ECDSA[OpenZeppelin ECDSA]
    MR --> O2[OpenZeppelin Ownable2Step]
    MR --> PA[OpenZeppelin Pausable]
    MR --> RG[OpenZeppelin ReentrancyGuard]
    MR --> SE[OpenZeppelin SafeERC20]
    MR -. reads .-> IVP[IVerifierPolicy]
    MR -. reads ownerOf .-> I8[ERC-8004 Identity Registry, mainnet]
    VP[VerifierPolicy] --> O2
    VP -. implements .-> IVP
    RC[MoolamReceiver] --> RT[Chainlink ReceiverTemplate]
    RC -. calls attest .-> MR
    FW[Keystone Forwarder, Chainlink] -. onReport .-> RC
```

```mermaid phone "Half one: what MoolamRegistry is built out of."
flowchart TD
    MR[MoolamRegistry] --> OZ[OpenZeppelin v5.6.1<br/>ERC721<br/>EIP712<br/>WebAuthn and P256<br/>ECDSA<br/>Ownable2Step<br/>Pausable<br/>ReentrancyGuard<br/>SafeERC20]
```

```mermaid phone "Half two: what it reads, and who may write a re-check."
flowchart TD
    FW[Keystone<br/>Forwarder] -. onReport .-> RC[Moolam<br/>Receiver]
    RC --> RT[Chainlink<br/>Receiver<br/>Template]
    RC -. attest .-> MR[Moolam<br/>Registry]
    MR -. reads .-> IVP[IVerifier<br/>Policy]
    MR -. ownerOf .-> I8[ERC-8004<br/>registry]
    VP[Verifier<br/>Policy] -. implements .-> IVP
```

## How the app reads the chain

Every chain read a page makes happens on the app's server, not in the browser, so one endpoint
answers for every visitor. Two endpoints can be named. `NEXT_PUBLIC_MONAD_RPC_URL` is the public
one and is the only address the browser is ever given. `MONAD_RPC_URL` is optional and secret: a
dedicated endpoint, such as a QuickNode one, whose address carries its own access token. When it is
set, the server tries it first and falls back to the public endpoint, so a rate-limited minute on
either side is a slower page rather than an error. It is read on the server only, it must be an
https URL or the app refuses to start, and the one line a page prints when a read fails has every
address taken out of it first.

## What is immutable and what can change

- `MoolamRegistry` has no upgrade path. Records, edits and attestations are only ever added. The
  owner can pause new writes and rescue tokens sent by mistake; the owner cannot edit or delete a
  passport.
- `VerifierPolicy` is the only mutable piece: the list of receivers allowed to attest, the dispute
  resolver, the treasury and the bond. Every change is queued and executes 24 hours later,
  publicly, except removing a receiver, which is immediate so a compromised verifier can be cut
  off.
- The ERC-8004 registry is Monad's canonical deployment. Moolam only reads it.

The exact function signatures, events and errors are in the
[API reference](../api/registry). ABIs live in `packages/contracts/abi/`.
