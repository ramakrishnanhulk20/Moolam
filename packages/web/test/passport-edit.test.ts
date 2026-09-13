import { describe, expect, it } from "vitest";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import { VerifierError } from "@/lib/verifier/client";
import {
  checkEditImage,
  describeEditFailure,
  describeGrantFailure,
  editReducer,
  initialEditState,
  isEditBusy,
  isEditDone,
  type EditState,
} from "@/lib/passport/edit";
import { ownsPassport, signerGranted } from "@/lib/passport/owner";

const OWNER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as const;
const STRANGER = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;

describe("who sees the edit panel", () => {
  it("shows it to the wallet the registry says holds the passport, whatever the case", () => {
    expect(ownsPassport(OWNER, OWNER)).toBe(true);
    expect(ownsPassport(OWNER, OWNER.toLowerCase())).toBe(true);
    expect(ownsPassport(OWNER.toLowerCase(), OWNER.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("shows it to nobody else, signed out or signed in as someone else", () => {
    expect(ownsPassport(OWNER, undefined)).toBe(false);
    expect(ownsPassport(OWNER, STRANGER)).toBe(false);
    expect(ownsPassport(null, OWNER)).toBe(false);
    expect(ownsPassport(undefined, OWNER)).toBe(false);
  });
});

describe("whether this wallet already has a signer on it", () => {
  const delegated = [
    { type: "email", address: "creator@example.com" },
    { type: "wallet", address: OWNER.toLowerCase(), delegated: true },
  ];

  it("reads the delegated flag on the wallet with this address", () => {
    expect(signerGranted(delegated, OWNER)).toBe(true);
  });

  it("does not read another wallet's flag, or a wallet that granted nothing", () => {
    expect(signerGranted(delegated, STRANGER)).toBe(false);
    expect(signerGranted([{ type: "wallet", address: OWNER, delegated: false }], OWNER)).toBe(false);
    expect(signerGranted([{ type: "wallet", address: OWNER }], OWNER)).toBe(false);
    expect(signerGranted(undefined, OWNER)).toBe(false);
    expect(signerGranted(delegated, undefined)).toBe(false);
  });
});

describe("the steps the panel walks through", () => {
  function pinning(): EditState {
    return editReducer({ ...initialEditState, title: "Kadal at dawn, warmer" }, { type: "start" });
  }

  it("pins first and claims nothing about the send while the request is out", () => {
    const state = pinning();
    expect(state.steps).toEqual({ pin: "running", send: "waiting" });
    expect(isEditBusy(state)).toBe(true);
    expect(isEditDone(state)).toBe(false);
  });

  it("marks the pins done and the send running the moment the answer lands", () => {
    const result = {
      child: { exactHash: `0x${"ab".repeat(32)}` },
      quota: { used: 2, limit: 5, resetsAt: 1788961533 },
    } as never;
    const state = editReducer(pinning(), { type: "pinned", result });

    expect(state.steps).toEqual({ pin: "done", send: "running" });
    expect(state.confirming).toBe(true);
    expect(state.quota).toEqual({ used: 2, limit: 5, resetsAt: 1788961533 });
  });

  it("is done only once Monad has shown the child, and keeps the parent's list", () => {
    const children = [`0x${"ab".repeat(32)}` as `0x${string}`];
    const state = editReducer(pinning(), { type: "confirmed", block: 42n, children });

    expect(isEditDone(state)).toBe(true);
    expect(state.confirming).toBe(false);
    expect(state.children).toEqual(children);
  });

  it("blames the step that actually failed", () => {
    const pinFailed = editReducer(pinning(), { type: "failed", failure: { key: "pinFailed" }, stage: "pin" });
    expect(pinFailed.steps).toEqual({ pin: "failed", send: "waiting" });

    const sendFailed = editReducer(pinning(), { type: "failed", failure: { key: "sendFailed" }, stage: "send" });
    expect(sendFailed.steps).toEqual({ pin: "done", send: "failed" });
  });

  it("keeps the title, the note and the allowance when a new picture is chosen", () => {
    const chosen = editReducer(
      { ...initialEditState, title: "Kadal", note: "warmer", quota: { used: 1, limit: 5, resetsAt: 1 } },
      { type: "choose", file: new File(["x"], "edited.jpg", { type: "image/jpeg" }) },
    );
    expect(chosen.title).toBe("Kadal");
    expect(chosen.note).toBe("warmer");
    expect(chosen.quota).toEqual({ used: 1, limit: 5, resetsAt: 1 });
  });
});

describe("what the panel says when something goes wrong", () => {
  it("sends a missing signer back to the grant button", () => {
    const failure = describeEditFailure(new VerifierError("no-signer", 409, "no-signer"));
    expect(failure).toEqual({ key: "noSigner", next: "grant" });
  });

  it("names the reason the registry gave for a refused send", () => {
    const failure = describeEditFailure(new VerifierError("send-failed", 502, "PassportAlreadyExists"));
    expect(failure).toEqual({ key: "sendFailed", reason: "PassportAlreadyExists", next: "again" });
  });

  it("maps each of the service's own answers to a line of its own", () => {
    const codes = [
      ["not-owner", "notOwner"],
      ["no-parent", "noParent"],
      ["quota", "quota"],
      ["pin-failed", "pinFailed"],
      ["busy", "busy"],
      ["offline", "offline"],
      ["unauthorized", "signedOut"],
    ] as const;

    for (const [code, key] of codes) {
      expect(describeEditFailure(new VerifierError(code, 500, code)).key).toBe(key);
    }
  });

  it("never suggests sending again when the wait ran out, because the edit may still land", () => {
    const failure = describeEditFailure(new ConfirmTimeout());
    expect(failure).toEqual({ key: "confirmPending", next: "recheck" });
  });

  it("tells a declined Privy window apart from a grant that broke", () => {
    expect(describeGrantFailure(new Error("User rejected the request")).key).toBe("grantDeclined");
    expect(describeGrantFailure(new Error("network error")).key).toBe("grantFailed");
  });

  it("refuses a picture the service was always going to refuse", () => {
    const notAnImage = new File(["notes"], "notes.txt", { type: "text/plain" });
    expect(checkEditImage(notAnImage)).toEqual({ key: "notAnImage", reason: "text/plain" });
    expect(checkEditImage(new File(["x"], "edited.webp", { type: "image/webp" }))).toBeNull();
  });
});
