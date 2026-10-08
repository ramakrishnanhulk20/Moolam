import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { Hex } from "viem";

/**
 * The three reads a disputed passport page makes (WO-332 step 1).
 *
 * The passport page is built once a minute. A fetch that is never kept, made
 * outside a held read, makes Next throw "changed from static to dynamic" out of
 * that page, so the index's row, the holder's answer and the published decision
 * are held under the passport's own name like every other read on it. The
 * stand-in for Next's cache keeps answers under the key Next would use and keeps
 * no throw, which is how Next treats one.
 * Does NOT cover a real Next render: the cache here is a stand-in.
 */

const hold = vi.hoisted(() => ({
  filed: [] as { keyParts: string[]; options: { revalidate?: number; tags?: string[] } }[],
  store: new Map<string, unknown>(),
  depth: 0,
  /** Fetches made while no held read was running: what would throw inside an ISR page. */
  outside: [] as string[],
  asked: [] as string[],
  indexRow: null as unknown,
  indexStatus: 200,
  answerStatus: 200,
  answerBody: null as unknown,
  decisionStatus: 200,
  decisionRows: [] as unknown[],
}));

vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
    options: { revalidate?: number; tags?: string[] },
  ) => {
    hold.filed.push({ keyParts, options });
    return async (...args: unknown[]) => {
      const key = [...keyParts, JSON.stringify(args)].join("|");
      if (hold.store.has(key)) {
        return hold.store.get(key);
      }
      hold.depth += 1;
      try {
        const answer = await fn(...args);
        hold.store.set(key, answer === undefined ? undefined : (JSON.parse(JSON.stringify(answer)) as unknown));
        return hold.store.get(key);
      } finally {
        hold.depth -= 1;
      }
    };
  },
}));

vi.mock("@/lib/data/source", () => ({
  activeSource: () => "envio",
  envioUrl: () => "https://index.example/v1/graphql",
}));
vi.mock("@/lib/chain/time", () => ({ headTimestamp: async () => 1_788_965_000n }));
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key, getFormatter: async () => ({}) }));

const { passportTag } = await import("@/lib/chain/registry");
const { heldIndexedRow } = await import("@/lib/disputes/indexed");
const { heldAnswer, readAnswer } = await import("@/lib/disputes/answerService");
const { heldDecision } = await import("@/lib/disputes/decisions");
const { DisputeNote } = await import("@/components/passport/DisputeNote");

const ID = `0x${"CD".repeat(32)}` as Hex;
const LOWER = `0x${"cd".repeat(32)}`;
const CHALLENGER = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const OPENED_AT = 1_788_961_533;

const ROW = {
  id: LOWER,
  challenger: CHALLENGER,
  bond: "1000000000000000000",
  evidenceHash: `0x${"ab".repeat(32)}`,
  evidenceURI: "data:text/plain,claim",
  status: 1,
  openedAt: String(OPENED_AT),
  resolvedAt: null,
  resolver: null,
  passport: { metadataURI: "ipfs://meta" },
};

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  hold.filed.length = 0;
  hold.store.clear();
  hold.depth = 0;
  hold.outside.length = 0;
  hold.asked.length = 0;
  hold.indexRow = ROW;
  hold.indexStatus = 200;
  hold.answerStatus = 404;
  hold.answerBody = null;
  hold.decisionStatus = 200;
  hold.decisionRows = [];
  vi.stubGlobal("fetch", async (url: string, init: { body?: string; cache?: string } = {}) => {
    if (init.cache === "no-store" && hold.depth === 0) {
      hold.outside.push(String(url));
    }
    if (String(url).includes("/answer")) {
      hold.asked.push("answer");
      return reply(hold.answerStatus, hold.answerBody);
    }
    const query = JSON.parse(init.body ?? "{}").query as string;
    if (query.includes("__type")) {
      return reply(200, { data: { decision: { fields: ["openedAt", "upheld", "reasonsURI", "blockTimestamp"].map((name) => ({ name })) } } });
    }
    if (query.includes("DecisionFor")) {
      hold.asked.push("decision");
      return reply(hold.decisionStatus, { data: { Decision: hold.decisionRows } });
    }
    hold.asked.push("row");
    return reply(hold.indexStatus, { data: { Dispute: hold.indexRow === null ? [] : [hold.indexRow] } });
  });
});

const count = (what: string) => hold.asked.filter((one) => one === what).length;
const filedAs = (name: string) => hold.filed.filter((entry) => entry.keyParts[0] === name);

