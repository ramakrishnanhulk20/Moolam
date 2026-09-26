// Covers how lookup_agent decodes an ERC-8004 registration card held inline in a data: URI: the
// raw JSON form agent 10248 carries today, the base64 form RegisterAgent.updateCard writes, and the
// malformed inputs that must give no card at all.
// Does NOT cover reading tokenURI from the registry, nor cards hosted on IPFS or HTTPS, which
// lookup_agent returns as a plain reference without fetching.

import { describe, expect, it } from "vitest";
import { decodeCard } from "../src/agent/tools.js";

/** The card tokenURI(10248) returned from Monad mainnet on 2026-09-26. */
const CARD = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Moolam demo generator",
  description:
    "The generator agent behind the Moolam demo. It signs the fingerprint of every image it makes, so each passport names the agent that made it.",
  services: [],
  active: true,
};
const JSON_TEXT = JSON.stringify(CARD);
const BASE64 = Buffer.from(JSON_TEXT, "utf8").toString("base64");

describe("decodeCard", () => {
  it("reads the raw JSON form written after data:application/json,", () => {
    expect(decodeCard(`data:application/json,${JSON_TEXT}`)).toEqual(CARD);
  });

  it("reads the base64 form ERC-8004 recommends for a card stored on chain", () => {
    expect(decodeCard(`data:application/json;base64,${BASE64}`)).toEqual(CARD);
    expect(decodeCard(`data:application/json;charset=utf-8;base64,${BASE64}`)).toEqual(CARD);
  });

  it("reads non-ASCII text in a base64 card as UTF-8", () => {
    const card = { name: "மூலம்" };
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;
    expect(decodeCard(uri)).toEqual(card);
  });

  it("gives no card for a URI that points somewhere else", () => {
    expect(decodeCard("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toBeUndefined();
    expect(decodeCard("https://example.com/agent.json")).toBeUndefined();
    expect(decodeCard(`data:text/plain;base64,${BASE64}`)).toBeUndefined();
  });

  it("gives no card rather than a half decoded one when the base64 is damaged", () => {
    expect(decodeCard(`data:application/json;base64,${BASE64.slice(0, -1)}`)).toBeUndefined();
    expect(decodeCard(`data:application/json;base64,${BASE64.slice(0, 8)}!${BASE64.slice(9)}`)).toBeUndefined();
    expect(decodeCard(`data:application/json;base64,${Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")}`)).toBeUndefined();
    expect(decodeCard("data:application/json;base64")).toBeUndefined();
  });

  it("gives no card when the decoded text is not JSON", () => {
    expect(decodeCard(`data:application/json;base64,${Buffer.from("not json").toString("base64")}`)).toBeUndefined();
    expect(decodeCard("data:application/json,{\"name\":")).toBeUndefined();
  });
});
