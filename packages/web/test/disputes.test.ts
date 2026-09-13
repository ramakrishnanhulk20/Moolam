import { decodeFunctionData, encodeErrorResult, getAddress, keccak256, parseEther, toBytes, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { CHAIN_ID, addresses, registryAbi } from "@/lib/chain/client";
import { flagCalldata, resolveCalldata, withdrawCalldata } from "@/lib/chain/calldata";
import { REASON_MAX, REASON_MIN, checkReason, evidenceHash, evidenceMatches, evidenceUri, reasonFrom } from "@/lib/disputes/evidence";
import { bondCheck, describeFlagFailure, flagRequest, reasonFailure } from "@/lib/disputes/flag";
import { ConfirmTimeout } from "@/lib/studio/confirm";

const PASSPORT = `0x${"7d".repeat(32)}` as Hex;
const BOND = parseEther("1");
const REASON = "This picture was taken from a stock library and registered by someone who did not make it.";

describe("the flag calldata", () => {
  it("encodes flag so the ABI decodes the same id and URI back", () => {
    const uri = evidenceUri(REASON);
    const decoded = decodeFunctionData({ abi: registryAbi, data: flagCalldata(PASSPORT, uri) });

    expect(decoded.functionName).toBe("flag");
    expect(decoded.args?.[0]).toBe(PASSPORT);
    expect(decoded.args?.[1]).toBe(uri);
  });

  it("sends the bond as the value on the transaction, to the registry, on Monad", () => {
    const request = flagRequest({ passportId: PASSPORT, reason: REASON, bond: BOND });

    expect(request.value).toBe(BOND);
    expect(getAddress(request.to)).toBe(getAddress(addresses.registry));
    expect(request.chainId).toBe(CHAIN_ID);
    expect(decodeFunctionData({ abi: registryAbi, data: request.data }).args?.[1]).toBe(evidenceUri(REASON));
  });

  it("carries the reason with no surrounding space, whatever was typed", () => {
    const request = flagRequest({ passportId: PASSPORT, reason: `  ${REASON}  `, bond: BOND });
    expect(decodeFunctionData({ abi: registryAbi, data: request.data }).args?.[1]).toBe(evidenceUri(REASON));
  });
});

describe("the resolver's calldata", () => {
  it("encodes resolve with the passport and the outcome, both ways round", () => {
    for (const upheld of [true, false]) {
      const decoded = decodeFunctionData({ abi: registryAbi, data: resolveCalldata(PASSPORT, upheld) });
      expect(decoded.functionName).toBe("resolve");
      expect(decoded.args?.[0]).toBe(PASSPORT);
      expect(decoded.args?.[1]).toBe(upheld);
    }
  });

  it("encodes withdraw as the bare selector the ABI names", () => {
    expect(withdrawCalldata()).toBe(toFunctionSelector("withdraw()"));
    expect(decodeFunctionData({ abi: registryAbi, data: withdrawCalldata() }).functionName).toBe("withdraw");
  });
});

describe("the reason, and how it reaches the chain", () => {
  it("refuses a reason that is too short or too long, and takes one in between", () => {
    expect(checkReason("too short")).toBe("reasonShort");
    expect(checkReason("x".repeat(REASON_MIN - 1))).toBe("reasonShort");
    expect(checkReason("x".repeat(REASON_MIN))).toBeNull();
    expect(checkReason("x".repeat(REASON_MAX))).toBeNull();
    expect(checkReason("x".repeat(REASON_MAX + 1))).toBe("reasonLong");
    expect(reasonFailure("too short")?.key).toBe("reasonShort");
    expect(reasonFailure(REASON)).toBeNull();
  });

  it("survives the trip through the URI, punctuation, quotes and other scripts included", () => {
    const awkward = "It is a copy of \"Kadal\", posted by ஒருவர் in 2024 & re-registered here. 100% the same file.";
    expect(reasonFrom(evidenceUri(awkward))).toBe(awkward);
  });

  it("hashes the URI the way the contract does, over its bytes", () => {
    const uri = evidenceUri(REASON);
    expect(evidenceHash(uri)).toBe(keccak256(toBytes(uri)));
    expect(evidenceMatches(uri, evidenceHash(uri))).toBe(true);
    expect(evidenceMatches(uri, keccak256(toBytes(`${uri}.`)))).toBe(false);
  });

  it("reads nothing out of a URI that points somewhere else", () => {
    expect(reasonFrom("ipfs://bafkreievidence")).toBeNull();
    expect(reasonFrom("data:text/plain;charset=utf-8,")).toBeNull();
  });
});

describe("whether the account can cover the bond", () => {
  it("says nothing until both numbers are read", () => {
    expect(bondCheck(null, BOND)).toBeNull();
    expect(bondCheck(BOND, null)).toBeNull();
  });

  it("takes a balance equal to the bond, because Privy pays the fee", () => {
    expect(bondCheck(BOND, BOND)).toEqual({ enough: true, shortfall: 0n });
  });

  it("names the exact shortfall when the account is short", () => {
    expect(bondCheck(parseEther("0.4"), BOND)).toEqual({ enough: false, shortfall: parseEther("0.6") });
  });
});

describe("what the screen says when the chain refuses", () => {
  const cases: [string, unknown[], string][] = [
    ["InvalidBond", [0n, BOND], "badBond"],
    ["DisputeAlreadyOpen", [PASSPORT], "alreadyOpen"],
    ["PassportAlreadyDisputed", [PASSPORT], "alreadyDisputed"],
    ["PassportNotFound", [PASSPORT], "notFound"],
    ["EnforcedPause", [], "paused"],
    ["NotResolver", [addresses.registry], "notResolver"],
    ["NoOpenDispute", [PASSPORT], "noOpenDispute"],
    ["NothingToWithdraw", [], "nothingOwed"],
  ];

  for (const [errorName, args, key] of cases) {
    it(`turns ${errorName} into its own sentence`, () => {
      const data = encodeErrorResult({ abi: registryAbi, errorName, args });
      expect(describeFlagFailure({ cause: { data } })).toMatchObject({ key, reason: errorName });
    });
  }

  it("offers another try only for a bond that did not match, which a fresh read fixes", () => {
    const bad = encodeErrorResult({ abi: registryAbi, errorName: "InvalidBond", args: [0n, BOND] });
    const open = encodeErrorResult({ abi: registryAbi, errorName: "DisputeAlreadyOpen", args: [PASSPORT] });

    expect(describeFlagFailure({ cause: { data: bad } }).next).toBe("again");
    expect(describeFlagFailure({ cause: { data: open } }).next).toBeUndefined();
  });

  it("never offers a second send when the wait ran out", () => {
    expect(describeFlagFailure(new ConfirmTimeout())).toEqual({ key: "confirmPending", next: "recheck" });
  });

  it("treats a closed wallet window as a decision, not a fault", () => {
    expect(describeFlagFailure(new Error("User rejected the request.")).key).toBe("declined");
  });

  it("names a wallet that cannot cover the value", () => {
    expect(describeFlagFailure(new Error("insufficient funds for gas * price + value")).key).toBe("notEnough");
  });
});
