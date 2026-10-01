// Handler behaviour, driven through Envio's own test indexer with simulated
// events instead of a live chain.
//
// NOT COVERED HERE: anything below the handlers. These tests do not check that
// config.yaml decodes the real ABIs, they do not run against Monad, and they do
// not exercise reorg handling or the GraphQL layer. Every assertion below is
// about what the handlers write, not about what the registry contract enforces,
// which is covered by the Foundry tests in packages/contracts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const CHAIN = 143;

// config.yaml starts the index at the block the contracts were deployed in, and
// a simulated event before that block is filtered out before any handler runs.
// Every block number below is an offset from the deploy block for that reason.
const DEPLOY_BLOCK = 103054771;

// The consent register was deployed months later and carries its own start block,
// so a simulated statement has to sit above this one to reach its handler.
const CONSENT_BLOCK = 105828247;

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
const HOLDER = "0x7777777777777777777777777777777777777777" as const;

const AGENT_ID = 7n;

// The contract's Use enum, 0 to 3.
const UNSPECIFIED = 0n;
const ALLOWED = 1n;
const NOT_ALLOWED = 2n;
const CONSTRAINED = 3n;

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
      number: options.blockNumber ?? DEPLOY_BLOCK + 100,
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

function transfer(options: {
  id: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  blockNumber: number;
  timestamp?: number;
}) {
  return {
    contract: "MoolamRegistry" as const,
    event: "Transfer" as const,
    block: { number: options.blockNumber, timestamp: options.timestamp ?? DAY_TWO },
    transaction: { hash: hash(options.blockNumber) },
    params: { from: options.from, to: options.to, tokenId: BigInt(options.id) },
  };
}

