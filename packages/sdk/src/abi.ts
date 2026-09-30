// The slices of the deployed contracts the kit calls, copied from packages/contracts/abi so a
// platform installs no build output. Struct field order is the contracts' own.

const webAuthnAuth = {
  name: "auth",
  type: "tuple",
  components: [
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
    { name: "challengeIndex", type: "uint256" },
    { name: "typeIndex", type: "uint256" },
    { name: "authenticatorData", type: "bytes" },
    { name: "clientDataJSON", type: "string" },
  ],
} as const;

const passportInput = {
  name: "p",
  type: "tuple",
  components: [
    { name: "exactHash", type: "bytes32" },
    { name: "parentId", type: "bytes32" },
    { name: "creator", type: "address" },
    { name: "generatorAgentId", type: "uint256" },
    { name: "phash", type: "uint64" },
    { name: "blockhash256", type: "bytes32" },
    { name: "manifestHash", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "fingerprintVersion", type: "uint8" },
    { name: "metadataURI", type: "string" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

const consentStruct = {
  name: "consent",
  type: "tuple",
  components: [
    { name: "aiTraining", type: "uint8" },
    { name: "aiGenerativeTraining", type: "uint8" },
    { name: "aiInference", type: "uint8" },
    { name: "dataMining", type: "uint8" },
  ],
} as const;

export const registryAbi = [
  {
    type: "function",
    name: "bindPasskey",
    stateMutability: "nonpayable",
    inputs: [{ name: "qx", type: "bytes32" }, { name: "qy", type: "bytes32" }, webAuthnAuth],
    outputs: [],
  },
  {
    type: "function",
    name: "getPasskey",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [
      { name: "qx", type: "bytes32" },
      { name: "qy", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "bindNonce",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [passportInput, { ...webAuthnAuth, name: "creatorAuth" }, { name: "generatorSig", type: "bytes" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "hashPassport",
    stateMutability: "view",
    inputs: [passportInput],
    outputs: [{ name: "digest", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getPassport",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "exactHash", type: "bytes32" },
          { name: "parentId", type: "bytes32" },
          { name: "creator", type: "address" },
          { name: "generatorAgentId", type: "uint256" },
          { name: "phash", type: "uint64" },
          { name: "blockhash256", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "kind", type: "uint8" },
          { name: "fingerprintVersion", type: "uint8" },
          { name: "registeredAt", type: "uint64" },
          { name: "disputed", type: "bool" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
  {
    // Only the three argument overload is declared, so no call can pick the one that carries data.
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "PasskeyBound",
    inputs: [
      { name: "wallet", type: "address", indexed: true },
      { name: "qx", type: "bytes32", indexed: false },
      { name: "qy", type: "bytes32", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PassportRegistered",
    inputs: [
      { name: "passportId", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "generatorAgentId", type: "uint256", indexed: true },
      { name: "parentId", type: "bytes32", indexed: false },
      { name: "phash", type: "uint64", indexed: false },
      { name: "blockhash256", type: "bytes32", indexed: false },
      { name: "manifestHash", type: "bytes32", indexed: false },
      { name: "kind", type: "uint8", indexed: false },
      { name: "fingerprintVersion", type: "uint8", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
  { type: "error", name: "EmptyMetadataURI", inputs: [] },
  { type: "error", name: "EnforcedPause", inputs: [] },
  { type: "error", name: "ERC721IncorrectOwner", inputs: [{ name: "sender", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "owner", type: "address" }] },
  { type: "error", name: "ERC721InsufficientApproval", inputs: [{ name: "operator", type: "address" }, { name: "tokenId", type: "uint256" }] },
  { type: "error", name: "ERC721InvalidReceiver", inputs: [{ name: "receiver", type: "address" }] },
  { type: "error", name: "ERC721NonexistentToken", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "InvalidAgentId", inputs: [] },
  { type: "error", name: "InvalidCreator", inputs: [] },
  { type: "error", name: "InvalidExactHash", inputs: [] },
  { type: "error", name: "InvalidFingerprintVersion", inputs: [] },
  { type: "error", name: "InvalidGeneratorSignature", inputs: [] },
  { type: "error", name: "InvalidKind", inputs: [] },
  { type: "error", name: "InvalidPasskeySignature", inputs: [] },
  { type: "error", name: "InvalidPublicKey", inputs: [] },
  { type: "error", name: "ParentNotAllowed", inputs: [] },
  { type: "error", name: "PasskeyNotBound", inputs: [{ name: "wallet", type: "address" }] },
  { type: "error", name: "PassportAlreadyExists", inputs: [{ name: "passportId", type: "bytes32" }] },
  { type: "error", name: "SignatureExpired", inputs: [{ name: "deadline", type: "uint64" }] },
  { type: "error", name: "UnknownAgent", inputs: [{ name: "agentId", type: "uint256" }] },
] as const;

export const consentAbi = [
  {
    type: "function",
    name: "setConsent",
    stateMutability: "nonpayable",
    inputs: [{ name: "passportId", type: "bytes32" }, consentStruct, { name: "constraintInfo", type: "string" }],
    outputs: [],
  },
  {
    type: "event",
    name: "ConsentSet",
    inputs: [
      { name: "passportId", type: "bytes32", indexed: true },
      { name: "writer", type: "address", indexed: true },
      { name: "index", type: "uint256", indexed: true },
      { ...consentStruct, indexed: false },
      { name: "constraintInfo", type: "string", indexed: false },
      { name: "at", type: "uint64", indexed: false },
    ],
  },
  { type: "error", name: "ConstraintInfoNotAllowed", inputs: [] },
  { type: "error", name: "ConstraintInfoNotPrintable", inputs: [{ name: "position", type: "uint256" }] },
  { type: "error", name: "ConstraintInfoRequired", inputs: [] },
  { type: "error", name: "ConstraintInfoTooLong", inputs: [{ name: "length", type: "uint256" }] },
  { type: "error", name: "NotPassportHolder", inputs: [{ name: "passportId", type: "bytes32" }, { name: "caller", type: "address" }] },
  { type: "error", name: "TooSoon", inputs: [{ name: "passportId", type: "bytes32" }, { name: "nextAllowedAt", type: "uint64" }] },
] as const;

/** ownerOf on the ERC-8004 identity registry: the address whose signature speaks for an agent. */
export const identityAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
