import { describe, expect, it } from "vitest";
import type { ConsentDraft } from "@/lib/consent/call";
import { NOTHING_STATED } from "@/lib/chain/consent";
import {
  initialRegisterState,
  isBusy,
  isRegistered,
  isStating,
  isUnconfirmed,
  registerReducer,
  type RegisterState,
} from "@/lib/studio/flow";
import { NOTHING_TO_STATE, saysSomething, statedFrom, trainingFrom } from "@/lib/studio/consent";
import type { PrepareResponse } from "@/lib/verifier/client";

/**
 * The statement the studio makes about AI use, from the plates a creator
 * presses to the sub-state the receipt reads.
 *
 * What this file is really watching is the line between the two sends: a
 * statement that fails, is cancelled or never comes back must leave the
 * registration exactly as it was, because the passport is on chain either way.
 */

const CLOSED: ConsentDraft = {
  consent: {
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "notAllowed",
    dataMining: "notAllowed",
  },
  constraintInfo: "",
};

const ASK: ConsentDraft = {
  consent: {
    aiTraining: "constrained",
    aiGenerativeTraining: "constrained",
    aiInference: "constrained",
    dataMining: "constrained",
  },
  constraintInfo: "  ask hello@moolam.app  ",
};

const PREPARED = {
  passport: {
    exactHash: `0x${"ab".repeat(32)}`,
    parentId: `0x${"00".repeat(32)}`,
    generatorAgentId: "0",
    phash: "7840506850305415717",
    blockhash256: `0x${"11".repeat(32)}`,
    manifestHash: `0x${"22".repeat(32)}`,
    kind: 1,
    fingerprintVersion: 1,
    metadataURI: "ipfs://metadata",
  },
  image: { cid: "cid", uri: "ipfs://image", gatewayUrl: "https://gateway/image", bytes: 10, width: 4, height: 3 },
  thumbnail: { cid: "thumb", uri: "ipfs://thumb", gatewayUrl: "https://gateway/thumb" },
  metadata: { cid: "meta", uri: "ipfs://metadata" },
  manifest: { embedded: true },
  preparedBy: "did:privy:someone",
} as unknown as PrepareResponse;

/** A run that is registered and nothing more, which is where every statement starts. */
function registered(): RegisterState {
  let state = registerReducer(initialRegisterState, {
    type: "choose",
    file: new File(["x"], "p.jpg", { type: "image/jpeg" }),
  });
  state = registerReducer(state, { type: "title", title: "A morning" });
  state = registerReducer(state, { type: "start", step: "prepare" });
  state = registerReducer(state, { type: "prepared", prepared: PREPARED });
  state = registerReducer(state, { type: "start", step: "sign" });
  state = registerReducer(state, { type: "signed", digest: `0x${"cd".repeat(32)}` });
  state = registerReducer(state, { type: "start", step: "send" });
  state = registerReducer(state, { type: "sent", txHash: `0x${"ef".repeat(32)}` });
  return registerReducer(state, { type: "confirmed", block: 123n, at: 1_788_876_542_000 });
}

describe("the statement a creator builds in the studio", () => {
  it("opens on nothing said, which sends nothing at all", () => {
    expect(initialRegisterState.consent).toEqual(NOTHING_TO_STATE);
    expect(initialRegisterState.consent.consent).toEqual(NOTHING_STATED);
    expect(saysSomething(NOTHING_TO_STATE)).toBe(false);
    expect(trainingFrom(NOTHING_TO_STATE)).toBeUndefined();
    expect(initialRegisterState.statement.state).toBe("idle");
  });

  it("sends the three words the service knows, and leaves a use nobody spoke for out", () => {
    expect(trainingFrom(CLOSED)).toEqual({
      aiTraining: "notAllowed",
      aiGenerativeTraining: "notAllowed",
      aiInference: "notAllowed",
      dataMining: "notAllowed",
    });

    const partly: ConsentDraft = {
      consent: { ...NOTHING_STATED, aiTraining: "allowed" },
      constraintInfo: "",
    };
    expect(trainingFrom(partly)).toEqual({ aiTraining: "allowed" });
  });

  it("sends the conditions only with a conditional choice", () => {
    expect(trainingFrom(ASK)?.constraintInfo).toBe("ask hello@moolam.app");
    expect(trainingFrom({ ...CLOSED, constraintInfo: "not my conditions" }).constraintInfo).toBeUndefined();
  });

  it("writes the service's own answer to the chain, not the plates", () => {
    // The service trims, so the words in the file carry no stray spaces. Those
    // are the words that have to go on chain.
    const echoed = statedFrom({
      aiTraining: "constrained",
      aiGenerativeTraining: "constrained",
      aiInference: "constrained",
      dataMining: "constrained",
      constraintInfo: "ask hello@moolam.app",
      standard: "cawg.training-mining/1.1",
    });

    expect(echoed).toEqual({ consent: ASK.consent, constraintInfo: "ask hello@moolam.app" });
    expect(echoed?.constraintInfo).not.toBe(ASK.constraintInfo);
  });

  it("reads a use the service left out as nothing stated, and an empty answer as no statement", () => {
    expect(statedFrom({ aiTraining: "notAllowed", standard: "cawg.training-mining/1.1" })).toEqual({
      consent: { ...NOTHING_STATED, aiTraining: "notAllowed" },
      constraintInfo: "",
    });
    expect(statedFrom(undefined)).toBeNull();
    expect(statedFrom({ standard: "cawg.training-mining/1.1" })).toBeNull();
  });

  it("keeps what was picked when the creator switches sides or swaps the picture", () => {
    let state = registerReducer(initialRegisterState, { type: "consent", draft: CLOSED });
    expect(state.consent).toEqual(CLOSED);

    state = registerReducer(state, { type: "mode", mode: "generate" });
    expect(state.consent).toEqual(CLOSED);

    state = registerReducer(state, { type: "choose", file: new File(["x"], "p.jpg", { type: "image/jpeg" }) });
    expect(state.consent).toEqual(CLOSED);

    // A new run is a new picture and a fresh answer, like the title beside it.
    expect(registerReducer(state, { type: "reset" }).consent).toEqual(NOTHING_TO_STATE);
  });
});

