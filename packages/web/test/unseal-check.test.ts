import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { VerifierError } from "@/lib/verifier/client";
import {
  checkKeptFile,
  describeUnsealFailure,
  initialUnsealState,
  isUnsealBusy,
  isUnsealDone,
  unsealReducer,
} from "@/lib/passport/unseal";

/**
 * The check that runs on the holder's own machine before anything is published.
 *
 * A passport id is the sha-256 of the signed file, so the browser can settle
 * the whole question itself: these bytes are that passport or they are not.
 * Doing it here means the common mistake, reaching for your own copy of the
 * picture instead of the file the service handed back, costs nothing and
 * uploads nothing.
 */

/** A short file and the passport id the registry would have committed to for it. */
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...Array.from({ length: 300 }, (_, at) => (at * 31) % 251)]);
const PASSPORT = `0x${createHash("sha256").update(BYTES).digest("hex")}` as Hex;

function keptFile(bytes: Uint8Array = BYTES, name = "kadal-at-dawn.jpg"): File {
  return new File([bytes as BlobPart], name, { type: "image/jpeg" });
}

function refusal(status: number, word: string, body: Record<string, unknown> = {}): VerifierError {
  return new VerifierError(
    status === 400 ? "bad-request" : "bad-response",
    status,
    typeof body.reason === "string" ? body.reason : word,
    undefined,
    { named: true, serviceCode: word },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the file check on the device", () => {
  it("accepts the file whose hash is the passport id, and keeps its name and size", async () => {
    const checked = await checkKeptFile(keptFile(), PASSPORT);

    expect(checked.ok).toBe(true);
    expect(checked.ok ? checked.kept.name : "").toBe("kadal-at-dawn.jpg");
    expect(checked.ok ? checked.kept.size : 0).toBe(BYTES.length);
  });

  it("refuses a different picture and never uploads it", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    const other = new Uint8Array([...BYTES.slice(0, 200), 7, 7, 7]);
    const checked = await checkKeptFile(keptFile(other), PASSPORT);

    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.failure.key).toBe("notTheFile");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses the same picture with one byte changed, which is the whole point of a hash", async () => {
    const tampered = new Uint8Array(BYTES);
    tampered[tampered.length - 1] ^= 0x01;

    const checked = await checkKeptFile(keptFile(tampered), PASSPORT);
    expect(checked.ok ? "" : checked.failure.key).toBe("notTheFile");
  });

  it("reads a passport id in either case, because the chain and the service do not agree on one", async () => {
    const shouted = PASSPORT.toUpperCase().replace("0X", "0x") as Hex;
    expect((await checkKeptFile(keptFile(), shouted)).ok).toBe(true);
  });

  it("says what is wrong with a file the service would have refused anyway, before the upload", async () => {
    const notPicture = new File([new Uint8Array([1, 2, 3]) as BlobPart], "notes.txt", { type: "text/plain" });
    expect((await checkKeptFile(notPicture, PASSPORT)).ok).toBe(false);

    const empty = new File([], "kadal.jpg", { type: "image/jpeg" });
    const checked = await checkKeptFile(empty, PASSPORT);
    expect(checked.ok ? "" : checked.failure.key).toBe("empty");
  });
});

describe("the panel's state", () => {
  it("drops the file it had proved the moment another one is chosen", () => {
    const kept = { file: keptFile(), name: "kadal-at-dawn.jpg", size: BYTES.length };
    const ready = unsealReducer(initialUnsealState, { type: "kept", kept });
    expect(ready.kept).not.toBeNull();

    const choosing = unsealReducer(ready, { type: "checking" });
    expect(choosing.kept).toBeNull();
    expect(isUnsealBusy(choosing)).toBe(true);
  });

  it("is done only once the four addresses are in, and keeps the allowance across a refusal", () => {
    const busy = unsealReducer(initialUnsealState, { type: "sending" });
    expect(isUnsealDone(busy)).toBe(false);

    const failed = unsealReducer(busy, {
      type: "failed",
      failure: { key: "busy" },
      quota: { used: 2, limit: 5, resetsAt: 1_788_961_533 },
    });
    expect(failed.sending).toBe(false);
    expect(failed.quota?.used).toBe(2);
    expect(unsealReducer(failed, { type: "reset" }).quota?.used).toBe(2);
  });
});

describe("the sentence each refusal gets", () => {
  const cases: [string, string][] = [
    ["hash-mismatch", "notTheFile"],
    ["fingerprint-mismatch", "fingerprintMismatch"],
    ["not-holder", "notHolder"],
    ["no-passport", "noPassport"],
    ["not-sealed", "notSealed"],
    ["already-unsealed", "alreadyUnsealed"],
    ["thumbnail-too-large", "thumbnailTooLarge"],
    ["quota", "quota"],
    ["global-limit", "todayFull"],
    ["pin-failed", "pinFailed"],
    ["record-pin-failed", "recordPinFailed"],
    ["chain-unavailable", "dependencyDown"],
    ["metadata-unavailable", "dependencyDown"],
    ["privy-unavailable", "dependencyDown"],
    ["lookup-unavailable", "lookupUnavailable"],
    ["busy", "busy"],
  ];

  // That each of these keys is a real sentence in all ten languages is
  // test/unseal-copy.test.ts, which reads the message files themselves.
  it.each(cases)("%s is said as %s", (word, key) => {
    expect(describeUnsealFailure(refusal(400, word)).key).toBe(key);
  });

  it("points a holder whose picture is already public at the page rather than at a retry", () => {
    expect(describeUnsealFailure(refusal(409, "already-unsealed")).next).toBe("showPicture");
    expect(describeUnsealFailure(refusal(409, "not-sealed")).next).toBe("showPicture");
  });

  it("prints the service's own words under a sentence, and never the code twice", () => {
    const withReason = new VerifierError("bad-response", 422, "this picture cannot be reduced", undefined, {
      named: true,
      serviceCode: "thumbnail-too-large",
    });
    expect(describeUnsealFailure(withReason).reason).toBe("this picture cannot be reduced");
    expect(describeUnsealFailure(refusal(409, "not-sealed")).reason).toBeUndefined();
  });

  it("names a signed out session and a service that never answered as themselves", () => {
    const signedOut = new VerifierError("unauthorized", 401, "unauthorized", undefined, { named: true, serviceCode: "unauthorized" });
    expect(describeUnsealFailure(signedOut)).toEqual({ key: "signedOut", next: "signIn" });

    const offline = new VerifierError("offline", 0, "the verify service did not answer");
    expect(describeUnsealFailure(offline).key).toBe("offline");
  });

  it("falls back to one readable line for anything nobody has named", () => {
    expect(describeUnsealFailure(new Error("window closed")).key).toBe("unknown");
    expect(describeUnsealFailure(new Error("window closed")).reason).toBe("window closed");
  });
});
