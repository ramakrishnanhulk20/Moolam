import { describe, expect, it } from "vitest";
import { encodeErrorResult } from "viem";
import { registryAbi } from "@/lib/chain/client";
import { VerifierError } from "@/lib/verifier/client";
import { accountName } from "@/lib/studio/account";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import { bindReducer, initialBindState } from "@/lib/studio/binding";
import { checkImage, initialRegisterState, isBusy, isRegistered, passportId, registerReducer } from "@/lib/studio/flow";
import { PROMPT_MAX, atLimit, checkPrompt, generateDeadline } from "@/lib/studio/generate";
import { passportArt } from "@/lib/studio/metadata";
import { AuthCheckFailed, describeFailure, isSponsorshipRefusal } from "@/lib/studio/problems";
import { passportInputFromGenerated } from "@/lib/chain/calldata";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";

const ID = `0x${"ab".repeat(32)}` as const;

const PREPARED = {
  passport: {
    exactHash: ID,
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

describe("who is signed in", () => {
  it("prefers the email address", () => {
    expect(accountName({ email: { address: "ram@example.com" }, google: { email: "other@example.com" } })).toEqual({
      kind: "email",
      value: "ram@example.com",
    });
  });

  it("falls back to Google, then the phone number", () => {
    expect(accountName({ google: { email: "ram@gmail.com" } })).toEqual({ kind: "google", value: "ram@gmail.com" });
    expect(accountName({ phone: { number: "+15550000" } })).toEqual({ kind: "phone", value: "+15550000" });
  });

  it("names a passkey-only account, and says nothing it cannot know", () => {
    expect(accountName({ linkedAccounts: [{ type: "passkey" }] })).toEqual({ kind: "passkey" });
    expect(accountName(null)).toEqual({ kind: "account" });
  });
});

describe("the file a creator picked", () => {
  it("refuses anything that is not one of the three image types", () => {
    const problem = checkImage(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(problem?.key).toBe("notAnImage");
  });

  it("refuses a file over the service's own limit before it is uploaded", () => {
    const big = new File([new Uint8Array(1)], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    expect(checkImage(big)?.key).toBe("tooLarge");
  });

  it("takes a jpeg, a png and a webp", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(checkImage(new File(["x"], "picture", { type }))).toBeNull();
    }
  });
});

describe("the three steps", () => {
  const file = new File(["x"], "picture.jpg", { type: "image/jpeg" });

  it("walks prepare, sign and send to a registered passport", () => {
    let state = registerReducer(initialRegisterState, { type: "choose", file });
    state = registerReducer(state, { type: "title", title: "A morning" });
    state = registerReducer(state, { type: "start", step: "prepare" });
    expect(isBusy(state)).toBe(true);

    state = registerReducer(state, { type: "prepared", prepared: PREPARED });
    state = registerReducer(state, { type: "start", step: "sign" });
    state = registerReducer(state, { type: "signed", digest: `0x${"cd".repeat(32)}` });
    state = registerReducer(state, { type: "start", step: "send" });
    state = registerReducer(state, { type: "sent", txHash: `0x${"ef".repeat(32)}` });
    state = registerReducer(state, { type: "confirmed", block: 123n, at: 1_700_000_000_000 });

    expect(state.steps).toMatchObject({ prepare: "done", sign: "done", send: "done" });
    expect(isRegistered(state)).toBe(true);
    expect(isBusy(state)).toBe(false);
    expect(passportId(state)).toBe(ID);
    expect(state.title).toBe("A morning");
  });

  it("marks only the running step failed and keeps what already landed", () => {
    let state = registerReducer(initialRegisterState, { type: "choose", file });
    state = registerReducer(state, { type: "start", step: "prepare" });
    state = registerReducer(state, { type: "prepared", prepared: PREPARED });
    state = registerReducer(state, { type: "start", step: "sign" });
    state = registerReducer(state, { type: "failed", failure: { key: "passkeyCancelled" } });

    expect(state.steps).toMatchObject({ prepare: "done", sign: "failed", send: "waiting" });
    expect(state.prepared).not.toBeNull();
    expect(state.failure?.key).toBe("passkeyCancelled");
  });

  it("starts clean when another picture is chosen, and keeps the title", () => {
    let state = registerReducer(initialRegisterState, { type: "title", title: "A morning" });
    state = registerReducer(state, { type: "start", step: "prepare" });
    state = registerReducer(state, { type: "prepared", prepared: PREPARED });
    state = registerReducer(state, { type: "choose", file });

    expect(state.prepared).toBeNull();
    expect(state.steps.prepare).toBe("waiting");
    expect(state.title).toBe("A morning");
  });
});

const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;

const DRAWN = {
  passport: {
    ...PREPARED.passport,
    creator: CREATOR,
    generatorAgentId: "10249",
    kind: 0,
    deadline: "1788878733",
  },
  generatorSig: `0x${"cd".repeat(65)}`,
  image: PREPARED.image,
  thumbnail: PREPARED.thumbnail,
  metadata: PREPARED.metadata,
  manifest: { embedded: true },
  model: "gpt-image-1",
  agent: { id: "10249", wallet: "0xa37418c4047Fb6A42150D6E9Ddab77580Ddb9AFb" },
  quota: { used: 1, limit: 3, resetsAt: 1788961533 },
  preparedBy: "did:privy:someone",
} as unknown as GenerateResponse;

describe("the agent path", () => {
  it("stamps drawing, pinning and the agent signature together, then the passkey and the send", () => {
    let state = registerReducer(initialRegisterState, { type: "mode", mode: "generate" });
    state = registerReducer(state, { type: "title", title: "First light" });
    state = registerReducer(state, { type: "prompt", prompt: "a fishing boat at first light" });
    state = registerReducer(state, { type: "start", step: "draw" });

    expect(isBusy(state)).toBe(true);
    expect(state.steps).toMatchObject({ draw: "running", pin: "waiting", agentSign: "waiting" });

    state = registerReducer(state, { type: "drawn", response: DRAWN });
    expect(state.steps).toMatchObject({ draw: "done", pin: "done", agentSign: "done", sign: "waiting" });
    expect(state.generated?.generatorSig).toBe(`0x${"cd".repeat(65)}`);
    expect(state.quota).toEqual({ used: 1, limit: 3, resetsAt: 1788961533 });
    // The receipt column reads the prepared block, so the agent's answer fills it too.
    expect(passportId(state)).toBe(ID);

    state = registerReducer(state, { type: "start", step: "sign" });
    state = registerReducer(state, { type: "signed", digest: `0x${"cd".repeat(32)}` });
    state = registerReducer(state, { type: "start", step: "send" });
    state = registerReducer(state, { type: "confirmed", block: 123n, at: 1_700_000_000_000 });

    expect(isRegistered(state)).toBe(true);
    expect(isBusy(state)).toBe(false);
  });

  it("names the retry after what it would really do, and keeps today's count through a refusal", () => {
    let state = registerReducer(initialRegisterState, { type: "mode", mode: "generate" });
    state = registerReducer(state, { type: "start", step: "draw" });
    state = registerReducer(state, {
      type: "failed",
      failure: { key: "quotaReached" },
      quota: { used: 3, limit: 3, resetsAt: 1788961533 },
    });

    expect(state.steps.draw).toBe("failed");
    expect(state.quota).toEqual({ used: 3, limit: 3, resetsAt: 1788961533 });
    expect(atLimit(state.quota)).toBe(true);

    const expired = registerReducer(state, { type: "failed", failure: { key: "expired", next: "again" } });
    expect(expired.failure?.next).toBe("generateAgain");
    expect(expired.quota).toEqual({ used: 3, limit: 3, resetsAt: 1788961533 });
  });

  it("leaves the upload path's retry alone", () => {
    const state = registerReducer(initialRegisterState, { type: "failed", failure: { key: "expired", next: "again" } });
    expect(state.failure?.next).toBe("again");
  });

  it("refuses a prompt the service would refuse, before a picture is paid for", () => {
    expect(checkPrompt("  a boat  ")?.key).toBe("promptTooShort");
    expect(checkPrompt("x".repeat(PROMPT_MAX + 1))?.key).toBe("promptTooLong");
    expect(checkPrompt("a fishing boat at first light")).toBeNull();
  });

  it("asks for a thirty minute window, which is what the creator has to sign inside", () => {
    expect(generateDeadline(1_700_000_000_000)).toBe(1_700_001_800n);
  });

  it("signs the agent's struct untouched, creator and deadline included", () => {
    const input = passportInputFromGenerated(DRAWN.passport);
    expect(input.creator).toBe(CREATOR);
    expect(input.deadline).toBe(1_788_878_733n);
    expect(input.generatorAgentId).toBe(10249n);
    expect(input.kind).toBe(0);
    expect(input.phash.toString()).toBe(DRAWN.passport.phash);
  });
});

describe("binding a passkey", () => {
  it("moves from making the key to waiting for the unlock to sending", () => {
    let state = bindReducer(initialBindState, { type: "stage", stage: "creating" });
    state = bindReducer(state, { type: "created", qx: `0x${"01".repeat(32)}`, qy: `0x${"02".repeat(32)}` });
    expect(state.stage).toBe("waiting");

    state = bindReducer(state, { type: "sent", txHash: `0x${"03".repeat(32)}` });
    expect(state.stage).toBe("sending");

    state = bindReducer(state, { type: "bound" });
    expect(state.stage).toBe("bound");
    expect(state.failure).toBeNull();
  });

  it("goes back to the start when it fails, so the button can be pressed again", () => {
    const state = bindReducer({ ...initialBindState, stage: "waiting" }, {
      type: "failed",
      failure: { key: "passkeyCancelled" },
    });
    expect(state.stage).toBe("idle");
    expect(state.failure?.key).toBe("passkeyCancelled");
  });
});

describe("what to tell the creator", () => {
  it("maps every verify service failure to its own sentence", () => {
    expect(describeFailure(new VerifierError("offline", 0, "no answer"), "prepare")).toMatchObject({
      key: "serviceOffline",
      next: "again",
    });
    expect(describeFailure(new VerifierError("unauthorized", 401, "unauthorized"), "prepare")).toMatchObject({
      key: "signedOut",
      next: "signIn",
    });
    expect(describeFailure(new VerifierError("too-large", 413, "too big"), "prepare").key).toBe("tooLarge");
    expect(describeFailure(new VerifierError("not-an-image", 415, "nope"), "prepare").key).toBe("notAnImage");
  });

  it("says which of the registry's own checks a signature would fail", () => {
    const failure = describeFailure(new AuthCheckFailed("user-not-verified", "no biometric"), "passkey");
    expect(failure).toMatchObject({ key: "authCheck", reason: "no biometric" });
  });

  it("reads a closed passkey prompt as a cancellation, not a fault", () => {
    const error = new Error("The operation either timed out or was not allowed.");
    error.name = "NotAllowedError";
    expect(describeFailure(error, "passkey")).toMatchObject({ key: "passkeyCancelled", next: "again" });
  });

  it("decodes a contract revert and offers the passport that already holds the image", () => {
    const data = encodeErrorResult({ abi: registryAbi, errorName: "PassportAlreadyExists", args: [ID] });
    expect(describeFailure({ data }, "send")).toMatchObject({
      key: "alreadyRegistered",
      reason: "PassportAlreadyExists",
      next: "openPassport",
    });
  });

  it("sends an unbound wallet back to the bind step", () => {
    const data = encodeErrorResult({
      abi: registryAbi,
      errorName: "PasskeyNotBound",
      args: ["0x1111111111111111111111111111111111111111"],
    });
    expect(describeFailure({ data }, "send")).toMatchObject({ key: "notBound", next: "bind" });
  });

  it("spots a refused gas sponsorship and offers to pay the fee instead", () => {
    expect(isSponsorshipRefusal(new Error("Gas sponsorship is not enabled for this app"))).toBe(true);
    expect(isSponsorshipRefusal(new Error("insufficient credits on this policy"))).toBe(true);
    expect(isSponsorshipRefusal(new Error("nonce too low"))).toBe(false);

    expect(describeFailure(new Error("sponsorship policy rejected this transaction"), "send")).toMatchObject({
      key: "sponsorship",
      next: "unsponsored",
    });
  });

  it("sends a creator address this session no longer holds back through a fresh sign in", () => {
    expect(describeFailure(new VerifierError("creator-mismatch", 403, "creator-mismatch"), "prepare")).toEqual({
      key: "creatorMismatch",
      next: "signOut",
    });
  });

  it("offers another drawing when the window to sign the last one closed", () => {
    const failure = describeFailure(new VerifierError("deadline-passed", 400, "deadline-passed"), "prepare");
    expect(failure).toEqual({ key: "deadlinePassed", next: "again" });

    // On the agent path the retry draws a new picture, and the button has to say so.
    const shown = registerReducer({ ...initialRegisterState, mode: "generate" }, { type: "failed", failure });
    expect(shown.failure).toEqual({ key: "deadlinePassed", next: "generateAgain" });
  });

  it("points a picture the registry already holds at the passport that holds it", () => {
    const failure = describeFailure(
      new VerifierError("already-registered", 409, "already-registered", undefined, { passportId: ID }),
      "prepare",
    );
    expect(failure).toEqual({ key: "alreadyRegistered", next: "openPassport", passportId: ID });

    // Nothing was prepared, so the refusal's own id is the only one the button
    // could use.
    const state = registerReducer(initialRegisterState, { type: "failed", failure });
    expect(state.prepared).toBeNull();
    expect(passportId(state)).toBe(ID);
  });

  it("tells an upload that found the decode gate full to wait, the same as a drawing does", () => {
    expect(describeFailure(new VerifierError("busy", 503, "busy"), "prepare")).toEqual({
      key: "agentBusy",
      next: "again",
    });
  });

  it("does not apologise when the person closed the confirmation themselves", () => {
    expect(describeFailure({ code: 4001, message: "User rejected the request" }, "send").key).toBe("sendCancelled");
  });
});

describe("the picture on a passport row", () => {
  it("prefers the pinned thumbnail", () => {
    expect(passportArt({ name: "A morning", thumbnail: "ipfs://thumb", image: "ipfs://full" })).toEqual({
      title: "A morning",
      uri: "ipfs://thumb",
    });
  });

  it("falls back to the full image, and gives up quietly on anything else", () => {
    expect(passportArt({ image: "ipfs://full" }).uri).toBe("ipfs://full");
    expect(passportArt({ image: 7 })).toEqual({});
    expect(passportArt("not a document")).toEqual({});
  });
});

describe("when the unsponsored retry is offered", () => {
  const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;

  it("offers it only when Privy refused before anything was submitted", () => {
    for (const words of [
      "Gas sponsorship is not enabled for this app",
      "insufficient credits left",
      "the gas policy rejected this request",
      "fee sponsorship is not configured for chain 143",
    ]) {
      expect(describeFailure(new Error(words), "send").next).toBe("unsponsored");
    }
  });

  it("never offers it after a wait ran out, because the sponsored send may have landed", () => {
    const pending = new ConfirmTimeout(WALLET);
    expect(isSponsorshipRefusal(pending)).toBe(false);
    expect(describeFailure(pending, "send")).toMatchObject({
      key: "confirmPending",
      next: "recheck",
      address: WALLET,
    });
  });

  it("never offers it for a receipt that timed out on a hash that was never one", () => {
    const timeout = new Error('Timed out while waiting for transaction with hash "" to be confirmed.');
    expect(describeFailure(timeout, "send").next).toBe("again");
  });
});
