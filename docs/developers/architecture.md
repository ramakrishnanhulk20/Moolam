---
title: Architecture
---

# Architecture

Three diagrams: what the pieces are, what happens when one image gets a passport, and what the
contracts depend on.

## System overview

Five people or programs touch the system and each one enters through a different door. The creator
binds a passkey (`bindPasskey`) and registers, and states how AI may use the picture. The generator
agent registers on the creator's behalf, with both signatures. An editing app appends edits through a
Privy session signer. Anyone verifying uploads a copy to the verify service and never touches the
chain at all. On chain, `MoolamRegistry` reads the P-256 precompile for passkeys, the ERC-8004 Identity Registry for
agent ownership, and `VerifierPolicy` for who may attest, while `MoolamConsent` reads the registry
for who holds a passport. Off chain, the Chainlink CRE workflow re-fetches and re-fingerprints,
Envio indexes the events, and the verify service reads passports out of Envio and statements
straight off the consent register.

Chainlink's verdicts reach the registry two ways. A verdict from Chainlink's network goes through the
Keystone Forwarder to `MoolamReceiver`, and only those can light a passport's trust mark. A test run in
Chainlink's simulator goes through the simulation forwarder to the `SimulationReceiver` pair, which also
checks that Moolam's CRE wallet signed the transaction. The sealed workflow reads a private copy through
a link the verify service mints.

The drawing reads from top to bottom. Rounded boxes are people and agents, solid boxes are contracts on
Monad mainnet, and dashed boxes run off chain.

```mermaid height=909
---
config:
  flowchart:
    nodeSpacing: 18
    rankSpacing: 34
    padding: 8
---
flowchart TD
    R[MoolamRegistry<br/>ERC-721 passports,<br/>edit tree,<br/>attestations,<br/>disputes]
    S[Verifier service<br/>fingerprints, C2PA,<br/>Hamming search,<br/>x402-paid API]
    SR[SimulationReceiver<br/>pair, public<br/>0x4aD6…Aa95,<br/>sealed<br/>0x52b8…57f6,<br/>CRE wallet only]
    F[IPFS via Pinata<br/>image, manifest,<br/>thumbnail]
    I8[ERC-8004<br/>Identity Registry<br/>canonical,<br/>read only]
    MC[MoolamConsent<br/>how AI may use<br/>a picture, dated<br/>and append only]
    MF[Chainlink<br/>simulation<br/>forwarder<br/>MockKeystone<br/>Forwarder]
    C([Creator<br/>Privy embedded<br/>wallet + passkey])
    G([Generator agent<br/>OpenAI model +<br/>Privy server<br/>wallet, ERC-8004<br/>identity])
    X[Envio HyperIndex<br/>passports, trees,<br/>trust scores]
    PC[P-256 precompile<br/>0x0100]
    W[moolam-verifier<br/>Chainlink CRE<br/>workflow,<br/>public pictures]
    WS[moolam-sealed-<br/>verifier<br/>Chainlink CRE<br/>workflow,<br/>private copies]
    E([Editing app<br/>Privy session<br/>signer])
    P[VerifierPolicy<br/>who may attest,<br/>24h delay]
    V([Anyone verifying<br/>newsroom,<br/>platform, judge])
    KF[Keystone<br/>Forwarder<br/>Chainlink network]
    MR[MoolamReceiver<br/>network verdicts<br/>0x0d69…ff04]

    %% The ~~~ links draw nothing. They only keep each box in the row it reads best in.
    R ~~~ MC
    PC ~~~ X
    WS ~~~ MF
    E ~~~ KF
    W ~~~ KF
    MC -- ownerOf --> R
    R -- events --> X
    MC -- events --> X
    X -- GraphQL --> S
    S -- consentOf --> MC
    W -- network report --> KF
    W -- test run --> MF
    WS -- test run --> MF
    KF -- onReport --> MR
    MF -- onReport --> SR
    C -- register --> R
    G -- "register for creator" --> R
    E -- appendEdit --> R
    C -- setConsent --> MC
    MR -- attest --> R
    SR -- attest --> R
    R -- "WebAuthn verify" --> PC
    R -- "ownerOf agentId" --> I8
    R -- isReceiver --> P
    V -- upload any copy --> S
    S -- reads --> F
    W -- fetches --> F
    WS -- private copy --> F

    classDef offchain stroke-dasharray:5 4
    class W,WS,X,S,F offchain
```

```mermaid phone "Half one: who writes to the registry, and what the registry reads." height=470
flowchart TD
    C[Creator<br/>passkey] -- register --> R[Moolam<br/>Registry]
    G[Generator<br/>agent] -- register --> R
    E[Editing<br/>app] -- appendEdit --> R
    C -- setConsent --> MC[Moolam<br/>Consent]
    MC -- ownerOf --> R
    R -- verify --> PC[P-256<br/>precompile]
    R -- ownerOf --> I8[ERC-8004<br/>registry]
    R -- isReceiver --> P[Verifier<br/>Policy]
```

