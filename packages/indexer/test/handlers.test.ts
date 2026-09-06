// Handler behaviour, driven through Envio's own test indexer with simulated
// events instead of a live chain.
//
// NOT COVERED HERE: anything below the handlers. These tests do not check that
// config.yaml decodes the real ABIs, they do not run against Monad, and they do
// not exercise reorg handling or the GraphQL layer. The ReceiverAdded and
// ReceiverRemoved handlers are written but not tested here, because WO-3 did not
// list them. Every assertion below is about what the handlers write, not about
// what the registry contract enforces, which is covered by the Foundry tests in
// packages/contracts.
//
// These tests have never been executed. `envio codegen` needs Linux and WSL2 is
// still being installed on this machine, so nothing here has run yet.

import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const CHAIN = 143;

const DAY_ONE = 1768471200; // 2026-01-15T10:00:00Z
const DAY_TWO = 1768557600; // 2026-01-16T10:00:00Z

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as const;

const CREATOR = "0x1111111111111111111111111111111111111111" as const;
const OTHER_CREATOR = "0x2222222222222222222222222222222222222222" as const;
const BUYER = "0x3333333333333333333333333333333333333333" as const;
const RECEIVER = "0x4444444444444444444444444444444444444444" as const;
const CHALLENGER = "0x5555555555555555555555555555555555555555" as const;
const RESOLVER = "0x6666666666666666666666666666666666666666" as const;

const AGENT_ID = 7n;

