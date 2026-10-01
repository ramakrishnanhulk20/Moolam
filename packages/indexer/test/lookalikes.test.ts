// The look-alike records, the network flag and the published decisions, driven
// through Envio's own test indexer with crafted events.
//
// NOT COVERED HERE: what the receivers and MoolamDecisions refuse on chain (the
// Foundry tests in packages/contracts cover the forwarder, the pins, the floors
// and the resolver check), whether the real forwarder is the `to` of a live DON
// write (proven only by the first network run), the GraphQL layer, and reorgs.
// The activation time comes from the test variable src/network.ts reads inside
// vitest, so these tests hold whatever value the shipped constant has.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const CHAIN = 143 as const;
const DEPLOY_BLOCK = 103054771;
const LOOKALIKE_BLOCK = 109555239;
const DECISIONS_BLOCK = 109555263;

const REGISTERED_AT = 1768471200; // 2026-01-15T10:00:00Z
const ACTIVATION = 1790000000;

const FORWARDER = "0x76c9cf548b4179F8901cda1f8623568b58215E62" as const;
const VERDICT_RECEIVER = "0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04" as const;
const DEPLOYER = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;
const SIMULATOR_RECEIVER = "0x4444444444444444444444444444444444444444" as const;
const RESOLVER = "0x6666666666666666666666666666666666666666" as const;

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;
const TEST_ACTIVATION_VARIABLE = "MOOLAM_TEST_NETWORK_ACTIVATION_TIME";

