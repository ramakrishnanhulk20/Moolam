import { describe, expect, it } from "vitest";
import { isUserCancellation } from "@/lib/errors/cancelled";

describe("a prompt the person closed themselves", () => {
  it("reads the EIP-1193 code every wallet sends", () => {
    expect(isUserCancellation({ code: 4001, message: "" })).toBe(true);
    expect(isUserCancellation(Object.assign(new Error("declined"), { code: 4001 }))).toBe(true);
  });

  it("reads the words Privy throws when its window is closed", () => {
    // Privy's own strings, checked against @privy-io/react-auth 3.40.0.
    expect(isUserCancellation(new Error("User rejected request"))).toBe(true);
    expect(isUserCancellation(new Error("The user rejected the request."))).toBe(true);
    expect(isUserCancellation(new Error("User canceled flow"))).toBe(true);
    expect(isUserCancellation(new Error("User cancelled funding"))).toBe(true);
    expect(isUserCancellation(new Error("User exited before their wallet could be recovered"))).toBe(true);
    expect(isUserCancellation(new Error("User denied confirmation during OAuth flow"))).toBe(true);
  });

  it("reads a passkey prompt that was dismissed, which arrives by name and not by code", () => {
    expect(isUserCancellation(Object.assign(new Error("timed out"), { name: "NotAllowedError" }))).toBe(true);
    expect(isUserCancellation(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isUserCancellation(Object.assign(new Error("rejected"), { name: "UserRejectedRequestError" }))).toBe(true);
  });

  it("reads the loose wording the three screens matched on before", () => {
    expect(isUserCancellation("the modal was closed")).toBe(true);
    expect(isUserCancellation(new Error("The request was cancelled"))).toBe(true);
    expect(isUserCancellation({ message: "user canceled" })).toBe(true);
  });

  it("is not fooled by a real failure", () => {
    expect(isUserCancellation(new Error("insufficient funds for gas"))).toBe(false);
    expect(isUserCancellation(new Error("execution reverted: PasskeyNotBound"))).toBe(false);
    expect(isUserCancellation(new Error("Monad has not shown this write 90 seconds after it was accepted"))).toBe(
      false,
    );
    expect(isUserCancellation(null)).toBe(false);
    expect(isUserCancellation(undefined)).toBe(false);
  });
});