/** Everything the registration itself established, which a statement may never touch. */
function registrationOf(state: RegisterState) {
  const { statement, consent, ...registration } = state;
  return { registration, statementIsSeparate: statement !== undefined, consentIsSeparate: consent !== undefined };
}

describe("the statement's own sub-state", () => {
  it("walks sending, sent and stated without moving one registration step", () => {
    const before = registered();
    let state = registerReducer(before, { type: "stating" });
    expect(state.statement.state).toBe("sending");
    expect(isStating(state)).toBe(true);
    expect(isBusy(state)).toBe(true);

    state = registerReducer(state, { type: "statementSent", hash: `0x${"3f".repeat(32)}` });
    state = registerReducer(state, {
      type: "stated",
      sent: CLOSED,
      at: 1_789_719_047,
      waitedMs: 1_204,
      hash: `0x${"3f".repeat(32)}`,
      sponsored: true,
    });

    expect(state.statement).toEqual({
      state: "stated",
      sent: CLOSED,
      hash: `0x${"3f".repeat(32)}`,
      at: 1_789_719_047,
      waitedMs: 1_204,
      sponsored: true,
      failure: null,
    });
    expect(isStating(state)).toBe(false);
    expect(isBusy(state)).toBe(false);

    // Everything the registration established is untouched, field for field.
    expect(registrationOf(state)).toEqual(registrationOf(before));
  });

  it("keeps the passport registered when the statement fails, and says nothing failed about the send", () => {
    const before = registered();
    let state = registerReducer(before, { type: "stating" });
    state = registerReducer(state, {
      type: "statementFailed",
      failure: { key: "unknown", reason: "the endpoint refused", next: "again" },
    });

    expect(state.statement.state).toBe("failed");
    expect(state.statement.failure?.key).toBe("unknown");
    expect(isRegistered(state)).toBe(true);
    expect(state.steps).toEqual(before.steps);
    expect(state.registeredAt).toBe(before.registeredAt);
    expect(state.txHash).toBe(before.txHash);
    expect(state.failure).toBeNull();
    expect(isBusy(state)).toBe(false);
  });

  it("reads a closed wallet prompt as a choice, not as a fault", () => {
    let state = registerReducer(registered(), { type: "stating" });
    state = registerReducer(state, { type: "statementFailed", failure: { key: "declined", next: "again" } });

    expect(state.statement.state).toBe("failed");
    expect(state.statement.failure).toEqual({ key: "declined", next: "again" });
    expect(isRegistered(state)).toBe(true);
  });

  it("locks the studio while a statement is out and unshown, exactly as an unconfirmed send does", () => {
    let state = registerReducer(registered(), { type: "stating" });
    state = registerReducer(state, { type: "statementSent", hash: `0x${"3f".repeat(32)}` });
    state = registerReducer(state, {
      type: "statementFailed",
      failure: { key: "confirmPending", next: "recheck" },
    });

    expect(state.statement.state).toBe("unconfirmed");
    expect(isUnconfirmed(state)).toBe(true);
    expect(isBusy(state)).toBe(true);
    expect(isRegistered(state)).toBe(true);
  });

  it("starts a retry from a clean statement, so a failure is not printed over a fresh attempt", () => {
    let state = registerReducer(registered(), { type: "stating" });
    state = registerReducer(state, { type: "statementFailed", failure: { key: "declined", next: "again" } });
    state = registerReducer(state, { type: "stating" });

    expect(state.statement.failure).toBeNull();
    expect(state.statement.state).toBe("sending");
  });
});