function hash(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

const ORIGINAL = hash(1);
const COPY = hash(2);
const OTHER_ORIGINAL = hash(3);

function registration(id: `0x${string}`, offset: number, timestamp: number) {
  return {
    contract: "MoolamRegistry" as const,
    event: "PassportRegistered" as const,
    block: { number: DEPLOY_BLOCK + offset, timestamp },
    transaction: { hash: hash(0xa000 + offset) },
    params: {
      passportId: id,
      creator: "0x1111111111111111111111111111111111111111" as const,
      generatorAgentId: 0n,
      parentId: ZERO_BYTES32,
      phash: 42n,
      blockhash256: hash(0xbb),
      manifestHash: hash(0xcc),
      kind: 0n,
      fingerprintVersion: 1n,
      metadataURI: "ipfs://passport",
    },
  };
}

/// The original at one second, the copy and a second original a second later.
const REGISTRATIONS = [
  registration(ORIGINAL, 100, REGISTERED_AT),
  registration(COPY, 101, REGISTERED_AT + 1),
  registration(OTHER_ORIGINAL, 102, REGISTERED_AT),
];

function lookalike(options: {
  passport: `0x${string}`;
  earlier: `0x${string}`;
  offset: number;
  executedAt: number;
  timestamp?: number;
  to?: `0x${string}`;
  phashDistance?: bigint;
  blockhashDistance?: bigint;
}) {
  return {
    contract: "MoolamLookalikes" as const,
    event: "LookalikeChecked" as const,
    block: { number: LOOKALIKE_BLOCK + options.offset, timestamp: options.timestamp ?? ACTIVATION },
    transaction: { hash: hash(0xb000 + options.offset), to: options.to ?? FORWARDER },
    params: {
      passportId: options.passport,
      earlierId: options.earlier,
      phashDistance: options.phashDistance ?? 2n,
      blockhashDistance: options.blockhashDistance ?? 4n,
      earlierSealed: false,
      executedAt: BigInt(options.executedAt),
    },
  };
}

function attestation(options: {
  receiver: `0x${string}`;
  offset: number;
  timestamp?: number;
  to?: `0x${string}`;
}) {
  return {
    contract: "MoolamRegistry" as const,
    event: "VerificationAttested" as const,
    block: { number: LOOKALIKE_BLOCK + options.offset, timestamp: options.timestamp ?? ACTIVATION },
    transaction: { hash: hash(0xc000 + options.offset), to: options.to ?? FORWARDER },
    logIndex: 0,
    params: {
      passportId: COPY,
      receiver: options.receiver,
      matched: true,
      distance: 0n,
      recomputed: hash(0xee),
    },
  };
}

type ProcessOptions = Parameters<ReturnType<typeof createTestIndexer>["process"]>[0];
type Simulate = NonNullable<NonNullable<ProcessOptions["chains"][typeof CHAIN]>["simulate"]>;

async function run(simulate: Simulate) {
  const indexer = createTestIndexer();
  await indexer.process({ chains: { [CHAIN]: { simulate } } });
  return indexer;
}

describe("look-alike records and the network flag", () => {
  beforeEach(() => {
    process.env[TEST_ACTIVATION_VARIABLE] = String(ACTIVATION);
  });

  afterAll(() => {
    delete process.env[TEST_ACTIVATION_VARIABLE];
  });

  it("L4: a record through the forwarder at activation is the network's and marks both passports", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: COPY, earlier: ORIGINAL, offset: 1, executedAt: ACTIVATION - 5 }),
    ]);

    const row = await indexer.Lookalike.getOrThrow(COPY);
    expect(row.network).toBe(true);
    expect(row.valid).toBe(true);
    expect(row.passport_id).toBe(COPY);
    expect(row.earlier_id).toBe(ORIGINAL);
    expect(row.earlierId).toBe(ORIGINAL);
    expect(row.phashDistance).toBe(2);
    expect(row.blockhashDistance).toBe(4);
    expect(row.executedAt).toBe(BigInt(ACTIVATION - 5));
    expect(row.blockNumber).toBe(BigInt(LOOKALIKE_BLOCK + 1));
    expect(row.blockTimestamp).toBe(BigInt(ACTIVATION));

    expect((await indexer.Passport.getOrThrow(COPY)).earlierFound).toBe(true);
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(1);
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).earlierFound).toBe(false);
  });

  it("L4: a record sent to the receiver by any transaction but the forwarder's is not the network's", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: COPY, earlier: ORIGINAL, offset: 1, executedAt: ACTIVATION, to: DEPLOYER }),
    ]);

    const row = await indexer.Lookalike.getOrThrow(COPY);
    expect(row.network).toBe(false);
    expect(row.valid).toBe(true);
    expect((await indexer.Passport.getOrThrow(COPY)).earlierFound).toBe(false);
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(0);
  });

  it("L4: a record one second before activation is not the network's", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({
        passport: COPY,
        earlier: ORIGINAL,
        offset: 1,
        executedAt: ACTIVATION - 10,
        timestamp: ACTIVATION - 1,
      }),
    ]);

    expect((await indexer.Lookalike.getOrThrow(COPY)).network).toBe(false);
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(0);
  });

  it("L4: with the activation time at zero nothing is the network's", async () => {
    process.env[TEST_ACTIVATION_VARIABLE] = "0";
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: COPY, earlier: ORIGINAL, offset: 1, executedAt: ACTIVATION }),
      attestation({ receiver: VERDICT_RECEIVER, offset: 2 }),
    ]);

    expect((await indexer.Lookalike.getOrThrow(COPY)).network).toBe(false);
    const [verdict] = await indexer.Attestation.getAll();
    expect(verdict?.network).toBe(false);
  });

  it("L4: an attestation is the network's only from the verdict receiver, through the forwarder, after activation", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      attestation({ receiver: VERDICT_RECEIVER, offset: 1 }),
      attestation({ receiver: VERDICT_RECEIVER, offset: 2, to: DEPLOYER }),
      attestation({ receiver: VERDICT_RECEIVER, offset: 3, timestamp: ACTIVATION - 1 }),
      attestation({ receiver: SIMULATOR_RECEIVER, offset: 4 }),
    ]);

    const byTx = async (offset: number) =>
      (await indexer.Attestation.getOrThrow(`${hash(0xc000 + offset)}-0`)).network;
    expect(await byTx(1)).toBe(true);
    expect(await byTx(2)).toBe(false);
    expect(await byTx(3)).toBe(false);
    expect(await byTx(4)).toBe(false);
  });

  it("L4: a network attestation raises networkAttestations and attestations by one", async () => {
    const indexer = await run([...REGISTRATIONS, attestation({ receiver: VERDICT_RECEIVER, offset: 1 })]);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.attestations).toBe(1);
    expect(global.networkAttestations).toBe(1);
  });

  it("L4: a simulator attestation raises attestations and leaves networkAttestations alone", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      attestation({ receiver: SIMULATOR_RECEIVER, offset: 1 }),
      attestation({ receiver: VERDICT_RECEIVER, offset: 2, to: DEPLOYER }),
    ]);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.attestations).toBe(2);
    expect(global.networkAttestations).toBe(0);
  });

  it("L4: an attestation one second before activation is not counted as the network's", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      attestation({ receiver: VERDICT_RECEIVER, offset: 1, timestamp: ACTIVATION - 1 }),
    ]);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.attestations).toBe(1);
    expect(global.networkAttestations).toBe(0);
  });

  it("L4: networkAttestations never passes attestations and matches the rows marked network", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      attestation({ receiver: VERDICT_RECEIVER, offset: 1 }),
      attestation({ receiver: SIMULATOR_RECEIVER, offset: 2 }),
      attestation({ receiver: VERDICT_RECEIVER, offset: 3, timestamp: ACTIVATION + 60 }),
      attestation({ receiver: VERDICT_RECEIVER, offset: 4, timestamp: ACTIVATION - 1 }),
      attestation({ receiver: VERDICT_RECEIVER, offset: 5, to: DEPLOYER }),
    ]);

    const global = await indexer.GlobalStats.getOrThrow("global");
    const rows = await indexer.Attestation.getAll();
    expect(global.attestations).toBe(rows.length);
    expect(global.networkAttestations).toBe(rows.filter((row) => row.network).length);
    expect(global.networkAttestations).toBe(2);
    expect(global.networkAttestations).toBeLessThanOrEqual(global.attestations);
  });

  it("L5: an earlier passport registered in the same second is not valid", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: OTHER_ORIGINAL, earlier: ORIGINAL, offset: 1, executedAt: ACTIVATION }),
    ]);

    const row = await indexer.Lookalike.getOrThrow(OTHER_ORIGINAL);
    expect(row.network).toBe(true);
    expect(row.valid).toBe(false);
    expect((await indexer.Passport.getOrThrow(OTHER_ORIGINAL)).earlierFound).toBe(false);
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(0);
  });

  it("L5: a record naming the wrong order, or a passport the index has not seen, is not valid", async () => {
    const unknown = hash(0x99);
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: ORIGINAL, earlier: COPY, offset: 1, executedAt: ACTIVATION }),
      lookalike({ passport: OTHER_ORIGINAL, earlier: unknown, offset: 2, executedAt: ACTIVATION }),
      lookalike({ passport: unknown, earlier: ORIGINAL, offset: 3, executedAt: ACTIVATION }),
    ]);

    expect((await indexer.Lookalike.getOrThrow(ORIGINAL)).valid).toBe(false);
    expect((await indexer.Lookalike.getOrThrow(OTHER_ORIGINAL)).valid).toBe(false);
    expect((await indexer.Lookalike.getOrThrow(unknown)).valid).toBe(false);
    expect(await indexer.Passport.get(unknown)).toBeUndefined();
    expect((await indexer.Passport.getOrThrow(COPY)).laterLookalikeCount).toBe(0);
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(0);
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).earlierFound).toBe(false);
  });

  it("L5: distances beyond 64 pHash bits or 256 blockhash bits are not valid", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: COPY, earlier: ORIGINAL, offset: 1, executedAt: ACTIVATION, phashDistance: 65n }),
    ]);
    expect((await indexer.Lookalike.getOrThrow(COPY)).valid).toBe(false);

    const second = await run([
      ...REGISTRATIONS,
      lookalike({
        passport: COPY,
        earlier: ORIGINAL,
        offset: 1,
        executedAt: ACTIVATION,
        phashDistance: 64n,
        blockhashDistance: 257n,
      }),
    ]);
    expect((await second.Lookalike.getOrThrow(COPY)).valid).toBe(false);
    expect((await second.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(0);
  });

  it("L5: a zero earlier id is none, never a match", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: COPY, earlier: ZERO_BYTES32, offset: 1, executedAt: ACTIVATION, phashDistance: 0n, blockhashDistance: 0n }),
    ]);

    const row = await indexer.Lookalike.getOrThrow(COPY);
    expect(row.network).toBe(true);
    expect(row.valid).toBe(true);
    expect(row.earlier_id).toBeUndefined();
    expect(row.earlierId).toBe(ZERO_BYTES32);
    expect((await indexer.Passport.getOrThrow(COPY)).earlierFound).toBe(false);
    for (const passport of await indexer.Passport.getAll()) {
      expect(passport.laterLookalikeCount).toBe(0);
    }
  });

  it("L6: a newer record replaces an older one and the old earlier passport's count drops", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: COPY, earlier: ORIGINAL, offset: 1, executedAt: ACTIVATION }),
      lookalike({ passport: COPY, earlier: OTHER_ORIGINAL, offset: 2, executedAt: ACTIVATION + 600, timestamp: ACTIVATION + 600 }),
    ]);

    const row = await indexer.Lookalike.getOrThrow(COPY);
    expect(row.earlier_id).toBe(OTHER_ORIGINAL);
    expect(row.executedAt).toBe(BigInt(ACTIVATION + 600));
    expect((await indexer.Lookalike.getAll()).length).toBe(1);
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(0);
    expect((await indexer.Passport.getOrThrow(OTHER_ORIGINAL)).laterLookalikeCount).toBe(1);
    expect((await indexer.Passport.getOrThrow(COPY)).earlierFound).toBe(true);
  });

  it("L6: a newer record that found none takes the mark off both passports", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: COPY, earlier: ORIGINAL, offset: 1, executedAt: ACTIVATION }),
      lookalike({ passport: COPY, earlier: ZERO_BYTES32, offset: 2, executedAt: ACTIVATION + 600, timestamp: ACTIVATION + 600 }),
    ]);

    expect((await indexer.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(0);
    expect((await indexer.Passport.getOrThrow(COPY)).earlierFound).toBe(false);
  });

  it("L6: an older record arriving after a newer one changes nothing", async () => {
    const indexer = await run([
      ...REGISTRATIONS,
      lookalike({ passport: COPY, earlier: ORIGINAL, offset: 1, executedAt: ACTIVATION + 600 }),
      lookalike({ passport: COPY, earlier: OTHER_ORIGINAL, offset: 2, executedAt: ACTIVATION + 600 }),
      lookalike({ passport: COPY, earlier: OTHER_ORIGINAL, offset: 3, executedAt: ACTIVATION }),
    ]);

    const row = await indexer.Lookalike.getOrThrow(COPY);
    expect(row.earlier_id).toBe(ORIGINAL);
    expect(row.blockNumber).toBe(BigInt(LOOKALIKE_BLOCK + 1));
    expect((await indexer.Passport.getOrThrow(ORIGINAL)).laterLookalikeCount).toBe(1);
    expect((await indexer.Passport.getOrThrow(OTHER_ORIGINAL)).laterLookalikeCount).toBe(0);
  });
});

