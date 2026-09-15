import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HttpRequestError, encodeErrorResult } from "viem";
import { registryAbi } from "@/lib/chain/client";
import { VerifierError } from "@/lib/verifier/client";
import { accountName } from "@/lib/studio/account";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import { bindReducer, initialBindState } from "@/lib/studio/binding";
import { checkImage, initialRegisterState, isBusy, isRegistered, passportId, registerReducer } from "@/lib/studio/flow";
import { DEADLINE_SECONDS, PROMPT_MAX, asGenerateFailure, atLimit, checkPrompt } from "@/lib/studio/generate";
import { passportArt } from "@/lib/studio/metadata";
import { recallCredential, rememberCredential } from "@/lib/passkey/browser";
import { bindingStatus } from "@/lib/studio/usePasskeyBinding";
import { AuthCheckFailed, describeFailure, isResendable, isSponsorshipRefusal } from "@/lib/studio/problems";
import { DigestMismatch } from "@/lib/chain/digest";
import { Reverted } from "@/lib/chain/watch";
import { SIGNATURE_WINDOW_SECONDS, passportInputFromGenerated } from "@/lib/chain/calldata";
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

  it("signs against the registry's own window, and never against a second copy of it", () => {
    expect(DEADLINE_SECONDS).toBe(Number(SIGNATURE_WINDOW_SECONDS));
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

  it("stays shut on a bind that is still out, because a second one would replace it", () => {
    const state = bindReducer({ ...initialBindState, stage: "sending" }, {
      type: "failed",
      failure: { key: "confirmPending", next: "recheck" },
    });
    expect(state.stage).toBe("unconfirmed");
    expect(state.failure?.next).toBe("recheck");
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
    const failure = describeFailure(new AuthCheckFailed("user-not-verified", "no biometric"), "sign");
    expect(failure).toMatchObject({ key: "authCheck", reason: "no biometric" });
  });

  it("reads a closed passkey prompt as a cancellation, not a fault", () => {
    const error = new Error("The operation either timed out or was not allowed.");
    error.name = "NotAllowedError";
    expect(describeFailure(error, "sign")).toMatchObject({ key: "passkeyCancelled", next: "again" });
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

describe("after the send, never again", () => {
  const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;

  it("reads an RPC error raised while watching as a send that is still out", () => {
    const failure = describeFailure(new Error("fetch failed"), "confirm", WALLET);
    expect(failure).toMatchObject({ key: "confirmPending", next: "recheck", address: WALLET });
  });

  it("says plainly when Monad mined the transaction and it reverted", () => {
    const failure = describeFailure(new Reverted(`0x${"ef".repeat(32)}`), "confirm", WALLET);
    expect(failure.key).toBe("reverted");
    expect(failure.reason).toContain("reverted");
  });

  it("keeps the whole run busy while a send is unconfirmed, so no button starts a second one", () => {
    let state = registerReducer(initialRegisterState, { type: "choose", file: new File(["x"], "p.jpg", { type: "image/jpeg" }) });
    state = registerReducer(state, { type: "start", step: "send" });
    state = registerReducer(state, {
      type: "failed",
      failure: { key: "confirmPending", next: "recheck" },
      stage: "confirm",
    });

    expect(state.steps.send).toBe("unconfirmed");
    expect(isBusy(state)).toBe(true);
    expect(isRegistered(state)).toBe(false);
  });

  it("never renames a post-send failure into another drawing", () => {
    const refused = { key: "sendCancelled", next: "again" as const };
    expect(asGenerateFailure(refused, "send")).toEqual(refused);
    expect(asGenerateFailure(refused, "confirm")).toEqual(refused);
    expect(asGenerateFailure(refused, "prepare").next).toBe("generateAgain");

    const shown = registerReducer(
      { ...initialRegisterState, mode: "generate" },
      { type: "failed", failure: refused, stage: "send" },
    );
    expect(shown.failure?.next).toBe("again");
  });

  it("offers the same signed bytes again only for a refusal that happened before the send", () => {
    expect(isResendable({ key: "sendCancelled", next: "again" })).toBe(true);
    expect(isResendable({ key: "sponsorship", next: "unsponsored" })).toBe(true);
    expect(isResendable({ key: "confirmPending", next: "recheck" })).toBe(false);
    expect(isResendable(null)).toBe(false);
  });
});

describe("where a failure happened, not what its name looks like", () => {
  it("reads a chain error in the signing phase as the network, never as the passkey", () => {
    const error = new HttpRequestError({ url: "https://rpc.monad.xyz", details: "the node timed out" });
    const failure = describeFailure(error, "sign");
    expect(failure.key).toBe("sendFailed");
    expect(failure.next).toBe("again");
    expect(failure.key).not.toContain("passkey");
  });

  it("reads a plain error out of the passkey ceremony as a passkey failure", () => {
    expect(describeFailure(new Error("the browser returned no assertion"), "sign").key).toBe("passkeyOther");
  });

  it("stops on a digest the registry does not agree with, and offers no unlock", () => {
    const mismatch = new DigestMismatch(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`);
    const failure = describeFailure(mismatch, "sign");
    expect(failure.next).toBeUndefined();
    expect(failure.reason).toContain("may be signed");
    expect(failure.key).not.toContain("passkey");
  });

  it("names a generator signature the registry refused, and offers nothing that spends a slot", () => {
    const data = encodeErrorResult({ abi: registryAbi, errorName: "InvalidGeneratorSignature" });
    const failure = describeFailure({ data }, "send");
    expect(failure).toEqual({ key: "agentSignFailed", reason: "InvalidGeneratorSignature", next: undefined });
  });
});

describe("what the studio does before it asks for an unlock", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/studio/useStudio.ts", import.meta.url)), "utf8");
  const screen = readFileSync(fileURLToPath(new URL("../components/studio/StudioScreen.tsx", import.meta.url)), "utf8");

  /** Where a call first appears inside one function of the hook. */
  function order(fn: string, ...calls: string[]): number[] {
    const body = source.slice(source.indexOf(`const ${fn} = useCallback`));
    return calls.map((call) => body.indexOf(call));
  }

  it("checks the creator the agent signed for before any passkey prompt", () => {
    const [check, prompt] = order("generateImage", "drawn.passport.creator.toLowerCase()", "await signDigest");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(prompt);
  });

  it("checks its own digest against the registry's before any passkey prompt", () => {
    for (const fn of ["registerImage", "generateImage", "bindThisDevice"]) {
      const [compared, prompt] = order(fn, "assertDigestMatches", "await signDigest");
      expect(compared).toBeGreaterThan(-1);
      expect(compared).toBeLessThan(prompt);
    }
  });

  it("remembers a credential only after the registry has answered with that key", () => {
    const [confirmed, remembered] = order("finishBind", "await confirmBind", "rememberCredential(");
    expect(confirmed).toBeGreaterThan(-1);
    expect(confirmed).toBeLessThan(remembered);
  });

  it("sends from the wallet the digest was built for", () => {
    expect(source).toContain("{ sponsor: !unsponsored, address: from }");
  });

  it("asks the chain for the deadline and the relying party for every check", () => {
    expect(source).not.toContain("Date.now() / 1000");
    expect(source.match(/deadlineFromChain\(SIGNATURE_WINDOW_SECONDS\)/g)).toHaveLength(2);
    expect(source.match(/checkAuth\(/g)).toHaveLength(source.match(/\{ rpId, origin \}/g)?.length);
  });

  it("lets go of the bind detour once the key is on chain, and opens it on a clean card", () => {
    expect(screen).toContain('const bindRoute = rebinding && studio.bind.stage !== "bound"');
    expect(screen).toContain("studio.actions.clearBind()");
    expect(screen).toContain("setRebinding(false)");
  });
});

describe("the key this browser remembers", () => {
  const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;
  const ON_CHAIN = { qx: `0x${"aa".repeat(32)}`, qy: `0x${"bb".repeat(32)}` } as const;
  const REPLACED = { qx: `0x${"cc".repeat(32)}`, qy: `0x${"dd".repeat(32)}` } as const;
  const CREDENTIAL = new Uint8Array([1, 2, 3, 4]);

  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    // localStorage is the browser's, and these two functions are the only
    // place the studio touches it.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("hands the credential back while the registry still holds that key", () => {
    rememberCredential(WALLET, { credentialId: CREDENTIAL, ...ON_CHAIN });

    const held = recallCredential(WALLET, ON_CHAIN);
    expect(held?.credentialId).toEqual(CREDENTIAL);
    expect(bindingStatus({ passkey: ON_CHAIN, remembered: held, error: null })).toBe("bound");
  });

  it("drops a key the registry has replaced, and reads as a passkey bound elsewhere", () => {
    rememberCredential(WALLET, { credentialId: CREDENTIAL, ...ON_CHAIN });

    const held = recallCredential(WALLET, REPLACED);
    expect(held).toBeUndefined();
    expect(store.size).toBe(0);
    expect(bindingStatus({ passkey: REPLACED, remembered: held, error: null })).toBe("bound-elsewhere");
  });

  it("drops an entry with no key in it at all, which is what older versions wrote", () => {
    store.set("moolam.passkey.0x559f357ada3a96d11aea679ec0d622e4af15f67c", "0x01020304");

    expect(recallCredential(WALLET, ON_CHAIN)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("says nothing is bound when the registry holds no key, and nothing readable when the read failed", () => {
    expect(bindingStatus({ passkey: null, remembered: undefined, error: null })).toBe("unbound");
    expect(bindingStatus({ passkey: null, remembered: undefined, error: "the node refused" })).toBe("unreadable");
    expect(bindingStatus(null)).toBe("reading");
  });
});
