import { indexer } from "envio";

import { summaryOf } from "./consent.js";
import { bumpDaily, bumpGlobal, markCreatorActive } from "./day.js";
import {
  addressId,
  attestationId,
  consentEntryId,
  generatorId,
  parentPassportId,
  passportId,
  passportIdFromTokenId,
} from "./ids.js";
import { descendantsOf, treePosition } from "./tree.js";
import { trustScore } from "./trust.js";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

// Mirrors the DisputeStatus enum in packages/contracts/src/interfaces/IMoolamRegistry.sol.
// None is 0 and never reaches the index, because a row only exists once a
// challenge has been raised.
const DISPUTE_OPEN = 1;
const DISPUTE_UPHELD = 2;
const DISPUTE_REJECTED = 3;

indexer.onEvent(
  { contract: "MoolamRegistry", event: "PasskeyBound" },
  async ({ event, context }) => {
    const wallet = addressId(event.params.wallet);
    const existing = await context.Creator.get(wallet);
    const boundAt = BigInt(event.block.timestamp);

    // The passkey is keyed by wallet, so rebinding overwrites the old key and the
    // nonce moves forward. Only the current key can ever sign a registration, so
    // keeping the superseded one would only invite someone to verify against it.
    context.Passkey.set({
      id: wallet,
      qx: event.params.qx,
      qy: event.params.qy,
      nonce: event.params.nonce,
      boundAt,
    });

    if (existing === undefined) {
      context.Creator.set({
        id: wallet,
        passportCount: 0,
        editCount: 0,
        passkey_id: wallet,
        firstSeenAt: boundAt,
      });
      await bumpGlobal(context, { creators: 1 });
      return;
    }

    context.Creator.set({ ...existing, passkey_id: wallet });
  },
);

indexer.onEvent(
  { contract: "MoolamRegistry", event: "PassportRegistered" },
  async ({ event, context }) => {
    const id = passportId(event.params.passportId);
    const creatorId = addressId(event.params.creator);
    const parentId = parentPassportId(event.params.parentId);
    const agentId = generatorId(event.params.generatorAgentId);

    // All three reads go out together so the preload phase can batch them into
    // one query per entity across the whole event batch.
    const [existingCreator, parent, existingGenerator] = await Promise.all([
      context.Creator.get(creatorId),
      parentId === undefined
        ? Promise.resolve(undefined)
        : context.Passport.get(parentId),
      agentId === undefined
        ? Promise.resolve(undefined)
        : context.Generator.get(agentId),
    ]);

    const registeredAt = BigInt(event.block.timestamp);
    const position = treePosition(id, parent);
    const isEdit = parentId !== undefined;

    context.Passport.set({
      id,
      creator_id: creatorId,
      parent_id: parentId,
      root_id: position.rootId,
      depth: position.depth,
      generator_id: agentId,
      kind: Number(event.params.kind),
      phash: event.params.phash,
      blockhash: event.params.blockhash256,
      manifestHash: event.params.manifestHash,
      fingerprintVersion: Number(event.params.fingerprintVersion),
      metadataURI: event.params.metadataURI,
      // register mints to p.creator and appendEdit mints to the parent owner,
      // which the registry forces to equal p.creator. So the first owner is
      // always the creator, and only a later Transfer moves it.
      owner: creatorId,
      registeredAt,
      registeredBlock: BigInt(event.block.number),
      txHash: event.transaction.hash,
      disputed: false,
      // An original starts clean. An edit carries whatever its parent already
      // carries, so one lookup is enough however long the chain is.
      inheritedDisputed:
        parent !== undefined && (parent.disputed || parent.inheritedDisputed),
      attestationCount: 0,
      matchedCount: 0,
      mismatchedCount: 0,
      dispute_id: undefined,
      // A new passport has said nothing about AI use. consentSummary reads "none"
      // from the start so a caller can filter on one field without special casing
      // a null, and consentStated is what tells them the silence is silence and
      // not a holder who chose it.
      consentStated: false,
      consentSummary: "none",
      consentAiTraining: 0,
      consentAiGenerativeTraining: 0,
      consentAiInference: 0,
      consentDataMining: 0,
      consentInfo: "",
      consentAt: undefined,
      consentWriter: undefined,
      consentCount: 0,
    });

    if (existingCreator === undefined) {
      context.Creator.set({
        id: creatorId,
        passportCount: 1,
        editCount: isEdit ? 1 : 0,
        passkey_id: undefined,
        firstSeenAt: registeredAt,
      });
    } else {
      context.Creator.set({
        ...existingCreator,
        passportCount: existingCreator.passportCount + 1,
        editCount: existingCreator.editCount + (isEdit ? 1 : 0),
      });
    }

    if (agentId !== undefined) {
      if (existingGenerator === undefined) {
        context.Generator.set({
          id: agentId,
          passportCount: 1,
          matchedCount: 0,
          mismatchedCount: 0,
          disputesUpheld: 0,
          trustScore: trustScore(0, 0, 0),
          firstSeenAt: registeredAt,
        });
      } else {
        context.Generator.set({
          ...existingGenerator,
          passportCount: existingGenerator.passportCount + 1,
        });
      }
    }

    const firstTodayForCreator = await markCreatorActive(
      context,
      event.block.timestamp,
      creatorId,
    );

    await bumpDaily(context, event.block.timestamp, {
      registrations: 1,
      edits: isEdit ? 1 : 0,
      uniqueCreators: firstTodayForCreator ? 1 : 0,
    });
    await bumpGlobal(context, {
      passports: 1,
      creators: existingCreator === undefined ? 1 : 0,
      generators: agentId !== undefined && existingGenerator === undefined ? 1 : 0,
    });
  },
);

