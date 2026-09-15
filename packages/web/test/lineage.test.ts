import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A dispute lands on one passport, and every edit made from that picture is a
 * copy of something proven fake. The registry cannot say so: resolve() marks
 * the id the challenge named and nothing under it. These tests hold the two
 * ways the web answers it anyway, the walk up the parent links the index
 * already stores and the index's own inheritedDisputed field, and that the
 * second replaces the first the moment the schema has it.
 */

const INDEX_URL = "https://index.example/v1/graphql";

const ROOT = `0x${"a1".repeat(32)}`;
const CHILD = `0x${"b2".repeat(32)}`;
const GRANDCHILD = `0x${"c3".repeat(32)}`;
const OTHER = `0x${"d4".repeat(32)}`;

type Lineage = typeof import("@/lib/data/lineage");
let lineage: Lineage;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_ENVIO_GRAPHQL_URL", INDEX_URL);
  lineage = await import("@/lib/data/lineage");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An index that answers each named query with a body of its own. */
function indexAnswering(answers: Record<string, unknown>) {
  const calls = vi.fn(async (_url: string, init: { body: string }) => {
    const { query } = JSON.parse(init.body) as { query: string };
    const name = Object.keys(answers).find((key) => query.includes(key));
    if (name === undefined) {
      throw new Error(`no answer set for ${query}`);
    }
    return { ok: true, json: async () => ({ data: answers[name] }) } as unknown as Response;
  });

  vi.stubGlobal("fetch", calls);
  return calls;
}

/** The schema of an index that has not redeployed with the field yet. */
const OLD_SCHEMA = { __type: { fields: [{ name: "id" }, { name: "disputed" }, { name: "parent" }] } };

/** The schema of one that has. */
const NEW_SCHEMA = { __type: { fields: [{ name: "id" }, { name: "disputed" }, { name: "inheritedDisputed" }] } };

describe("the walk up the parent chain", () => {
  it("calls an edit disputed when its grandparent is", () => {
    expect(lineage.anyDisputed({ disputed: false, parent: { disputed: false, parent: { disputed: true } } })).toBe(true);
  });

  it("calls a picture disputed when the registry marked it directly", () => {
    expect(lineage.anyDisputed({ disputed: true, parent: null })).toBe(true);
  });

  it("leaves an edit alone when nothing above it was disputed", () => {
    expect(lineage.anyDisputed({ disputed: false, parent: { disputed: false, parent: null } })).toBe(false);
  });

  it("has nothing to say about a passport the index does not hold", () => {
    expect(lineage.anyDisputed(undefined)).toBe(false);
  });

  it("looks deeper than any lineage on the registry today", () => {
    expect(lineage.LINEAGE_DEPTH).toBe(8);
  });
});

describe("one passport's answer", () => {
  it("asks for the parent chain to the depth it states, and reads a disputed grandparent off it", async () => {
    const calls = indexAnswering({
      IndexSchema: OLD_SCHEMA,
      InheritedDisputed: {
        Passport: [{ disputed: false, parent: { disputed: false, parent: { disputed: true, parent: null } } }],
      },
    });

    expect(await lineage.inheritedDisputed(GRANDCHILD)).toBe(true);

    const sent = JSON.parse(calls.mock.calls[1][1].body) as { query: string; variables: { id: string } };
    expect(sent.query.match(/parent \{/g)).toHaveLength(lineage.LINEAGE_DEPTH);
    expect(sent.variables.id).toBe(GRANDCHILD);
  });

  it("says no for a picture with a clean chain above it", async () => {
    indexAnswering({
      IndexSchema: OLD_SCHEMA,
      InheritedDisputed: { Passport: [{ disputed: false, parent: { disputed: false, parent: null } }] },
    });

    expect(await lineage.inheritedDisputed(CHILD)).toBe(false);
  });

  it("reads the index's own field instead of walking once the schema has it", async () => {
    const calls = indexAnswering({
      IndexSchema: NEW_SCHEMA,
      InheritedDisputedField: { Passport: [{ inheritedDisputed: true }] },
    });

    expect(await lineage.inheritedDisputed(GRANDCHILD)).toBe(true);

    const sent = JSON.parse(calls.mock.calls[1][1].body) as { query: string };
    expect(sent.query).toContain("inheritedDisputed");
    expect(sent.query).not.toContain("parent {");
  });

  it("passes the index's own words on rather than answering no for it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response),
    );

    await expect(lineage.inheritedDisputed(CHILD)).rejects.toThrow("502");
  });
});

describe("the edit trees under a disputed picture", () => {
  const family = [
    { id: ROOT, parentId: null, disputed: false },
    { id: CHILD, parentId: ROOT, disputed: true },
    { id: GRANDCHILD, parentId: CHILD, disputed: false },
    { id: OTHER, parentId: ROOT, disputed: false },
  ];

  it("takes in the disputed passport and everything edited from it, and nothing beside it", () => {
    expect(lineage.disputedFamily(family)).toEqual([CHILD, GRANDCHILD]);
  });

  it("stops climbing at a parent the read did not cover", () => {
    expect(lineage.disputedFamily([{ id: GRANDCHILD, parentId: CHILD, disputed: false }])).toEqual([]);
  });
});

describe("what the Disputed chip is given", () => {
  it("derives the ids from the roots of the disputed passports", async () => {
    const calls = indexAnswering({
      IndexSchema: OLD_SCHEMA,
      DisputedPassports: { Passport: [{ id: CHILD, root_id: ROOT }] },
      DisputedFamilies: {
        Passport: [
          { id: ROOT, parent_id: null, disputed: false },
          { id: CHILD, parent_id: ROOT, disputed: true },
          { id: GRANDCHILD, parent_id: CHILD, disputed: false },
        ],
      },
    });

    expect(await lineage.disputedReach()).toEqual({ ids: [CHILD, GRANDCHILD] });

    const roots = JSON.parse(calls.mock.calls[2][1].body) as { variables: { roots: string[] } };
    expect(roots.variables.roots).toEqual([ROOT]);
  });

  it("asks for nothing at all while no dispute has been upheld", async () => {
    const calls = indexAnswering({ IndexSchema: OLD_SCHEMA, DisputedPassports: { Passport: [] } });

    expect(await lineage.disputedReach()).toEqual({ ids: [] });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("hands the question to the index once the schema has the field", async () => {
    const calls = indexAnswering({ IndexSchema: NEW_SCHEMA });

    expect(await lineage.disputedReach()).toBe("field");
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe("which rows a reach covers", () => {
  it("covers the ids it derived", () => {
    expect(lineage.reaches({ ids: [CHILD] }, { id: CHILD })).toBe(true);
    expect(lineage.reaches({ ids: [CHILD] }, { id: OTHER })).toBe(false);
  });

  it("takes the row's own field when the index answered with one", () => {
    expect(lineage.reaches("field", { id: OTHER, inheritedDisputed: true })).toBe(true);
    expect(lineage.reaches("field", { id: OTHER, inheritedDisputed: false })).toBe(false);
  });

  it("covers nothing when no reach was worked out", () => {
    expect(lineage.reaches(undefined, { id: CHILD, inheritedDisputed: true })).toBe(false);
  });
});
