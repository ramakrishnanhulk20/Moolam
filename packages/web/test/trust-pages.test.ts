import { describe, expect, it } from "vitest";
import { readCard } from "@/components/agent/card";
import { transactionFor } from "@/components/passport/indexed";
import { attestationSource, standingClass, standingOf } from "@/components/passport/labels";
import { addresses } from "@/lib/chain/client";

const CHAINLINK_RECEIVER = addresses.receiver;
const SOMEONE_ELSE = "0x1111111111111111111111111111111111111111";

describe("who wrote an attestation", () => {
  it("names the deployed receiver as Chainlink, whatever case the address arrives in", () => {
    expect(attestationSource(CHAINLINK_RECEIVER)).toBe("chainlink");
    expect(attestationSource(CHAINLINK_RECEIVER.toLowerCase())).toBe("chainlink");
    expect(attestationSource(CHAINLINK_RECEIVER.toUpperCase().replace("0X", "0x"))).toBe("chainlink");
  });

  it("does not name any other receiver", () => {
    expect(attestationSource(SOMEONE_ELSE)).toBe("other");
    expect(attestationSource(addresses.registry)).toBe("other");
  });

  it("names the private re-check's receiver as Chainlink too, since only the confidential workflow writes through it", () => {
    expect(attestationSource(addresses.sealedReceiver)).toBe("chainlink");
    expect(attestationSource(addresses.sealedReceiver.toLowerCase())).toBe("chainlink");
  });

  it("takes the receivers to compare against as an argument, so a redeploy is one value", () => {
    expect(attestationSource(SOMEONE_ELSE, [SOMEONE_ELSE])).toBe("chainlink");
    expect(attestationSource(CHAINLINK_RECEIVER, [SOMEONE_ELSE])).toBe("other");
  });
});

describe("where a passport stands", () => {
  it("is unverified until someone has re-checked it", () => {
    expect(standingOf({ disputed: false, attestations: [] })).toBe("unverified");
    expect(standingClass("unverified")).toBe("text-text-faint");
  });

  it("is verified when every re-check matched", () => {
    expect(standingOf({ disputed: false, attestations: [{ matched: true }] })).toBe("verified");
    expect(standingClass("verified")).toBe("text-verified");
  });

  it("never reads as verified when a re-check missed", () => {
    expect(standingOf({ disputed: false, attestations: [{ matched: true }, { matched: false }] })).toBe("mismatched");
    expect(standingClass("mismatched")).toBe("text-failed");
  });

  it("lets a dispute outrank a passing re-check", () => {
    expect(standingOf({ disputed: true, attestations: [{ matched: true }] })).toBe("disputed");
    expect(standingClass("disputed")).toBe("text-failed");
  });

  it("reads an edit of a disputed picture as disputed, though the registry never marked it", () => {
    expect(standingOf({ disputed: false, inherited: true, attestations: [{ matched: true }] })).toBe("disputed");
  });

  it("says only what the chain said when no index could answer for the lineage", () => {
    expect(standingOf({ disputed: false, inherited: false, attestations: [{ matched: true }] })).toBe("verified");
    expect(standingOf({ disputed: false, attestations: [] })).toBe("unverified");
  });
});

describe("pairing a chain attestation with the index row that carries its transaction", () => {
  const indexed = [
    {
      txHash: `0x${"aa".repeat(32)}` as `0x${string}`,
      receiver: CHAINLINK_RECEIVER.toLowerCase(),
      matched: true,
      distance: 0,
      at: 1788876281n,
    },
  ];

  it("finds the row by receiver, time and distance", () => {
    expect(transactionFor(indexed, { receiver: CHAINLINK_RECEIVER, at: 1788876281n, distance: 0 })).toBe(indexed[0].txHash);
  });

  it("gives nothing back rather than the wrong transaction", () => {
    expect(transactionFor(indexed, { receiver: CHAINLINK_RECEIVER, at: 1788876282n, distance: 0 })).toBeUndefined();
    expect(transactionFor(indexed, { receiver: SOMEONE_ELSE, at: 1788876281n, distance: 0 })).toBeUndefined();
    expect(transactionFor([], { receiver: CHAINLINK_RECEIVER, at: 1788876281n, distance: 0 })).toBeUndefined();
  });
});

describe("the ERC-8004 agent card", () => {
  const live = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Moolam demo generator",
    description: "The generator agent behind the Moolam demo.",
    services: [],
    active: true,
  };

  it("reads the card the demo agent actually carries", () => {
    const card = readCard(live);
    expect(card).toMatchObject({ name: "Moolam demo generator", active: true, serviceCount: 0 });
  });

  it("says nothing about Privy when the card records nothing about it", () => {
    expect(readCard(live)?.privy).toBeNull();
  });

  it("reports a wallet or a policy only when the card holds one", () => {
    expect(readCard({ ...live, privy: { walletId: "wallet-123" } })?.privy).toEqual({
      walletId: "wallet-123",
      policyIds: [],
    });
    expect(readCard({ ...live, privy: { policyIds: ["policy-a", "policy-b"] } })?.privy).toEqual({
      walletId: undefined,
      policyIds: ["policy-a", "policy-b"],
    });
    expect(readCard({ ...live, policyId: "policy-c" })?.privy).toEqual({ walletId: undefined, policyIds: ["policy-c"] });
  });

  it("returns null for a card that is not an object of the right shape", () => {
    expect(readCard(null)).toBeNull();
    expect(readCard("a string")).toBeNull();
    expect(readCard({ name: 42 })).toBeNull();
  });
});