```mermaid phone "Half two: the independent re-check and the readers, off chain." height=408
flowchart TD
    R[Moolam<br/>Registry] -- events --> X[Envio<br/>index]
    X -- trigger --> W[CRE<br/>workflow]
    W -- fetches --> F[IPFS via<br/>Pinata]
    W -- network report --> KF[Keystone<br/>forwarder]
    W -- test run --> MF[Simulation<br/>forwarder]
    KF -- onReport --> MR[Moolam<br/>Receiver,<br/>network]
    MF -- onReport --> SR[Simulation<br/>Receivers,<br/>public, sealed]
    MR -- attest --> R
    SR -- attest --> R
    X -- GraphQL --> S[Verifier<br/>service]
    S -- consentOf --> MC[Moolam<br/>Consent]
    V[Anyone<br/>verifying] -- uploads --> S
```

## Main sequence: a generated image gets a passport and is verified

Everything before the `register` call is preparation that costs no gas: the fingerprint, the C2PA
manifest, the four IPFS pins, and the EIP-712 digest read back from the contract. Then two
signatures over that one digest, the creator's passkey and the agent owner's wallet, and one
transaction that checks both. The registration event is what wakes the Chainlink workflow, which
fetches the image itself, recomputes the fingerprint and writes the result back through Chainlink's
Keystone Forwarder to `MoolamReceiver`. On Chainlink's network a quorum of nodes must produce the
identical verdict before a report is signed, and the first one did on 2026-10-02: ten nodes, distance 0,
written 16 seconds after the passport was registered
([transaction 0x760dcb5e…2882](https://monadvision.com/tx/0x760dcb5e1b83929201d8fe299ce9c3be2cf8981502117c5288386d7da3438882)).
A run in Chainlink's simulator with `--broadcast` is one machine and no consensus. It goes through the
simulation forwarder to a `SimulationReceiver`, which takes it only in a transaction Moolam's CRE wallet
signed. The passport page labels each verdict by the forwarder that delivered it.

```mermaid height=960
sequenceDiagram
    participant A as Generator agent
    participant S as Verifier service
    participant F as IPFS
    participant C as Creator (passkey)
    participant R as MoolamRegistry
    participant X as Envio
    participant W as CRE workflow
    participant KF as Keystone Forwarder
    participant MR as MoolamReceiver

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
    W->>W: recompute fingerprint (on the network, nodes must agree)
    W->>KF: writeReport(passportId, matched, distance), signed by the network
    KF->>MR: onReport(metadata, report)
    MR->>MR: check the forwarder and the pinned workflow
    MR->>R: attest(...)
    R-->>X: VerificationAttested indexed
    Note over KF,MR: a test run in the simulator goes through the simulation forwarder<br/>to a SimulationReceiver, which also checks the CRE wallet signed
```

```mermaid phone "Half one: everything before the transaction, off chain and free." height=565
flowchart TD
    A1[Agent generates image] --> A2[Service fingerprints image]
    A2 --> A3[Service embeds manifest]
    A3 --> A4[IPFS pins files]
    A4 --> A5[Registry returns digest]
    A5 --> A6[Creator signs<br/>passkey]
    A5 --> A7[Agent owner signs]
```

```mermaid phone "Half two: one transaction, then the re-check that follows it." height=913
flowchart TD
    B1[register, both signatures] --> B2[P-256 precompile checks]
    B2 --> B3[ERC-8004 owner checked]
    B3 --> B4[Passport minted]
    B4 --> B5[Envio indexes event]
    B5 --> B6[CRE workflow wakes]
    B6 --> B7[Re-fetch and<br/>re-fingerprint,<br/>nodes agree]
    B7 --> B8[Keystone forwarder<br/>delivers]
    B8 --> B9[MoolamReceiver<br/>checks workflow]
    B9 --> B10[Registry records attestation]
```

Verification of a copy later runs entirely off chain: anyone uploads a file to the service, the
service computes the eight rotated and mirrored fingerprints, searches the index, and returns the
best passport with its attestations, its edit chain and a confidence score.

## A statement about AI use, and the day query

A creator's answer to "may AI train on this" is written twice in the same minute and read back much
later. The service writes it into the signed C2PA manifest and the pinned metadata before the
passport exists, because a manifest is signed once and cannot be added to. The chain half waits
until the registration is confirmed, then goes out as a second sponsored transaction from the
creator's own wallet. If that second send fails, the passport stays registered and the statement can
be written later from the passport page.

The second half of the drawing is the question a label inside a file cannot answer. A reader asks
the register what was in force on a given day, and gets that day's entry rather than today's.

```mermaid height=528
sequenceDiagram
    participant C as Creator (studio)
    participant S as Verifier service
    participant F as IPFS
    participant R as MoolamRegistry
    participant MC as MoolamConsent
    participant V as A reader, later

    C->>S: prepare(file, training statement)
    S->>S: cawg.training-mining assertion into the signed manifest
    S->>F: pin image, thumbnail, manifest, metadata
    S-->>C: the words it wrote back, plus the passport fields
    C->>R: register(input, creatorAuth, generatorSig)
    R-->>C: PassportRegistered
    C->>MC: setConsent(passportId, consent, constraintInfo)
    MC->>R: ownerOf(passportId)
    R-->>MC: the holder
    MC-->>C: ConsentSet
    C->>MC: consentOf(passportId) (view, to confirm)
    V->>MC: consentAt(passportId, that day)
    MC-->>V: the entry in force then, or nothing stated
```

```mermaid phone "Half one: the statement, written into the file and then onto the chain." height=763
flowchart TD
    A1[Creator picks<br/>a statement] --> A2[Service writes<br/>the assertion]
    A2 --> A3[IPFS pins<br/>the metadata]
    A3 --> A4[Passport<br/>registered]
    A4 --> A5[Second send,<br/>sponsored]
    A5 --> A6[Register asks<br/>who holds it]
    A6 --> A7[ConsentSet<br/>emitted]
```

```mermaid phone "Half two: what a reader asks, months later." height=467
flowchart TD
    B1[Reader names<br/>a day] --> B2[consentAt on<br/>the register]
    B2 --> B3[Binary search<br/>of the history]
    B3 --> B4[The entry<br/>in force then]
    B3 --> B5[Or nothing<br/>stated yet]
```

## Contract dependency graph

`MoolamRegistry` is built out of OpenZeppelin v5.6.1 and reads two contracts it does not own. It
holds `IVerifierPolicy` as an immutable address set at deployment and Monad's ERC-8004 Identity
Registry the same way. Every receiver contract inherits Chainlink's `ReceiverTemplate` verbatim,
vendored under `src/vendor/chainlink/` so it can be diffed against Chainlink's published source. The
`SimulationReceiver` pair in use since 2026-09-27 takes `onReport` only from Chainlink's simulation
forwarder and only in a transaction Moolam's CRE wallet signed. `MoolamReceiver` takes it from the
Keystone Forwarder and from the workflow it is pinned to, which is how Chainlink's network writes. It
came off the policy on 2026-09-26 and went back on the list on 2026-10-02 at 07:08:18 UTC, in
[transaction 0x446c3051…ff9f](https://monadvision.com/tx/0x446c3051322060339d8e95bcc2938ca6db6692e8d583d360ebab6e626ea1ff9f).
Its sealed twin has been off the list since 2026-09-26. `MoolamConsent` depends on
nothing but an `IERC721` view: it holds the registry address as an immutable set at deployment and
asks it `ownerOf`, which is the whole integration. The arrow points one way, so the registry does
not know the consent register exists.

```mermaid height=371
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
    SR[SimulationReceiver, public and sealed] --> RT[Chainlink ReceiverTemplate]
    SR -. calls attest .-> MR
    MF[MockKeystoneForwarder, Chainlink] -. onReport, CRE wallet only .-> SR
    NR[MoolamReceiver, public, listed again 2026-10-02] --> RT
    NR -. calls attest .-> MR
    FW[Keystone Forwarder, Chainlink] -. onReport, network .-> NR
    MC[MoolamConsent] -. reads ownerOf .-> MR
```

```mermaid phone "Half one: what MoolamRegistry is built out of." height=409
flowchart TD
    MR[MoolamRegistry] --> OZ[OpenZeppelin v5.6.1<br/>ERC721<br/>EIP712<br/>WebAuthn and P256<br/>ECDSA<br/>Ownable2Step<br/>Pausable<br/>ReentrancyGuard<br/>SafeERC20]
```

```mermaid phone "Half two: what it reads, and who may write a re-check." height=446
flowchart TD
    MF[Simulation<br/>forwarder] -. onReport .-> SR[Simulation<br/>Receivers]
    FW[Keystone<br/>forwarder] -. onReport .-> NR[Moolam<br/>Receiver]
    SR --> RT[Chainlink<br/>Receiver<br/>Template]
    NR --> RT
    SR -. attest .-> MR[Moolam<br/>Registry]
    NR -. attest .-> MR
    MR -. reads .-> IVP[IVerifier<br/>Policy]
    MR -. ownerOf .-> I8[ERC-8004<br/>registry]
    VP[Verifier<br/>Policy] -. implements .-> IVP
    MC[Moolam<br/>Consent] -. ownerOf .-> MR
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
- `MoolamConsent` has no upgrade path and no owner at all. Statements are only ever appended, so a
  new one supersedes an old one without hiding it, and nobody can pause it or take it back.
- `VerifierPolicy` is the only mutable piece: the list of receivers allowed to attest, the dispute
  resolver, the treasury and the bond. Every change is queued and executes 24 hours later,
  publicly, except removing a receiver, which is immediate so a compromised verifier can be cut
  off. Two changes ran through that queue on 2026-10-02: `MoolamReceiver` was listed again at 07:08:18
  UTC, and the treasury was set to the burn address `0x000000000000000000000000000000000000dEaD` at
  07:27 UTC
  ([transaction 0x45700954…371d](https://monadvision.com/tx/0x457009544b51c256c130534b76cd7c3052e3f8299984b54d78037d21fb5d371d)),
  so a rejected challenge's bond is burned.
- The ERC-8004 registry is Monad's canonical deployment. Moolam only reads it.

The exact function signatures, events and errors are in the
[API reference](../api/registry). ABIs live in `packages/contracts/abi/`.
