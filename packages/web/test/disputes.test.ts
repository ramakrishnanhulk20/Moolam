import { decodeFunctionData, encodeErrorResult, getAddress, keccak256, parseEther, toBytes, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { CHAIN_ID, addresses, registryAbi } from "@/lib/chain/client";
import { flagCalldata, resolveCalldata, withdrawCalldata } from "@/lib/chain/calldata";
import { REASON_MAX, REASON_MIN, checkReason, evidenceHash, evidenceMatches, evidenceUri, reasonFrom } from "@/lib/disputes/evidence";
import {
  bondCheck,
  describeFlagFailure,
  flagReducer,
  flagRequest,
  initialFlagState,
  isFlagBusy,
  isFlagDone,
  isFlagUnconfirmed,
  reasonFailure,
  type FlagState,
} from "@/lib/disputes/flag";
import { Reverted } from "@/lib/chain/watch";
import { ConfirmTimeout } from "@/lib/studio/confirm";

const PASSPORT = `0x${"7d".repeat(32)}` as Hex;
const WALLET = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
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

  it("never offers a second send when the wait ran out, and points at the account instead", () => {
    expect(describeFlagFailure(new ConfirmTimeout())).toEqual({ key: "confirmPending", next: "recheck" });
    expect(describeFlagFailure(new ConfirmTimeout(WALLET))).toEqual({
      key: "confirmPending",
      next: "recheck",
      address: WALLET,
    });
  });

  it("reads the one shared table, so a revert no dispute screen listed still gets its own sentence", () => {
    const expired = encodeErrorResult({ abi: registryAbi, errorName: "SignatureExpired", args: [1n] });
    expect(describeFlagFailure({ cause: { data: expired } })).toMatchObject({
      key: "expired",
      reason: "SignatureExpired",
      next: "again",
    });

    // In the table, but with no offer a dispute screen could act on. It names
    // itself and stops there.
    const transfer = encodeErrorResult({ abi: registryAbi, errorName: "TransferFailed", args: [] });
    expect(describeFlagFailure({ cause: { data: transfer } })).toMatchObject({
      key: "reverted",
      reason: "TransferFailed",
    });
  });

  it("names a mined revert as one, rather than dumping the request back", () => {
    const said = describeFlagFailure(new Reverted(`0x${"9a".repeat(32)}`));
    expect(said.key).toBe("reverted");
    expect(said.reason).toContain("reverted");
    expect(said.reason).not.toContain("Request Arguments");
  });

  it("treats every wallet's way of saying cancelled as a decision", () => {
    expect(describeFlagFailure({ code: 4001 }).key).toBe("declined");
    expect(describeFlagFailure(Object.assign(new Error("no"), { name: "NotAllowedError" })).key).toBe("declined");
    expect(describeFlagFailure(new Error("User canceled flow")).key).toBe("declined");
  });

  it("treats a closed wallet window as a decision, not a fault", () => {
    expect(describeFlagFailure(new Error("User rejected the request.")).key).toBe("declined");
  });

  it("names a wallet that cannot cover the value", () => {
    expect(describeFlagFailure(new Error("insufficient funds for gas * price + value")).key).toBe("notEnough");
  });
});

describe("a flag that is out and has not been shown", () => {
  const PENDING = { key: "confirmPending", next: "recheck" as const };

  function unconfirmed(): FlagState {
    const sent = flagReducer({ ...initialFlagState, open: true, reason: REASON }, { type: "start" });
    const out = flagReducer(sent, { type: "sent", hash: `0x${"3f".repeat(32)}` });
    return flagReducer(out, { type: "failed", failure: PENDING, stage: "send" });
  }

  it("gets a step state of its own, which is neither done nor failed", () => {
    const state = unconfirmed();
    expect(state.steps.send).toBe("unconfirmed");
    expect(isFlagUnconfirmed(state)).toBe(true);
    expect(isFlagDone(state)).toBe(false);
  });

  it("keeps the panel busy, so nothing offers a second send", () => {
    expect(isFlagBusy(unconfirmed())).toBe(true);
  });

  it("refuses to start again: the recheck is the only way on", () => {
    const state = unconfirmed();
    expect(flagReducer(state, { type: "start" })).toBe(state);
    expect(flagReducer(state, { type: "reset" })).toBe(state);
  });

  it("never drops the notice quietly when the reason is edited", () => {
    const typed = flagReducer(unconfirmed(), { type: "reason", reason: `${REASON} And one more thing.` });
    expect(typed.failure).toEqual(PENDING);
    expect(typed.steps.send).toBe("unconfirmed");
  });

  it("clears an ordinary failure the moment the reason changes", () => {
    const refused = flagReducer({ ...initialFlagState, open: true }, {
      type: "failed",
      failure: { key: "alreadyOpen" },
      stage: "account",
    });
    expect(flagReducer(refused, { type: "reason", reason: REASON }).failure).toBeNull();
  });

  it("is done, with no notice left over, once the recheck finds it", () => {
    const landed = flagReducer(unconfirmed(), { type: "recorded", block: 41_273_109n });
    expect(landed.steps.send).toBe("done");
    expect(landed.failure).toBeNull();
    expect(isFlagBusy(landed)).toBe(false);
  });
});