function statement(options: {
  id: `0x${string}`;
  uses: readonly [bigint, bigint, bigint, bigint];
  index?: number;
  writer?: `0x${string}`;
  constraintInfo?: string;
  timestamp?: number;
  blockNumber?: number;
  txHash?: string;
  logIndex?: number;
}) {
  const at = options.timestamp ?? DAY_ONE;
  return {
    contract: "MoolamConsent" as const,
    event: "ConsentSet" as const,
    block: { number: options.blockNumber ?? CONSENT_BLOCK + 10, timestamp: at },
    transaction: { hash: options.txHash ?? hash(0xc1) },
    logIndex: options.logIndex ?? 0,
    params: {
      passportId: options.id,
      writer: options.writer ?? HOLDER,
      index: BigInt(options.index ?? 0),
      consent: {
        aiTraining: options.uses[0],
        aiGenerativeTraining: options.uses[1],
        aiInference: options.uses[2],
        dataMining: options.uses[3],
      },
      constraintInfo: options.constraintInfo ?? "",
      at: BigInt(at),
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
            registration({ id: root, blockNumber: DEPLOY_BLOCK + 100 }),
            registration({ id: firstEdit, parentId: root, blockNumber: DEPLOY_BLOCK + 101 }),
            registration({ id: secondEdit, parentId: firstEdit, blockNumber: DEPLOY_BLOCK + 102 }),
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
              block: { number: DEPLOY_BLOCK + 101, timestamp: DAY_ONE },
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
              block: { number: DEPLOY_BLOCK + 102, timestamp: DAY_ONE },
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
              block: { number: DEPLOY_BLOCK + 101, timestamp: DAY_ONE },
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
              block: { number: DEPLOY_BLOCK + 102, timestamp: DAY_ONE },
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
              block: { number: DEPLOY_BLOCK + 103, timestamp: DAY_ONE },
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
    // 100 * (1 + 1) / (1 + 0 + 2 + 2) is 40, down from the 50 it started at.
    const generator = await indexer.Generator.getOrThrow(AGENT_ID.toString());
    expect(generator.disputesUpheld).toBe(1);
    expect(generator.trustScore).toBe(40);

    const day = await indexer.DailyStats.getOrThrow("2026-01-15");
    expect(day.disputes).toBe(1);
  });

  it("registers an original and a clean edit with no inherited dispute", async () => {
    const indexer = createTestIndexer();
    const root = hash(1);
    const edit = hash(2);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id: root, blockNumber: DEPLOY_BLOCK + 100 }),
            registration({ id: edit, parentId: root, blockNumber: DEPLOY_BLOCK + 101 }),
          ],
        },
      },
    });

    expect((await indexer.Passport.getOrThrow(root)).inheritedDisputed).toBe(false);
    expect((await indexer.Passport.getOrThrow(edit)).inheritedDisputed).toBe(false);
  });

  it("gives an edit made after its parent lost a challenge the inherited mark", async () => {
    const indexer = createTestIndexer();
    const root = hash(1);
    const edit = hash(2);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id: root, blockNumber: DEPLOY_BLOCK + 100 }),
            {
              contract: "MoolamRegistry",
              event: "PassportFlagged",
              block: { number: DEPLOY_BLOCK + 101, timestamp: DAY_ONE },
              transaction: { hash: hash(0xf1) },
              params: {
                passportId: root,
                challenger: CHALLENGER,
                bond: 1_000_000_000_000_000_000n,
                evidenceHash: hash(0xf2),
                evidenceURI: "ipfs://evidence",
              },
            },
            {
              contract: "MoolamRegistry",
              event: "DisputeResolved",
              block: { number: DEPLOY_BLOCK + 102, timestamp: DAY_ONE },
              transaction: { hash: hash(0xf3) },
              params: { passportId: root, upheld: true, resolver: RESOLVER },
            },
            registration({ id: edit, parentId: root, blockNumber: DEPLOY_BLOCK + 103 }),
          ],
        },
      },
    });

    // The registry accepts this edit and stores it clean, because it only ever
    // marks the passport a challenge named. The index is what carries the fact
    // that the picture it was made from was proven fake.
    const child = await indexer.Passport.getOrThrow(edit);
    expect(child.disputed).toBe(false);
    expect(child.inheritedDisputed).toBe(true);
  });

  it("marks every edit already made from a passport when its challenge is upheld", async () => {
    const indexer = createTestIndexer();
    const root = hash(1);
    const branch = hash(2);
    const grandchild = hash(3);
    const sibling = hash(4);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id: root, blockNumber: DEPLOY_BLOCK + 100 }),
            registration({ id: branch, parentId: root, blockNumber: DEPLOY_BLOCK + 101 }),
            registration({ id: grandchild, parentId: branch, blockNumber: DEPLOY_BLOCK + 102 }),
            registration({ id: sibling, parentId: root, blockNumber: DEPLOY_BLOCK + 103 }),
            {
              contract: "MoolamRegistry",
              event: "PassportFlagged",
              block: { number: DEPLOY_BLOCK + 104, timestamp: DAY_ONE },
              transaction: { hash: hash(0xf1) },
              params: {
                passportId: branch,
                challenger: CHALLENGER,
                bond: 1_000_000_000_000_000_000n,
                evidenceHash: hash(0xf2),
                evidenceURI: "ipfs://evidence",
              },
            },
            {
              contract: "MoolamRegistry",
              event: "DisputeResolved",
              block: { number: DEPLOY_BLOCK + 105, timestamp: DAY_ONE },
              transaction: { hash: hash(0xf3) },
              params: { passportId: branch, upheld: true, resolver: RESOLVER },
            },
          ],
        },
      },
    });

    const disputed = await indexer.Passport.getOrThrow(branch);
    expect(disputed.disputed).toBe(true);
    expect(disputed.inheritedDisputed).toBe(true);

    expect((await indexer.Passport.getOrThrow(grandchild)).inheritedDisputed).toBe(true);
    expect((await indexer.Passport.getOrThrow(grandchild)).disputed).toBe(false);

    // The mark travels down the edit chain, never up it and never sideways: the
    // original and the other edit made from it are untouched.
    expect((await indexer.Passport.getOrThrow(root)).inheritedDisputed).toBe(false);
    expect((await indexer.Passport.getOrThrow(sibling)).inheritedDisputed).toBe(false);
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
              block: { number: DEPLOY_BLOCK + 100, timestamp: DAY_ONE },
              transaction: { hash: hash(0xaa) },
              params: { from: ZERO_ADDRESS, to: CREATOR, tokenId },
            },
            {
              contract: "MoolamRegistry",
              event: "Transfer",
              block: { number: DEPLOY_BLOCK + 200, timestamp: DAY_TWO },
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

  it("writes no first handover for the mint that comes with a registration", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            transfer({ id, from: ZERO_ADDRESS, to: CREATOR, blockNumber: DEPLOY_BLOCK + 100, timestamp: DAY_ONE }),
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.firstTransferTo).toBeUndefined();
    expect(passport.firstTransferAt).toBeUndefined();
    expect(passport.firstTransferBlock).toBeUndefined();
  });

  it("records the first handover out of the creator's wallet, lowercase", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);
    const checksummedBuyer = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as const;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            transfer({ id, from: CREATOR, to: checksummedBuyer, blockNumber: DEPLOY_BLOCK + 200 }),
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.firstTransferTo).toBe(checksummedBuyer.toLowerCase());
    expect(passport.firstTransferAt).toBe(BigInt(DAY_TWO));
    expect(passport.firstTransferBlock).toBe(BigInt(DEPLOY_BLOCK + 200));
  });

  it("keeps the first handover when the first recipient sells it on", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            transfer({ id, from: CREATOR, to: BUYER, blockNumber: DEPLOY_BLOCK + 200 }),
            transfer({ id, from: BUYER, to: HOLDER, blockNumber: DEPLOY_BLOCK + 300 }),
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.owner).toBe(HOLDER);
    expect(passport.firstTransferTo).toBe(BUYER);
    expect(passport.firstTransferBlock).toBe(BigInt(DEPLOY_BLOCK + 200));
  });

  it("keeps the first handover when the passport comes back to the creator and goes out again", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            // Sending to itself hands the picture to nobody, so it is not the handover.
            transfer({ id, from: CREATOR, to: CREATOR, blockNumber: DEPLOY_BLOCK + 150 }),
            transfer({ id, from: CREATOR, to: BUYER, blockNumber: DEPLOY_BLOCK + 200 }),
            transfer({ id, from: BUYER, to: CREATOR, blockNumber: DEPLOY_BLOCK + 300 }),
            transfer({ id, from: CREATOR, to: HOLDER, blockNumber: DEPLOY_BLOCK + 400 }),
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.owner).toBe(HOLDER);
    expect(passport.firstTransferTo).toBe(BUYER);
    expect(passport.firstTransferBlock).toBe(BigInt(DEPLOY_BLOCK + 200));
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
              block: { number: DEPLOY_BLOCK + 99, timestamp: DAY_ONE },
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
            registration({ id: hash(1), blockNumber: DEPLOY_BLOCK + 100, timestamp: DAY_ONE }),
            registration({ id: hash(2), blockNumber: DEPLOY_BLOCK + 101, timestamp: DAY_ONE }),
            registration({
              id: hash(3),
              blockNumber: DEPLOY_BLOCK + 200,
              timestamp: DAY_TWO,
              creator: OTHER_CREATOR,
            }),
          ],
        },
      },
    });

    // Two registrations from the same wallet on day one, so the day counts two
    // registrations and one creator active.
    const first = await indexer.DailyStats.getOrThrow("2026-01-15");
    expect(first.registrations).toBe(2);
    expect(first.uniqueCreators).toBe(1);

    const second = await indexer.DailyStats.getOrThrow("2026-01-16");
    expect(second.registrations).toBe(1);
    expect(second.uniqueCreators).toBe(1);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.passports).toBe(3);
    expect(global.creators).toBe(2);
    // Every passport names the same generating agent, so it is counted once.
    expect(global.generators).toBe(1);
  });

  it("records a verifier the policy allows as an active receiver", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "VerifierPolicy",
              event: "ReceiverAdded",
              block: { number: DEPLOY_BLOCK + 90, timestamp: DAY_ONE },
              transaction: { hash: hash(0xb1) },
              params: { receiver: RECEIVER },
            },
          ],
        },
      },
    });

    const receiver = await indexer.Receiver.getOrThrow(RECEIVER);
    expect(receiver.active).toBe(true);
    expect(receiver.since).toBe(BigInt(DAY_ONE));
  });

  it("keeps the receiver row and marks it inactive when the policy removes it", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "VerifierPolicy",
              event: "ReceiverAdded",
              block: { number: DEPLOY_BLOCK + 90, timestamp: DAY_ONE },
              transaction: { hash: hash(0xb1) },
              params: { receiver: RECEIVER },
            },
            {
              contract: "VerifierPolicy",
              event: "ReceiverRemoved",
              block: { number: DEPLOY_BLOCK + 200, timestamp: DAY_TWO },
              transaction: { hash: hash(0xb2) },
              params: { receiver: RECEIVER },
            },
          ],
        },
      },
    });

    // The row stays so old attestations still name a receiver the API knows.
    // "since" moves to the removal, because it is when the current state started.
    const receiver = await indexer.Receiver.getOrThrow(RECEIVER);
    expect(receiver.active).toBe(false);
    expect(receiver.since).toBe(BigInt(DAY_TWO));
  });
});