describe("the index's dispute row", () => {
  it("is held for a minute under this passport's own name and the index's", async () => {
    await heldIndexedRow(ID);

    const [filed] = filedAs("moolam-dispute-row");
    expect(filed.keyParts).toEqual(["moolam-dispute-row", LOWER]);
    expect(filed.options.revalidate).toBe(60);
    expect(filed.options.tags).toContain(passportTag(ID));
    expect(filed.options.tags).toContain("moolam-index");
  });

  it("is read once for two asks, and the bond and times come back as bigints after the hold", async () => {
    const first = await heldIndexedRow(ID);
    const again = await heldIndexedRow(ID);

    expect(count("row")).toBe(1);
    expect(again?.bond).toBe(10n ** 18n);
    expect(again?.openedAt).toBe(BigInt(OPENED_AT));
    expect(again?.resolvedAt).toBeNull();
    expect(first).toEqual(again);
  });

  it("is never kept when the index did not answer, so the next ask reads again", async () => {
    hold.indexStatus = 502;

    await expect(heldIndexedRow(ID)).resolves.toBeNull();
    hold.indexStatus = 200;
    const later = await heldIndexedRow(ID);

    expect(count("row")).toBe(2);
    expect(later?.challenger).toBe(CHALLENGER);
  });
});

describe("the holder's answer", () => {
  it("is held for a minute under this passport's own name", async () => {
    await heldAnswer(ID);

    const [filed] = filedAs("moolam-dispute-answer");
    expect(filed.keyParts).toEqual(["moolam-dispute-answer", LOWER]);
    expect(filed.options).toEqual({ revalidate: 60, tags: [passportTag(ID)] });
  });

  it("keeps 'no answer yet' for the minute and reads once for two asks", async () => {
    await expect(heldAnswer(ID)).resolves.toEqual({ kind: "none" });
    await heldAnswer(ID);

    expect(count("answer")).toBe(1);
  });

  it("is never kept when the service did not answer, and says failed in the meantime", async () => {
    hold.answerStatus = 503;

    await expect(heldAnswer(ID)).resolves.toEqual({ kind: "failed" });
    hold.answerStatus = 404;
    await expect(heldAnswer(ID)).resolves.toEqual({ kind: "none" });

    expect(count("answer")).toBe(2);
  });
});

describe("the published decision", () => {
  const PUBLISHED = [{ openedAt: String(OPENED_AT), upheld: true, reasonsURI: "ipfs://bafkreireasons", blockTimestamp: "1788962000" }];

  it("is held for a minute under this passport's own name and the index's, per dispute", async () => {
    await heldDecision(ID, OPENED_AT);

    const [filed] = filedAs("moolam-dispute-decision");
    expect(filed.keyParts).toEqual(["moolam-dispute-decision", LOWER, String(OPENED_AT)]);
    expect(filed.options.revalidate).toBe(60);
    expect(filed.options.tags).toContain(passportTag(ID));
    expect(filed.options.tags).toContain("moolam-index");
  });

  it("reads once for two asks", async () => {
    hold.decisionRows = PUBLISHED;

    const first = await heldDecision(ID, OPENED_AT);
    const again = await heldDecision(ID, OPENED_AT);

    expect(first).toMatchObject({ kind: "published", decision: { upheld: true, reasonsURI: "ipfs://bafkreireasons" } });
    expect(again).toEqual(first);
    expect(count("decision")).toBe(1);
  });

  it("is never kept when the read failed, so published reasons show on the next ask", async () => {
    hold.decisionStatus = 502;

    await expect(heldDecision(ID, OPENED_AT)).resolves.toEqual({ kind: "failed" });
    hold.decisionStatus = 200;
    hold.decisionRows = PUBLISHED;
    await expect(heldDecision(ID, OPENED_AT)).resolves.toMatchObject({ kind: "published" });

    expect(count("decision")).toBe(2);
  });
});

describe("the dispute note on the passport page", () => {
  // A settled row that names its own day, so the note never goes to the chain for it.
  beforeEach(() => {
    hold.indexRow = { ...ROW, status: 3, resolvedAt: "1788962000" };
  });

  it("would be caught by this stand-in if it still made the plain read", async () => {
    await readAnswer(ID);

    expect(hold.outside).toHaveLength(1);
  });

  it("makes none of its three reads outside a held read", async () => {
    await DisputeNote({
      dispute: { challenger: CHALLENGER, bond: 10n ** 18n, evidenceHash: `0x${"ab".repeat(32)}`, status: 3, openedAt: BigInt(OPENED_AT) },
      passportId: ID,
      locale: "en",
    });

    expect(hold.outside).toEqual([]);
    expect(count("row")).toBe(1);
    expect(count("answer")).toBe(1);
    expect(count("decision")).toBe(1);
  });

  it("reads each of them once for two renders inside the minute", async () => {
    const dispute = { challenger: CHALLENGER, bond: 10n ** 18n, evidenceHash: `0x${"ab".repeat(32)}` as Hex, status: 3, openedAt: BigInt(OPENED_AT) };

    await DisputeNote({ dispute, passportId: ID, locale: "en" });
    await DisputeNote({ dispute, passportId: ID, locale: "en" });

    expect(count("row")).toBe(1);
    expect(count("answer")).toBe(1);
    expect(count("decision")).toBe(1);
  });
});
