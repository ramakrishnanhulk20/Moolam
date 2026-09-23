// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Hex } from "viem";
import type { PassportListing } from "@/lib/data/passports";
import type { CreatorPassports } from "@/lib/studio/useCreatorPassports";

/**
 * /mine promises every picture an account has registered, so its list reads
 * the index a page at a time behind a Load more. The index is stood in for
 * here with reads the test answers by hand, which is how a slow page, a failed
 * page and a wallet switch in the middle of a read are made to happen on cue.
 * Nothing in this file reaches the hosted index or an IPFS gateway.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Read {
  wallet: Hex;
  limit: number;
  offset: number;
  answer: (rows: PassportListing[]) => void;
  fail: (message: string) => void;
}

const index = vi.hoisted(() => ({ reads: [] as Read[] }));

vi.mock("@/lib/data/passports", () => ({
  passportsByCreator: (wallet: Hex, limit: number, offset: number) =>
    new Promise<PassportListing[]>((resolve, reject) => {
      index.reads.push({ wallet, limit, offset, answer: resolve, fail: (message) => reject(new Error(message)) });
    }),
}));

const { useCreatorPassports } = await import("@/lib/studio/useCreatorPassports");

const ALICE = `0x${"a1".repeat(20)}` as Hex;
const BOB = `0x${"b2".repeat(20)}` as Hex;

/** `count` rows for one wallet, newest first, numbered from `from` so two pages never share an id by accident. */
function rows(count: number, from = 0, tag = "a"): PassportListing[] {
  return Array.from({ length: count }, (_, at) => {
    const n = from + at;
    return {
      id: `0x${tag.repeat(2)}${n.toString(16).padStart(62, "0")}` as Hex,
      kind: 0,
      registeredAt: BigInt(2_000_000_000 - n),
      registeredBlock: BigInt(100_000_000 - n),
      metadataURI: `ipfs://meta-${tag}-${n}`,
    };
  });
}

let seen: CreatorPassports;
let root: Root;

function Probe({ wallet, show }: { wallet: Hex | undefined; show: (value: CreatorPassports) => void }) {
  show(useCreatorPassports(wallet));
  return null;
}

function keep(value: CreatorPassports) {
  seen = value;
}

function mount(wallet: Hex | undefined) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(createElement(Probe, { wallet, show: keep }));
  });
}

function rerender(wallet: Hex | undefined) {
  act(() => {
    root.render(createElement(Probe, { wallet, show: keep }));
  });
}

/** Lets every promise the hook is waiting on run, and React draw what they set. */
async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function answer(read: Read | undefined, given: PassportListing[]) {
  if (read === undefined) {
    throw new Error("the hook never asked the index");
  }
  read.answer(given);
  await settle();
}

async function fail(read: Read | undefined, message: string) {
  if (read === undefined) {
    throw new Error("the hook never asked the index");
  }
  read.fail(message);
  await settle();
}

function more() {
  act(() => {
    seen.more();
  });
}

const last = () => index.reads[index.reads.length - 1];
const ids = () => seen.passports.map((row) => row.id);