/** One ConsentSet log as it came off Monad, saved in test/fixtures. */
interface RecordedStatement {
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  logIndex: number;
  passportId: `0x${string}`;
  writer: `0x${string}`;
  index: number;
  consent: {
    aiTraining: number;
    aiGenerativeTraining: number;
    aiInference: number;
    dataMining: number;
  };
  constraintInfo: string;
  at: number;
}

const RECORDED = JSON.parse(
  readFileSync(new URL("./fixtures/consent-events.json", import.meta.url), "utf8"),
) as RecordedStatement[];

describe("Moolam indexer consent handler", () => {
  it("writes the statement onto the passport and keeps it as its own entry", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);
    const statementTx = hash(0xc7);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            statement({
              id,
              uses: [ALLOWED, ALLOWED, ALLOWED, ALLOWED],
              txHash: statementTx,
              logIndex: 3,
            }),
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.consentStated).toBe(true);
    expect(passport.consentSummary).toBe("open");
    expect(passport.consentAiTraining).toBe(1);
    expect(passport.consentAiGenerativeTraining).toBe(1);
    expect(passport.consentAiInference).toBe(1);
    expect(passport.consentDataMining).toBe(1);
    expect(passport.consentInfo).toBe("");
    expect(passport.consentAt).toBe(BigInt(DAY_ONE));
    expect(passport.consentWriter).toBe(HOLDER);
    expect(passport.consentCount).toBe(1);

    const entry = await indexer.ConsentEntry.getOrThrow(`${id}-0`);
    expect(entry.passport_id).toBe(id);
    expect(entry.index).toBe(0);
    expect(entry.summary).toBe("open");
    expect(entry.writer).toBe(HOLDER);
    expect(entry.constraintInfo).toBe("");
    expect(entry.at).toBe(BigInt(DAY_ONE));
    expect(entry.txHash).toBe(statementTx);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.consentStatements).toBe(1);
    expect(global.passportsWithConsent).toBe(1);

    const day = await indexer.DailyStats.getOrThrow("2026-01-15");
    expect(day.consentStatements).toBe(1);
  });

  it("leaves a passport nobody has spoken for saying nothing rather than saying no", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);

    await indexer.process({
      chains: { [CHAIN]: { simulate: [registration({ id })] } },
    });

    // "none" is the summary either way, so consentStated is the only field that
    // separates a holder who chose silence from one who has not been asked.
    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.consentStated).toBe(false);
    expect(passport.consentSummary).toBe("none");
    expect(passport.consentCount).toBe(0);
    expect(passport.consentAt).toBeUndefined();
    expect(passport.consentWriter).toBeUndefined();
  });

  it("replaces the headline when the holder states again and still counts the picture once", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);
    const conditions = "Ask first: hello@example.com";

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            statement({ id, uses: [ALLOWED, ALLOWED, ALLOWED, ALLOWED], index: 0 }),
            statement({
              id,
              uses: [CONSTRAINED, CONSTRAINED, CONSTRAINED, CONSTRAINED],
              index: 1,
              constraintInfo: conditions,
              blockNumber: CONSENT_BLOCK + 20,
              timestamp: DAY_TWO,
            }),
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.consentSummary).toBe("ask");
    expect(passport.consentInfo).toBe(conditions);
    expect(passport.consentAt).toBe(BigInt(DAY_TWO));
    expect(passport.consentCount).toBe(2);

    // The statement it replaced is still on the chain and still here, because a
    // reader asking what was allowed last week needs the entry, not the headline.
    const first = await indexer.ConsentEntry.getOrThrow(`${id}-0`);
    expect(first.summary).toBe("open");
    expect(first.constraintInfo).toBe("");
    const second = await indexer.ConsentEntry.getOrThrow(`${id}-1`);
    expect(second.summary).toBe("ask");
    expect((await indexer.ConsentEntry.getAll()).length).toBe(2);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.consentStatements).toBe(2);
    expect(global.passportsWithConsent).toBe(1);
  });

  it("leaves the headline alone when an older statement is replayed", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            statement({ id, uses: [ALLOWED, ALLOWED, ALLOWED, ALLOWED], index: 0 }),
            statement({
              id,
              uses: [NOT_ALLOWED, NOT_ALLOWED, NOT_ALLOWED, NOT_ALLOWED],
              index: 1,
              blockNumber: CONSENT_BLOCK + 20,
              timestamp: DAY_TWO,
            }),
            // The first statement's block arriving a second time, which is what a
            // reorg replay looks like from inside a handler.
            statement({
              id,
              uses: [ALLOWED, ALLOWED, ALLOWED, ALLOWED],
              index: 0,
              blockNumber: CONSENT_BLOCK + 30,
              timestamp: DAY_TWO,
            }),
          ],
        },
      },
    });

    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.consentSummary).toBe("closed");
    expect(passport.consentAiTraining).toBe(2);
    expect(passport.consentAt).toBe(BigInt(DAY_TWO));

    // The replay rewrote entry zero as itself rather than adding a row, and
    // nothing that counts statements took it in a second time.
    expect((await indexer.ConsentEntry.getAll()).length).toBe(2);
    expect((await indexer.ConsentEntry.getOrThrow(`${id}-0`)).summary).toBe("open");
    expect(passport.consentCount).toBe(2);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.consentStatements).toBe(2);
    expect(global.passportsWithConsent).toBe(1);
  });

  it("ignores a statement about a passport it has not seen", async () => {
    const indexer = createTestIndexer();
    const known = hash(1);
    const stranger = hash(2);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id: known }),
            statement({ id: stranger, uses: [ALLOWED, ALLOWED, ALLOWED, ALLOWED] }),
          ],
        },
      },
    });

    expect(await indexer.Passport.get(stranger)).toBeUndefined();
    expect((await indexer.ConsentEntry.getAll()).length).toBe(0);
    expect((await indexer.Passport.getOrThrow(known)).consentStated).toBe(false);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.consentStatements).toBe(0);
    expect(global.passportsWithConsent).toBe(0);
  });

  it("ignores a statement naming a use the contract's enum does not define", async () => {
    const indexer = createTestIndexer();
    const id = hash(1);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id }),
            statement({ id, uses: [ALLOWED, ALLOWED, ALLOWED, 4n] }),
          ],
        },
      },
    });

    // Half a statement is worse than none: the index would rather say nothing was
    // stated than publish three permissions and guess at the fourth.
    const passport = await indexer.Passport.getOrThrow(id);
    expect(passport.consentStated).toBe(false);
    expect(passport.consentSummary).toBe("none");
    expect(passport.consentCount).toBe(0);
    expect((await indexer.ConsentEntry.getAll()).length).toBe(0);
    expect((await indexer.GlobalStats.getOrThrow("global")).consentStatements).toBe(0);
  });

  it("counts statements on the day they were made and pictures once across days", async () => {
    const indexer = createTestIndexer();
    const first = hash(1);
    const second = hash(2);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            registration({ id: first, blockNumber: DEPLOY_BLOCK + 100 }),
            registration({ id: second, blockNumber: DEPLOY_BLOCK + 101 }),
            statement({ id: first, uses: [ALLOWED, ALLOWED, ALLOWED, ALLOWED], index: 0 }),
            statement({
              id: second,
              uses: [UNSPECIFIED, UNSPECIFIED, ALLOWED, UNSPECIFIED],
              index: 0,
              blockNumber: CONSENT_BLOCK + 11,
            }),
            statement({
              id: first,
              uses: [NOT_ALLOWED, NOT_ALLOWED, NOT_ALLOWED, NOT_ALLOWED],
              index: 1,
              blockNumber: CONSENT_BLOCK + 20,
              timestamp: DAY_TWO,
            }),
          ],
        },
      },
    });

    expect((await indexer.DailyStats.getOrThrow("2026-01-15")).consentStatements).toBe(2);
    expect((await indexer.DailyStats.getOrThrow("2026-01-16")).consentStatements).toBe(1);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.consentStatements).toBe(3);
    expect(global.passportsWithConsent).toBe(2);

    // A holder who allows inference and says nothing about training has not
    // opened their picture to training, so the summary is mixed, not open.
    expect((await indexer.Passport.getOrThrow(second)).consentSummary).toBe("mixed");
  });

  it("replays the statements Monad already holds", async () => {
    // Every ConsentSet log the register has emitted, pulled from Monad mainnet by
    // eth_getLogs from the contract's own start block to the head and saved in
    // test/fixtures/consent-events.json. If the chain has moved on, the numbers
    // below are what needs updating, not the handler.
    expect(RECORDED.length).toBe(13);
    expect(new Set(RECORDED.map((event) => event.txHash)).size).toBe(5);

    const indexer = createTestIndexer();
    const passportIds = [...new Set(RECORDED.map((event) => event.passportId))];
    const firstStatementAt = Math.min(...RECORDED.map((event) => event.blockTimestamp));

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...passportIds.map((id, position) =>
              registration({
                id,
                blockNumber: CONSENT_BLOCK + 1 + position,
                timestamp: firstStatementAt - 3600,
              }),
            ),
            ...RECORDED.map((event) => ({
              contract: "MoolamConsent" as const,
              event: "ConsentSet" as const,
              block: { number: event.blockNumber, timestamp: event.blockTimestamp },
              transaction: { hash: event.txHash },
              logIndex: event.logIndex,
              params: {
                passportId: event.passportId,
                writer: event.writer,
                index: BigInt(event.index),
                consent: {
                  aiTraining: BigInt(event.consent.aiTraining),
                  aiGenerativeTraining: BigInt(event.consent.aiGenerativeTraining),
                  aiInference: BigInt(event.consent.aiInference),
                  dataMining: BigInt(event.consent.dataMining),
                },
                constraintInfo: event.constraintInfo,
                at: BigInt(event.at),
              },
            })),
          ],
        },
      },
    });

    const entries = await indexer.ConsentEntry.getAll();
    expect(entries.length).toBe(13);

    const summaries = entries.reduce<Record<string, number>>((tally, entry) => {
      tally[entry.summary] = (tally[entry.summary] ?? 0) + 1;
      return tally;
    }, {});
    expect(summaries).toEqual({ open: 5, closed: 5, ask: 3 });

    // The Monsoon picture, whose holder closed it to AI on 2026-09-18.
    const monsoon = await indexer.Passport.getOrThrow(
      "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638",
    );
    expect(monsoon.consentStated).toBe(true);
    expect(monsoon.consentSummary).toBe("closed");
    expect(monsoon.consentDataMining).toBe(2);

    // A conditional statement is only worth anything with the conditions beside
    // it, so every "ask" carries the words its holder wrote.
    for (const entry of entries.filter((row) => row.summary === "ask")) {
      expect(entry.constraintInfo).toBe(
        "Ask first: open an issue at https://github.com/ramakrishnanhulk20/Moolam/issues",
      );
      expect((await indexer.Passport.getOrThrow(entry.passport_id)).consentInfo).toBe(
        entry.constraintInfo,
      );
    }

    // Both statements of 2026-09-20 went through the ERC-4337 EntryPoint, so the
    // transaction was sent by a bundler and only the event names the holder.
    const passkeyWallet = "0xbb4eb7bf3e4e4960ee0c2f535bd31c84df35b6b2";
    const throughEntryPoint = await indexer.Passport.getOrThrow(
      "0x3dae5ee9d854d6af49857150873cefbe2df2a585e35ea86d34f0f47cb3b6403d",
    );
    expect(throughEntryPoint.consentWriter).toBe(passkeyWallet);
    expect(throughEntryPoint.consentSummary).toBe("open");

    // Every writer stored lowercase, the way every other address in this index is.
    for (const entry of entries) {
      expect(entry.writer).toBe(entry.writer.toLowerCase());
    }
    expect(new Set(entries.map((entry) => entry.writer)).size).toBe(2);

    const global = await indexer.GlobalStats.getOrThrow("global");
    expect(global.consentStatements).toBe(13);
    expect(global.passportsWithConsent).toBe(13);
    expect((await indexer.DailyStats.getOrThrow("2026-09-18")).consentStatements).toBe(11);
    expect((await indexer.DailyStats.getOrThrow("2026-09-20")).consentStatements).toBe(2);
  });
});