indexer.onEvent(
  { contract: "MoolamRegistry", event: "VerificationAttested" },
  async ({ event, context }) => {
    const targetId = passportId(event.params.passportId);
    const passport = await context.Passport.get(targetId);

    if (passport === undefined) {
      context.log.warn("Attestation for a passport this index has not seen", {
        passportId: targetId,
      });
      return;
    }

    // The generator can only be read once the passport says which one it is, so
    // this one lookup cannot join the batch above.
    const generator =
      passport.generator_id === undefined
        ? undefined
        : await context.Generator.get(passport.generator_id);

    const matched = event.params.matched;

    context.Attestation.set({
      id: attestationId(event.transaction.hash, event.logIndex),
      passport_id: targetId,
      receiver: addressId(event.params.receiver),
      matched,
      distance: Number(event.params.distance),
      recomputed: event.params.recomputed,
      at: BigInt(event.block.timestamp),
    });

    context.Passport.set({
      ...passport,
      attestationCount: passport.attestationCount + 1,
      matchedCount: passport.matchedCount + (matched ? 1 : 0),
      mismatchedCount: passport.mismatchedCount + (matched ? 0 : 1),
    });

    if (generator !== undefined) {
      const matchedCount = generator.matchedCount + (matched ? 1 : 0);
      const mismatchedCount = generator.mismatchedCount + (matched ? 0 : 1);
      context.Generator.set({
        ...generator,
        matchedCount,
        mismatchedCount,
        trustScore: trustScore(matchedCount, mismatchedCount, generator.disputesUpheld),
      });
    }

    await bumpDaily(context, event.block.timestamp, { attestations: 1 });
    await bumpGlobal(context, { attestations: 1 });
  },
);

indexer.onEvent(
  { contract: "MoolamRegistry", event: "PassportFlagged" },
  async ({ event, context }) => {
    const targetId = passportId(event.params.passportId);
    const passport = await context.Passport.get(targetId);

    if (passport === undefined) {
      context.log.warn("Flag against a passport this index has not seen", {
        passportId: targetId,
      });
      return;
    }

    // One dispute row per passport, keyed by the passport id, which is what the
    // frontend reads. A passport whose challenge was rejected can be flagged
    // again and the new challenge replaces the old row.
    context.Dispute.set({
      id: targetId,
      passport_id: targetId,
      challenger: addressId(event.params.challenger),
      bond: event.params.bond,
      evidenceHash: event.params.evidenceHash,
      evidenceURI: event.params.evidenceURI,
      status: DISPUTE_OPEN,
      openedAt: BigInt(event.block.timestamp),
      resolvedAt: undefined,
      resolver: undefined,
    });

    context.Passport.set({ ...passport, dispute_id: targetId });

    // The counters count challenges raised, so a second challenge against the
    // same passport counts again even though it reuses the row.
    await bumpDaily(context, event.block.timestamp, { disputes: 1 });
    await bumpGlobal(context, { disputes: 1 });
  },
);

indexer.onEvent(
  { contract: "MoolamRegistry", event: "DisputeResolved" },
  async ({ event, context }) => {
    const targetId = passportId(event.params.passportId);
    const [passport, dispute] = await Promise.all([
      context.Passport.get(targetId),
      context.Dispute.get(targetId),
    ]);

    if (dispute === undefined) {
      context.log.warn("Resolution for a dispute this index has not seen", {
        passportId: targetId,
      });
      return;
    }

    const upheld = event.params.upheld;

    context.Dispute.set({
      ...dispute,
      status: upheld ? DISPUTE_UPHELD : DISPUTE_REJECTED,
      resolvedAt: BigInt(event.block.timestamp),
      resolver: addressId(event.params.resolver),
    });

    // Only an upheld challenge marks the passport, which is what the registry
    // itself does in resolve().
    if (!upheld || passport === undefined) {
      return;
    }

    context.Passport.set({ ...passport, disputed: true, inheritedDisputed: true });

    // The registry marks only the passport the challenge named. Every edit made
    // from it is still a copy of a picture proven fake, so the mark travels down
    // the tree here: one indexed query for the whole tree, then a walk down the
    // parent links inside it.
    const family = await context.Passport.getWhere({
      root_id: { _eq: passport.root_id },
    });
    for (const descendant of descendantsOf(passport, family)) {
      if (descendant.inheritedDisputed) {
        continue;
      }
      context.Passport.set({ ...descendant, inheritedDisputed: true });
    }

    if (passport.generator_id === undefined) {
      return;
    }

    const generator = await context.Generator.get(passport.generator_id);
    if (generator === undefined) {
      return;
    }

    const disputesUpheld = generator.disputesUpheld + 1;
    context.Generator.set({
      ...generator,
      disputesUpheld,
      trustScore: trustScore(
        generator.matchedCount,
        generator.mismatchedCount,
        disputesUpheld,
      ),
    });
  },
);