beforeEach(() => {
  index.reads = [];
  // The gateway answers every metadata read with a title, so a row that has
  // its title has been through the second round and one without has not.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ name: `title for ${String(url).split("/").pop()}` }),
    })),
  );
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("reading an account's pictures a page at a time", () => {
  it("asks for one row more than a page and offers Load more when the thirteenth comes back", async () => {
    mount(ALICE);
    expect(last()).toMatchObject({ wallet: ALICE, limit: 13, offset: 0 });

    await answer(last(), rows(13));
    expect(seen.status).toBe("ready");
    expect(seen.passports).toHaveLength(12);
    expect(seen.hasMore).toBe(true);
    expect(seen.loadingMore).toBe(false);
  });

  it("does not offer Load more to an account with exactly twelve", async () => {
    mount(ALICE);
    await answer(last(), rows(12));
    expect(seen.passports).toHaveLength(12);
    expect(seen.hasMore).toBe(false);

    more();
    expect(index.reads).toHaveLength(1);
  });

  it("puts the next page under the first, in order, with no id twice", async () => {
    mount(ALICE);
    await answer(last(), rows(13));

    more();
    expect(seen.loadingMore).toBe(true);
    expect(last()).toMatchObject({ wallet: ALICE, limit: 13, offset: 12 });

    // A second press while the page is on its way asks for nothing more.
    more();
    expect(index.reads).toHaveLength(2);

    // A picture registered between the two presses pushes row 11 down into
    // this page, so the index hands it back a second time.
    await answer(last(), [...rows(1, 11), ...rows(5, 12)]);
    expect(seen.loadingMore).toBe(false);
    expect(seen.hasMore).toBe(false);
    expect(ids()).toEqual(rows(17).map((row) => row.id));
    expect(new Set(ids()).size).toBe(ids().length);
    expect(seen.passports[16].title).toBe("title for meta-a-16");
  });

  it("keeps walking while every page comes back full", async () => {
    mount(ALICE);
    await answer(last(), rows(13));
    more();
    await answer(last(), rows(13, 12));
    expect(seen.passports).toHaveLength(24);
    expect(seen.hasMore).toBe(true);

    more();
    expect(last()).toMatchObject({ offset: 24 });
    await answer(last(), rows(3, 24));
    expect(ids()).toEqual(rows(27).map((row) => row.id));
    expect(seen.hasMore).toBe(false);
  });

  it("keeps the first page on screen when the second one fails, and says why", async () => {
    mount(ALICE);
    await answer(last(), rows(13));
    const first = ids();

    more();
    await fail(last(), "the Envio endpoint answered 429");
    expect(seen.status).toBe("ready");
    expect(ids()).toEqual(first);
    expect(seen.moreError).toBe("the Envio endpoint answered 429");
    expect(seen.loadingMore).toBe(false);
    expect(seen.hasMore).toBe(true);

    // The press is still there, and it asks for the same page again.
    more();
    expect(last()).toMatchObject({ offset: 12 });
    expect(seen.moreError).toBeNull();
    await answer(last(), rows(2, 12));
    expect(seen.passports).toHaveLength(14);
  });

  it("never lets a page read for one wallet land in another's list", async () => {
    mount(ALICE);
    await answer(last(), rows(13));
    more();
    const aliceSecond = last();

    rerender(BOB);
    expect(seen.status).toBe("reading");
    expect(seen.passports).toHaveLength(0);
    const bobFirst = last();
    expect(bobFirst).toMatchObject({ wallet: BOB, offset: 0 });

    // Alice's page lands first, while Bob's list is still being read, then Bob's.
    await answer(aliceSecond, rows(5, 12));
    expect(seen.passports).toHaveLength(0);
    await answer(bobFirst, rows(3, 0, "b"));
    expect(ids()).toEqual(rows(3, 0, "b").map((row) => row.id));
    expect(seen.hasMore).toBe(false);
  });

  it("drops a wallet's first page that lands after the switch", async () => {
    mount(ALICE);
    const aliceFirst = last();
    rerender(BOB);
    const bobFirst = last();

    await answer(bobFirst, rows(2, 0, "b"));
    await answer(aliceFirst, rows(13));
    expect(ids()).toEqual(rows(2, 0, "b").map((row) => row.id));
  });

  it("starts again from the first page on refresh", async () => {
    mount(ALICE);
    await answer(last(), rows(13));
    more();
    await answer(last(), rows(13, 12));
    expect(seen.passports).toHaveLength(24);

    act(() => seen.refresh());
    expect(last()).toMatchObject({ wallet: ALICE, limit: 13, offset: 0 });
    await answer(last(), rows(13));
    expect(seen.passports).toHaveLength(12);
    expect(seen.hasMore).toBe(true);

    more();
    expect(last()).toMatchObject({ offset: 12 });
  });

  it("drops a page that was in flight when refresh started over", async () => {
    mount(ALICE);
    await answer(last(), rows(13));
    more();
    const stale = last();

    act(() => seen.refresh());
    const fresh = last();
    await answer(fresh, rows(13));
    await answer(stale, rows(5, 12));
    expect(seen.passports).toHaveLength(12);
    expect(seen.loadingMore).toBe(false);
  });

  it("shows the rows before their pictures, then fills the titles in", async () => {
    let letGatewayAnswer: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGatewayAnswer = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        await gate;
        return { ok: true, json: async () => ({ name: `title for ${String(url).split("/").pop()}` }) };
      }),
    );

    mount(ALICE);
    await answer(last(), rows(3));
    expect(seen.passports).toHaveLength(3);
    expect(seen.passports[0].title).toBeUndefined();

    letGatewayAnswer();
    await settle();
    expect(seen.passports[0].title).toBe("title for meta-a-0");
  });

  it("reads nothing until there is a wallet", () => {
    mount(undefined);
    expect(index.reads).toHaveLength(0);
    expect(seen.status).toBe("reading");
    expect(seen.hasMore).toBe(false);
  });
});
