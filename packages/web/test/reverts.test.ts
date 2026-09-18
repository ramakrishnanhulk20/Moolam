import { describe, expect, it } from "vitest";
import type { Abi } from "viem";
import registryAbiJson from "../../contracts/abi/MoolamRegistry.json";
import policyAbiJson from "../../contracts/abi/VerifierPolicy.json";
import consentAbiJson from "../../contracts/abi/MoolamConsent.json";
import { CONSENT_REVERTS, REGISTRY_REVERTS, consentRevertCopy, revertCopy } from "@/lib/chain/reverts";

function errorNames(abi: Abi): string[] {
  return abi.flatMap((item) => (item.type === "error" ? [item.name] : []));
}

const registry = errorNames(registryAbiJson as Abi);
const policy = errorNames(policyAbiJson as Abi);
const everyError = [...new Set([...registry, ...policy])].sort();
const everyConsentError = [...new Set(errorNames(consentAbiJson as Abi))].sort();

describe("the revert table against the ABIs", () => {
  it("has a line for every error the two contracts can throw", () => {
    const missing = everyError.filter((name) => REGISTRY_REVERTS[name] === undefined);
    expect(missing).toEqual([]);
    expect(everyError.length).toBe(53);
  });

  it("names nothing the contracts cannot throw, so a renamed error is caught too", () => {
    const stray = Object.keys(REGISTRY_REVERTS).filter((name) => !everyError.includes(name));
    expect(stray).toEqual([]);
  });

  it("keeps the lines the studio and the dispute panel print today", () => {
    expect(REGISTRY_REVERTS.PassportAlreadyExists).toEqual({ key: "alreadyRegistered", next: "openPassport" });
    expect(REGISTRY_REVERTS.SignatureExpired).toEqual({ key: "expired", next: "again" });
    expect(REGISTRY_REVERTS.PasskeyNotBound).toEqual({ key: "notBound", next: "bind" });
    expect(REGISTRY_REVERTS.InvalidPublicKey).toEqual({ key: "badKey", next: "bind" });
    expect(REGISTRY_REVERTS.InvalidBond).toEqual({ key: "badBond", next: "again" });
    expect(REGISTRY_REVERTS.EnforcedPause).toEqual({ key: "paused" });
    expect(REGISTRY_REVERTS.NothingToWithdraw).toEqual({ key: "nothingOwed" });
  });

  it("never offers another attempt where the chain's answer would not change", () => {
    const settled = ["PassportAlreadyExists", "DisputeAlreadyOpen", "PassportAlreadyDisputed", "NotResolver"];
    for (const name of settled) {
      expect(REGISTRY_REVERTS[name].next).not.toBe("again");
    }
  });

  it("falls back to the generic line for a failure that was not a revert this app knows", () => {
    expect(revertCopy(undefined)).toEqual({ key: "reverted", next: "again" });
    expect(revertCopy("SomethingElseEntirely")).toEqual({ key: "reverted", next: "again" });
    expect(revertCopy("SignatureExpired")).toEqual({ key: "expired", next: "again" });
  });
});

describe("the consent table against the consent ABI", () => {
  it("has a line for every error the register can throw", () => {
    const missing = everyConsentError.filter((name) => CONSENT_REVERTS[name] === undefined);
    expect(missing).toEqual([]);
    expect(everyConsentError.length).toBe(10);
  });

  it("names nothing the register cannot throw", () => {
    const stray = Object.keys(CONSENT_REVERTS).filter((name) => !everyConsentError.includes(name));
    expect(stray).toEqual([]);
  });

  it("never offers another attempt where the register's answer would not change", () => {
    expect(CONSENT_REVERTS.NotPassportHolder).toEqual({ key: "notHolder" });
    expect(CONSENT_REVERTS.TooSoon).toEqual({ key: "tooSoon" });
  });

  it("falls back to the generic line, and reads the registry's names as unknown", () => {
    expect(consentRevertCopy(undefined)).toEqual({ key: "reverted", next: "again" });
    expect(consentRevertCopy("SignatureExpired")).toEqual({ key: "reverted", next: "again" });
    expect(consentRevertCopy("ConstraintInfoTooLong")).toEqual({ key: "conditionsTooLong", next: "again" });
  });
});
