// Covers the two things the edit quorum script has to get right without Privy in the room: the key
// it registers is the public half of PRIVY_AUTHORIZATION_KEY derived exactly as the verify service
// derives it, and a second run reuses the quorum the first run made instead of creating another.
// Does NOT cover Privy accepting that key on a wallet, which is what
// `npm run edit:quorum -- --grant-proof-wallet` proves live against the Privy app.

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  findOrCreateQuorum,
  upsertEnvLine,
  type QuorumApi,
  type QuorumCreateInput,
  type QuorumRecord,
} from "../scripts/edit-quorum.js";

const CREATED_ID = "kq0000000000000000000001";
const CACHED_ID = "kq0000000000000000000002";
const OTHER_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEother";

interface Recorder extends QuorumApi {
  created: QuorumCreateInput[];
}

function fakeApi(quorums: Record<string, QuorumRecord>): Recorder {
  const created: QuorumCreateInput[] = [];
  return {
    created,
    async get(id) {
      const found = quorums[id];
      if (!found) throw new Error(`no key quorum ${id}`);
      return found;
    },
    async create(input) {
      created.push(input);
      const record: QuorumRecord = {
        id: CREATED_ID,
        authorization_keys: (input.public_keys ?? []).map((key) => ({ public_key: key })),
        authorization_threshold: input.authorization_threshold,
        user_ids: [],
      };
      quorums[record.id] = record;
      return record;
    },
  };
}

function quorum(id: string, publicKey: string, extra: Partial<QuorumRecord> = {}): QuorumRecord {
  return {
    id,
    authorization_keys: [{ public_key: publicKey }],
    authorization_threshold: 1,
    user_ids: [],
    ...extra,
  };
}

describe("the key the edit quorum is built on", () => {
  it("is the public half of PRIVY_AUTHORIZATION_KEY, in the base64 DER form Privy takes", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const expected = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");

    process.env.PRIVY_APP_ID = "abcdefghijklmnopqrstuvwx";
    process.env.PRIVY_APP_SECRET = "test-secret";
    process.env.PRIVY_AUTHORIZATION_KEY = `wallet-auth:${pkcs8}`;
    vi.resetModules();

    const { ownerPublicKey } = await import("@moolam/verifier/src/generate/privy.js");
    expect(ownerPublicKey()).toBe(expected);
  });
});

describe("finding or creating the edit quorum", () => {
  it("creates one when the root .env names no quorum yet", async () => {
    const api = fakeApi({});

    const result = await findOrCreateQuorum(api, "public-key", undefined);

    expect(result).toEqual({ id: CREATED_ID, action: "created" });
    expect(api.created).toEqual([
      { public_keys: ["public-key"], display_name: "moolam-edit-signer", authorization_threshold: 1 },
    ]);
  });

  it("reuses the same id on the next run, and creates nothing", async () => {
    const api = fakeApi({});

    const first = await findOrCreateQuorum(api, "public-key", undefined);
    const second = await findOrCreateQuorum(api, "public-key", first.id);

    expect(second).toEqual({ id: first.id, action: "found" });
    expect(api.created).toHaveLength(1);
  });

  it("creates a fresh one when the cached id holds another key, or a member we did not put there", async () => {
    const wrongKey = fakeApi({ [CACHED_ID]: quorum(CACHED_ID, OTHER_KEY) });
    const extraMember = fakeApi({
      [CACHED_ID]: quorum(CACHED_ID, "public-key", { user_ids: ["did:privy:someone"] }),
    });
    const deleted = fakeApi({});

    expect(await findOrCreateQuorum(wrongKey, "public-key", CACHED_ID)).toEqual({
      id: CREATED_ID,
      action: "created",
    });
    expect(await findOrCreateQuorum(extraMember, "public-key", CACHED_ID)).toEqual({
      id: CREATED_ID,
      action: "created",
    });
    expect(await findOrCreateQuorum(deleted, "public-key", CACHED_ID)).toEqual({
      id: CREATED_ID,
      action: "created",
    });
  });
});

describe("writing the id back into the root .env", () => {
  it("replaces the line that is there and leaves every other line alone", () => {
    const before = "PINATA_JWT=keep-me\nPRIVY_EDIT_SIGNER_ID=old\n# a comment\nEDITS_PER_DAY=5\n";

    expect(upsertEnvLine(before, "PRIVY_EDIT_SIGNER_ID", "new")).toBe(
      "PINATA_JWT=keep-me\nPRIVY_EDIT_SIGNER_ID=new\n# a comment\nEDITS_PER_DAY=5\n",
    );
  });

  it("appends the line when the file has none", () => {
    expect(upsertEnvLine("PINATA_JWT=keep-me\n", "PRIVY_EDIT_SIGNER_ID", "new")).toBe(
      "PINATA_JWT=keep-me\nPRIVY_EDIT_SIGNER_ID=new\n",
    );
  });
});
