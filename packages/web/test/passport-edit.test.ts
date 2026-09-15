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
  isEditOutstanding,
  isEditPending,
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

  it("is done only once Monad has shown the child, and keeps the parent's list and its count", () => {
    const children = [`0x${"ab".repeat(32)}` as `0x${string}`];
    const state = editReducer(pinning(), { type: "confirmed", block: 42n, children, total: 51 });

    expect(isEditDone(state)).toBe(true);
    expect(state.confirming).toBe(false);
    expect(state.children).toEqual(children);
    expect(state.total).toBe(51);
  });

  it("clears the warning from a wait that ran out when the next look finds the edit", () => {
    const ranOut = editReducer(pinning(), {
      type: "failed",
      failure: { key: "confirmPending", next: "recheck" },
      stage: "send",
    });
    const landed = editReducer(ranOut, { type: "confirmed", block: 42n, children: [], total: 1 });

    expect(landed.failure).toBeNull();
    expect(isEditDone(landed)).toBe(true);
  });

  it("stays busy for the whole of a second look, so nothing offers to send again mid-wait", () => {
    const ranOut = editReducer(pinning(), {
      type: "failed",
      failure: { key: "confirmPending", next: "recheck" },
      stage: "send",
    });
    const looking = editReducer(ranOut, { type: "watching" });

    expect(isEditBusy(looking)).toBe(true);
    expect(isEditOutstanding(looking)).toBe(true);
    expect(looking.failure).toBeNull();
  });

  it("counts an edit that may be on the network as outstanding, and a refused one as not", () => {
    const sent = editReducer(pinning(), {
      type: "failed",
      failure: { key: "sendPending", next: "recheck" },
      stage: "send",
    });
    expect(isEditOutstanding(sent)).toBe(true);

    const refused = editReducer(pinning(), {
      type: "failed",
      failure: { key: "sendFailed", next: "again" },
      stage: "send",
    });
    expect(isEditOutstanding(refused)).toBe(false);
    expect(isEditOutstanding(initialEditState)).toBe(false);
  });

  it("keeps the warning and its second look when another picture is chosen mid-flight", () => {
    const sent = editReducer(
      { ...initialEditState, title: "Kadal" },
      { type: "failed", failure: { key: "sendPending", next: "recheck" }, stage: "send" },
    );
    const chosen = editReducer(sent, { type: "choose", file: new File(["x"], "again.jpg", { type: "image/jpeg" }) });

    expect(chosen.failure).toEqual({ key: "sendPending", next: "recheck" });
    expect(chosen.steps).toEqual({ pin: "done", send: "failed" });
    expect(chosen.file?.name).toBe("again.jpg");
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
    const failure = describeEditFailure(
      new VerifierError("send-failed", 502, "PassportAlreadyExists", undefined, { named: true }),
    );
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
      expect(describeEditFailure(new VerifierError(code, 500, code, undefined, { named: true })).key).toBe(key);
    }
  });

  it("never suggests sending again when the wait ran out, because the edit may still land", () => {
    const failure = describeEditFailure(new ConfirmTimeout());
    expect(failure).toEqual({ key: "confirmPending", next: "recheck" });
  });

  it("offers a second look, never a second send, when the service could not confirm the transaction", () => {
    const id = `0x${"ab".repeat(32)}` as const;
    const failure = describeEditFailure(
      new VerifierError("send-pending", 502, "send-pending", undefined, { named: true, passportId: id }),
    );
    // The child's own id comes back with the answer, so the second look is a read of that one
    // passport rather than a guess at which edit under the parent belongs to this owner.
    expect(failure).toEqual({ key: "sendPending", next: "recheck", passportId: id });
  });

  it("says the same thing about either dependency that did not answer, and offers a retry", () => {
    for (const code of ["privy-unavailable", "chain-unavailable"] as const) {
      expect(describeEditFailure(new VerifierError(code, 502, code, undefined, { named: true }))).toEqual({
        key: "dependencyDown",
        next: "later",
      });
    }
  });

  it("counts both kinds of send that are still out as pending, and a refused one as failed", () => {
    expect(isEditPending({ key: "confirmPending", next: "recheck" })).toBe(true);
    expect(isEditPending({ key: "sendPending", next: "recheck" })).toBe(true);
    expect(isEditPending({ key: "sendFailed", next: "again" })).toBe(false);
    expect(isEditPending({ key: "dependencyDown", next: "later" })).toBe(false);
    expect(isEditPending(null)).toBe(false);
  });

  it("sends a picture the registry already holds to the passport that holds it", () => {
    const id = `0x${"cd".repeat(32)}` as const;
    const failure = describeEditFailure(
      new VerifierError("already-registered", 409, "already-registered", undefined, { passportId: id, named: true }),
    );

    expect(failure).toEqual({ key: "alreadyRegistered", next: "openPassport", passportId: id });
  });

  it("never offers a retry for anything that went wrong after the send, whatever it was", () => {
    const rpc = describeEditFailure(new Error("HTTP request failed: 503"), { sent: true });
    expect(rpc).toMatchObject({ key: "confirmPending", next: "recheck" });
    expect(rpc.reason).toBe("HTTP request failed: 503");

    const reverted = describeEditFailure(new Error("Monad mined this transaction and it reverted"), { sent: true });
    expect(reverted.key).toBe("confirmPending");
    expect(reverted.next).toBe("recheck");
  });

  it("treats an answer the service never named as an edit that may be out, not as a pin that failed", () => {
    // An edge in front of the service answers 502 with an HTML page: no error name, no reason. The
    // request may have reached the service and the transaction may already be out.
    const edge = describeEditFailure(new VerifierError("pin-failed", 502, "the verify service answered 502"));
    expect(edge).toMatchObject({ key: "confirmPending", next: "recheck" });

    const dropped = describeEditFailure(new VerifierError("offline", 0, "the verify service did not answer"));
    expect(dropped.key).toBe("confirmPending");

    const unreadable = describeEditFailure(new VerifierError("bad-response", 200, "not JSON"));
    expect(unreadable.key).toBe("confirmPending");
  });

  it("keeps the service's own words for the failures it names itself", () => {
    const named = describeEditFailure(
      new VerifierError("pin-failed", 502, "pin-failed", undefined, { named: true }),
    );
    expect(named).toEqual({ key: "pinFailed", next: "again" });
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