indexer.onEvent(
  { contract: "MoolamRegistry", event: "Transfer" },
  async ({ event, context }) => {
    // A transfer out of the zero address is the mint that goes with a
    // registration. PassportRegistered already wrote the owner, so counting this
    // would register the same passport twice.
    if (addressId(event.params.from) === ZERO_ADDRESS) {
      return;
    }

    const targetId = passportIdFromTokenId(event.params.tokenId);
    const passport = await context.Passport.get(targetId);

    if (passport === undefined) {
      context.log.warn("Transfer of a token this index has not seen", {
        passportId: targetId,
      });
      return;
    }

    // Owner moves, creator never does. Who made the image is a fact about the
    // past and no sale can rewrite it.
    context.Passport.set({ ...passport, owner: addressId(event.params.to) });
  },
);

indexer.onEvent(
  { contract: "VerifierPolicy", event: "ReceiverAdded" },
  async ({ event, context }) => {
    // "since" is when the current state started, so it moves on every change.
    context.Receiver.set({
      id: addressId(event.params.receiver),
      active: true,
      since: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "VerifierPolicy", event: "ReceiverRemoved" },
  async ({ event, context }) => {
    context.Receiver.set({
      id: addressId(event.params.receiver),
      active: false,
      since: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "MoolamConsent", event: "ConsentSet" },
  async ({ event, context }) => {
    const targetId = passportId(event.params.passportId);
    const passport = await context.Passport.get(targetId);

    if (passport === undefined) {
      // The register asks the registry who holds a passport before it writes, so
      // this means the index is behind its own chain, not that the statement is
      // wrong. Dropping the event is better than inventing a passport row that
      // PassportRegistered would then overwrite with its defaults.
      context.log.warn("Consent for a passport this index has not seen", {
        passportId: targetId,
      });
      return;
    }

    const aiTraining = Number(event.params.consent.aiTraining);
    const aiGenerativeTraining = Number(event.params.consent.aiGenerativeTraining);
    const aiInference = Number(event.params.consent.aiInference);
    const dataMining = Number(event.params.consent.dataMining);
    const summary = summaryOf(aiTraining, aiGenerativeTraining, aiInference, dataMining);

    if (summary === null) {
      context.log.warn("Consent naming a use outside the contract's enum", {
        passportId: targetId,
        consent: [aiTraining, aiGenerativeTraining, aiInference, dataMining].join(","),
      });
      return;
    }

    const index = Number(event.params.index);
    const at = event.params.at;
    // The statement's author is in the event, never in the transaction. A holder
    // with a passkey wallet writes through the ERC-4337 EntryPoint, so the
    // transaction's sender is a bundler that has nothing to do with the picture.
    const writer = addressId(event.params.writer);
    const constraintInfo = event.params.constraintInfo;

    context.ConsentEntry.set({
      id: consentEntryId(targetId, index),
      passport_id: targetId,
      index,
      writer,
      aiTraining,
      aiGenerativeTraining,
      aiInference,
      dataMining,
      summary,
      constraintInfo,
      at,
      txHash: event.transaction.hash,
    });

    // Events reach a handler in chain order, so an index below the count is a
    // block being replayed. Its entry row was just rewritten as itself; the
    // headline, the count and the counters have already taken it in once and
    // must not take it in again.
    if (index < passport.consentCount) {
      return;
    }

    const firstStatement = passport.consentCount === 0;

    context.Passport.set({
      ...passport,
      consentStated: true,
      consentSummary: summary,
      consentAiTraining: aiTraining,
      consentAiGenerativeTraining: aiGenerativeTraining,
      consentAiInference: aiInference,
      consentDataMining: dataMining,
      consentInfo: constraintInfo,
      consentAt: at,
      consentWriter: writer,
      consentCount: passport.consentCount + 1,
    });

    await bumpDaily(context, event.block.timestamp, { consentStatements: 1 });
    // A holder who restates adds to the statements but not to the pictures that
    // carry one, so the two global counters answer different questions.
    await bumpGlobal(context, {
      consentStatements: 1,
      passportsWithConsent: firstStatement ? 1 : 0,
    });
  },
);