describe("published decisions", () => {
  it("L28: stores each decision exactly as published, one row per challenge", async () => {
    const reasons = `ipfs://${"b".repeat(59)}`;
    const firstOpenedAt = 1790000100n;
    const secondOpenedAt = 1790500000n;

    const decision = (offset: number, openedAt: bigint, upheld: boolean, uri: string) => ({
      contract: "MoolamDecisions" as const,
      event: "DecisionPublished" as const,
      block: { number: DECISIONS_BLOCK + offset, timestamp: ACTIVATION + offset },
      transaction: { hash: hash(0xd000 + offset) },
      params: {
        passportId: COPY,
        openedAt,
        upheld,
        reasonsURI: uri,
        resolver: RESOLVER,
      },
    });

    const indexer = await run([
      ...REGISTRATIONS,
      decision(1, firstOpenedAt, false, reasons),
      decision(2, secondOpenedAt, true, `ipfs://${"c".repeat(59)}`),
    ]);

    const first = await indexer.Decision.getOrThrow(`${COPY}-${firstOpenedAt}`);
    expect(first.passport_id).toBe(COPY);
    expect(first.openedAt).toBe(firstOpenedAt);
    expect(first.upheld).toBe(false);
    expect(first.reasonsURI).toBe(reasons);
    expect(first.resolver).toBe(RESOLVER);
    expect(first.blockTimestamp).toBe(BigInt(ACTIVATION + 1));
    expect(first.txHash).toBe(hash(0xd001));

    const second = await indexer.Decision.getOrThrow(`${COPY}-${secondOpenedAt}`);
    expect(second.upheld).toBe(true);
    expect((await indexer.Decision.getAll()).length).toBe(2);
  });
});
