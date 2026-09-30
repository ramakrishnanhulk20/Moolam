import { describe, expect, it } from "vitest";
import { moolamOrigin } from "@/components/result/moolam-links";
import { isRegisteredHint, sharedAddress } from "@/components/result/window-flow";

const SITE = "https://moolam.vercel.app";
const ORIGIN = moolamOrigin(SITE);
const LOWER = "0x52908400098527886e0f7030069857d2e4169ee7";
const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("the address message from Moolam's connect page", () => {
  it("takes a well-formed address from Moolam's exact origin, checksummed", () => {
    expect(ORIGIN).toBe("https://moolam.vercel.app");
    expect(sharedAddress({ origin: SITE, data: { type: "moolam:address", address: LOWER } }, ORIGIN)).toBe(CHECKSUMMED);
    expect(sharedAddress({ origin: SITE, data: { type: "moolam:address", address: CHECKSUMMED } }, ORIGIN)).toBe(
      CHECKSUMMED,
    );
  });

  it("ignores a wrong origin, however close it looks", () => {
    for (const origin of [
      "https://evil.example",
      "https://moolam.vercel.app.evil.example",
      "http://moolam.vercel.app",
      "https://moolam.vercel.app:444",
      "null",
      "",
    ]) {
      expect(sharedAddress({ origin, data: { type: "moolam:address", address: LOWER } }, ORIGIN)).toBeNull();
    }
  });

  it("ignores every message when Moolam's origin is unknown", () => {
    expect(sharedAddress({ origin: SITE, data: { type: "moolam:address", address: LOWER } }, null)).toBeNull();
  });

  it("ignores a wrong type", () => {
    for (const data of [
      { type: "moolam:registered", address: LOWER },
      { type: "moolam:Address", address: LOWER },
      { address: LOWER },
      `{"type":"moolam:address","address":"${LOWER}"}`,
      [{ type: "moolam:address", address: LOWER }],
      null,
    ]) {
      expect(sharedAddress({ origin: SITE, data }, ORIGIN)).toBeNull();
    }
  });

  it("ignores an address that does not parse", () => {
    for (const address of [
      "0x1234",
      `${LOWER}00`,
      "0xZZ908400098527886e0f7030069857d2e4169ee7",
      "52908400098527886e0f7030069857d2e4169ee7",
      // Mixed case with a wrong checksum is a typo, not an address.
      "0x52908400098527886E0F7030069857D2E4169Ee7",
      12345,
      undefined,
    ]) {
      expect(sharedAddress({ origin: SITE, data: { type: "moolam:address", address } }, ORIGIN)).toBeNull();
    }
  });

  it("uses nothing from the message but the address", () => {
    const event = { origin: SITE, data: { type: "moolam:address", address: LOWER, passportId: "0xabc", redirect: "x" } };
    expect(sharedAddress(event, ORIGIN)).toBe(CHECKSUMMED);
  });
});

describe("the registered hint from Moolam's co-sign page", () => {
  const data = { type: "moolam:registered", passportId: `0x${"a".repeat(64)}`, txHash: `0x${"b".repeat(64)}` };

  it("is taken only from Moolam's exact origin with the right type", () => {
    expect(isRegisteredHint({ origin: SITE, data }, ORIGIN)).toBe(true);
    expect(isRegisteredHint({ origin: "https://evil.example", data }, ORIGIN)).toBe(false);
    expect(isRegisteredHint({ origin: SITE, data: { ...data, type: "moolam:address" } }, ORIGIN)).toBe(false);
    expect(isRegisteredHint({ origin: SITE, data: "moolam:registered" }, ORIGIN)).toBe(false);
    expect(isRegisteredHint({ origin: SITE, data }, null)).toBe(false);
  });

  it("is only a yes or no, so no fact in it can reach the page", () => {
    expect(typeof isRegisteredHint({ origin: SITE, data }, ORIGIN)).toBe("boolean");
  });
});