/// A readable stand-in for a 32 byte image hash.
function hash(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function registration(options: {
  id: `0x${string}`;
  parentId?: `0x${string}`;
  creator?: `0x${string}`;
  agentId?: bigint;
  timestamp?: number;
  blockNumber?: number;
  txHash?: string;
}) {
  return {
    contract: "MoolamRegistry" as const,
    event: "PassportRegistered" as const,
    block: {
      number: options.blockNumber ?? 100,
      timestamp: options.timestamp ?? DAY_ONE,
    },
    transaction: { hash: options.txHash ?? hash(0xaa) },
    params: {
      passportId: options.id,
      creator: options.creator ?? CREATOR,
      generatorAgentId: options.agentId ?? AGENT_ID,
      parentId: options.parentId ?? ZERO_BYTES32,
      phash: 42n,
      blockhash256: hash(0xbb),
      manifestHash: hash(0xcc),
      kind: options.parentId === undefined ? 0n : 2n,
      fingerprintVersion: 1n,
      metadataURI: "ipfs://passport",
    },
  };
}

describe("Moolam indexer handlers", () => {
  it("records an original passport as its own root at depth zero", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);

    await indexer.process({
      chains: { [CHAIN]: { simulate: [registration({ id })] } },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.root_id).toBe(id);
    expect(passport.depth).toBe(0);
    expect(passport.parent_id).toBeUndefined();
    expect(passport.owner).toBe(CREATOR);
    expect(passport.creator_id).toBe(CREATOR);
    expect(passport.generator_id).toBe(AGENT_ID.toString());
    expect(passport.disputed).toBe(false);
    expect(passport.attestationCount).toBe(0);
    expect(passport.registeredAt).toBe(BigInt(DAY_ONE));

    const creator = await indexer.Creator.getOrThrow(CREATOR);
    expect(creator.passportCount).toBe(1);
    expect(creator.editCount).toBe(0);

    // A generator nobody has rechecked yet sits at the neutral 50, not at 100.
    const generator = await indexer.Generator.getOrThrow(AGENT_ID.toString());
    expect(generator.passportCount).toBe(1);
    expect(generator.trustScore).toBe(50);
  });

  it("keeps the original as the root all the way down a two level edit chain", async () => {
    const indexer = createTestIndexer();
    const root = hash(1);
    const firstEdit = hash(2);
    const secondEdit = hash(3);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id: root, blockNumber: 100 }),
            registration({ id: firstEdit, parentId: root, blockNumber: 101 }),
            registration({ id: secondEdit, parentId: firstEdit, blockNumber: 102 }),
          ],
        },
      },
    });

    const first = await indexer.Passport.getOrThrow(firstEdit);
    expect(first.parent_id).toBe(root);
    expect(first.root_id).toBe(root);
    expect(first.depth).toBe(1);

    const second = await indexer.Passport.getOrThrow(secondEdit);
    expect(second.parent_id).toBe(firstEdit);
    expect(second.root_id).toBe(root);
    expect(second.depth).toBe(2);

    const creator = await indexer.Creator.getOrThrow(CREATOR);
    expect(creator.passportCount).toBe(3);
    expect(creator.editCount).toBe(2);

    const day = await indexer.DailyStats.getOrThrow("2026-01-15");
    expect(day.registrations).toBe(3);
    expect(day.edits).toBe(2);
  });

  it("moves the passport and the generator on a matched then a mismatched attestation", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);
    const attestationTx = hash(0xdd);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            {
              contract: "MoolamRegistry",
              event: "VerificationAttested",
              block: { number: 101, timestamp: DAY_ONE },
              transaction: { hash: attestationTx },
              logIndex: 0,
              params: {
                passportId: id,
                receiver: RECEIVER,
                matched: true,
                distance: 0n,
                recomputed: hash(0xee),
              },
            },
            {
              contract: "MoolamRegistry",
              event: "VerificationAttested",
              block: { number: 102, timestamp: DAY_ONE },
              transaction: { hash: attestationTx },
              logIndex: 1,
              params: {
                passportId: id,
                receiver: RECEIVER,
                matched: false,
                distance: 19n,
                recomputed: hash(0xef),
              },
            },
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.attestationCount).toBe(2);
    expect(passport.matchedCount).toBe(1);
    expect(passport.mismatchedCount).toBe(1);

    // One matched and one mismatched leaves the smoothed score back at 50:
    // 100 * (1 + 1) / (1 + 1 + 0 + 2).
    const generator = await indexer.Generator.getOrThrow(AGENT_ID.toString());
    expect(generator.matchedCount).toBe(1);
    expect(generator.mismatchedCount).toBe(1);
    expect(generator.trustScore).toBe(50);

    const mismatch = await indexer.Attestation.getOrThrow(`${attestationTx}-1`);
    expect(mismatch.matched).toBe(false);
    expect(mismatch.distance).toBe(19);
    expect(mismatch.passport_id).toBe(id);
    expect(mismatch.receiver).toBe(RECEIVER);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.attestations).toBe(2);
  });

  it("marks the passport and drops the generator score when a challenge is upheld", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            {
              contract: "MoolamRegistry",
              event: "VerificationAttested",
              block: { number: 101, timestamp: DAY_ONE },
              transaction: { hash: hash(0xdd) },
              logIndex: 0,
              params: {
                passportId: id,
                receiver: RECEIVER,
                matched: true,
                distance: 0n,
                recomputed: hash(0xee),
              },
            },
            {
              contract: "MoolamRegistry",
              event: "PassportFlagged",
              block: { number: 102, timestamp: DAY_ONE },
              transaction: { hash: hash(0xf1) },
              params: {
                passportId: id,
                challenger: CHALLENGER,
                bond: 1_000_000_000_000_000_000n,
                evidenceHash: hash(0xf2),
                evidenceURI: "ipfs://evidence",
              },
            },
            {
              contract: "MoolamRegistry",
              event: "DisputeResolved",
              block: { number: 103, timestamp: DAY_ONE },
              transaction: { hash: hash(0xf3) },
              params: { passportId: id, upheld: true, resolver: RESOLVER },
            },
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.disputed).toBe(true);
    expect(passport.dispute_id).toBe(id);

    const dispute = await indexer.Dispute.getOrThrow(id);
    expect(dispute.status).toBe(2); // DisputeStatus.Upheld
    expect(dispute.challenger).toBe(CHALLENGER);
    expect(dispute.resolver).toBe(RESOLVER);
    expect(dispute.resolvedAt).toBe(BigInt(DAY_ONE));

    // One matched recheck against one upheld challenge, which counts double:
    // 100 * (1 + 1) / (1 + 0 + 2 + 2) rounds to 33.
    const generator = await indexer.Generator.getOrThrow(AGENT_ID.toString());
    expect(generator.disputesUpheld).toBe(1);
    expect(generator.trustScore).toBe(33);

    const day = await indexer.DailyStats.getOrThrow("2026-01-15");
    expect(day.disputes).toBe(1);
  });

  it("changes the owner on a sale and never the creator", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);
    const tokenId = BigInt(id);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            // The mint that comes with every registration. It must not create a
            // second passport or move any counter.
            {
              contract: "MoolamRegistry",
              event: "Transfer",
              block: { number: 100, timestamp: DAY_ONE },
              transaction: { hash: hash(0xaa) },
              params: { from: ZERO_ADDRESS, to: CREATOR, tokenId },
            },
            {
              contract: "MoolamRegistry",
              event: "Transfer",
              block: { number: 200, timestamp: DAY_TWO },
              transaction: { hash: hash(0xab) },
              params: { from: CREATOR, to: BUYER, tokenId },
            },
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.owner).toBe(BUYER);
    expect(passport.creator_id).toBe(CREATOR);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.passports).toBe(1);

    const day = await indexer.DailyStats.getOrThrow("2026-01-15");
    expect(day.registrations).toBe(1);
  });

  it("creates the creator and records the key when a passkey is bound", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "MoolamRegistry",
              event: "PasskeyBound",
              block: { number: 99, timestamp: DAY_ONE },
              transaction: { hash: hash(0xa9) },
              params: {
                wallet: CREATOR,
                qx: hash(0x11),
                qy: hash(0x12),
                nonce: 0n,
              },
            },
          ],
        },
      },
    });

    const passkey = await indexer.Passkey.getOrThrow(CREATOR);
    expect(passkey.qx).toBe(hash(0x11));
    expect(passkey.qy).toBe(hash(0x12));
    expect(passkey.nonce).toBe(0n);
    expect(passkey.boundAt).toBe(BigInt(DAY_ONE));

    const creator = await indexer.Creator.getOrThrow(CREATOR);
    expect(creator.passkey_id).toBe(CREATOR);
    expect(creator.passportCount).toBe(0);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.creators).toBe(1);
  });

  it("splits the daily counters by UTC day while the global totals keep adding up", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id: hash(1), blockNumber: 100, timestamp: DAY_ONE }),
            registration({
              id: hash(2),
              blockNumber: 200,
              timestamp: DAY_TWO,
              creator: OTHER_CREATOR,
            }),
          ],
        },
      },
    });

    const first = await indexer.DailyStats.getOrThrow("2026-01-15");
    expect(first.registrations).toBe(1);
    expect(first.uniqueCreators).toBe(1);

    const second = await indexer.DailyStats.getOrThrow("2026-01-16");
    expect(second.registrations).toBe(1);
    expect(second.uniqueCreators).toBe(1);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.passports).toBe(2);
    expect(global.creators).toBe(2);
    // Both passports name the same generating agent, so it is counted once.
    expect(global.generators).toBe(1);
  });
});
