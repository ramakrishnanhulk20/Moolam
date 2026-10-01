// Covers the pure rules the claim flow matches and shows by: P28 one normaliser (two spellings of
// one address meet, a Gmail dot, a plus tag, another Google domain and a Cyrillic look-alike do
// not, and anything but one addr-spec is refused) and its output is a fixed point; P29 the hash is
// keyed and tagged with the pepper's version, and a bad pepper fails the boot naming the variable
// and never the value; P28 only Privy's email and Google accounts with a verified time count; P37
// the terms rule is MoolamConsent's constraint check; P36 a preview only through pinned content.
// Does NOT cover the routes (claims-routes.test.ts), the store (claims-store.test.ts), or whether
// Privy itself links only a Google account whose email Google verified, which is Privy's to say.

import { APIError } from "@privy-io/node";
import { describe, expect, it } from "vitest";
import { emailHash, normaliseEmail, underPepper, type Pepper } from "../src/claims/email.js";
import { previewOf, previewReader } from "../src/claims/preview.js";
import { verifiedEmails } from "../src/claims/privyUser.js";
import { termsProblem, termsSchema, type ClaimTerms } from "../src/claims/terms.js";
import { parseEnv } from "../src/env.js";

const pepper: Pepper = { secret: Buffer.alloc(32, 7), version: "3" };

describe("normaliseEmail and emailHash (P28, P29)", () => {
  it("meets two spellings of one address: case, white space around it and full-width letters", () => {
    for (const spelling of ["  Ram@Example.COM ", "RAM@example.com", "ｒａｍ＠ｅｘａｍｐｌｅ．ｃｏｍ"]) {
      expect(normaliseEmail(spelling), spelling).toBe("ram@example.com");
      expect(emailHash(spelling, pepper)).toBe(emailHash("ram@example.com", pepper));
    }
  });

  it("keeps apart what only a provider's own rule would join, and a look-alike letter", () => {
    const base = emailHash("ram@gmail.com", pepper);
    for (const other of ["r.am@gmail.com", "ram+moolam@gmail.com", "ram@googlemail.com", "rаm@gmail.com"]) {
      expect(normaliseEmail(other), other).not.toBeNull();
      expect(emailHash(other, pepper), other).not.toBe(base);
    }
  });

  it("refuses anything that is not exactly one addr-spec of printable characters", () => {
    const refused = [
      "Ram <ram@example.com>",
      "ram(comment)@example.com",
      "ram@@example.com",
      "ram@exa@mple.com",
      "@example.com",
      "ram@",
      "ram example@example.com",
      '"ram"@example.com',
      "ram@[192.0.2.1]",
      ".ram@example.com",
      "ram..x@example.com",
      "ram‍@example.com",
      "ram‮@example.com",
      "ram\n@example.com",
      `${"a".repeat(245)}@example.com`,
      "",
      42,
      null,
    ];
    for (const value of refused) {
      expect(normaliseEmail(value), JSON.stringify(value)).toBeNull();
      expect(emailHash(value, pepper)).toBeNull();
    }
    expect(normaliseEmail(`${"a".repeat(242)}@example.com`)).not.toBeNull();
  });

  it("gives a fixed point: normalising the output again changes nothing, a dotted capital I included", () => {
    for (const value of ["İnci@Example.com", "ｒａｍ@example.com", "Ünal@Örnek.com.tr", "user.name+tag@sub.example.org"]) {
      const once = normaliseEmail(value);
      expect(once, value).not.toBeNull();
      expect(normaliseEmail(once)).toBe(once);
    }
  });

  it("keys the hash with the pepper and tags it with its version, so another pepper never matches", () => {
    const hash = emailHash("ram@example.com", pepper) as string;
    expect(hash).toMatch(/^3:[0-9a-f]{64}$/);
    expect(hash).not.toContain("ram");
    expect(underPepper(hash, pepper)).toBe(true);
    const rotated: Pepper = { secret: Buffer.alloc(32, 8), version: "4" };
    expect(emailHash("ram@example.com", rotated)).not.toBe(hash);
    expect(underPepper(hash, rotated)).toBe(false);
  });

  it("fails the boot on a short or lone pepper, naming the variable and never the value", () => {
    const short = "ab".repeat(16);
    expect(() => parseEnv({ CLAIM_PEPPER: short, CLAIM_PEPPER_VERSION: "1" })).toThrow(/CLAIM_PEPPER/);
    try {
      parseEnv({ CLAIM_PEPPER: short, CLAIM_PEPPER_VERSION: "1" });
    } catch (error) {
      expect(String(error)).not.toContain(short);
    }
    expect(() => parseEnv({ CLAIM_PEPPER: "ab".repeat(32) })).toThrow(/CLAIM_PEPPER and CLAIM_PEPPER_VERSION go together/);
    expect(parseEnv({ CLAIM_PEPPER: "ab".repeat(32), CLAIM_PEPPER_VERSION: "1" }).CLAIM_PEPPER_VERSION).toBe("1");
  });
});

describe("verifiedEmails (P28)", () => {
  const clientWith = (get: () => Promise<unknown>) => ({ users: () => ({ _get: get }) }) as never;

  it("reads only the email account and the Google account's email, each with a verified time", async () => {
    const accounts = [
      { type: "email", address: "A@example.com", verified_at: 1 },
      { type: "google_oauth", email: "b@gmail.com", verified_at: 2 },
      { type: "apple_oauth", email: "relay@privaterelay.appleid.com", verified_at: 3 },
      { type: "github_oauth", email: "c@example.com", verified_at: 4 },
      { type: "email", address: "unverified@example.com", verified_at: 0 },
      { type: "google_oauth", email: "noflag@gmail.com" },
      { type: "wallet", address: "0x0000000000000000000000000000000000000001", verified_at: 5 },
    ];
    expect(await verifiedEmails(clientWith(async () => ({ linked_accounts: accounts })), "did:privy:x")).toEqual(["A@example.com", "b@gmail.com"]);
  });

  it("gives none for a user Privy does not know, and throws anything else Privy throws", async () => {
    const missing = clientWith(async () => {
      throw new APIError(404, undefined, "not found", undefined);
    });
    expect(await verifiedEmails(missing, "did:privy:gone")).toEqual([]);
    const down = clientWith(async () => {
      throw new APIError(500, undefined, "down", undefined);
    });
    await expect(verifiedEmails(down, "did:privy:x")).rejects.toThrow();
  });
});

describe("the terms rule is MoolamConsent._checkConstraintInfo (P37)", () => {
  const terms = (patch: Partial<ClaimTerms>): ClaimTerms => ({
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "allowed",
    dataMining: "unspecified",
    constraintInfo: "",
    ...patch,
  });

  it("accepts what the contract accepts, the edges included, and stores it unchanged", () => {
    for (const ok of [terms({}), terms({ aiTraining: "constrained", constraintInfo: " ask at https://x.example " }), terms({ dataMining: "constrained", constraintInfo: "~".repeat(256) })]) {
      expect(termsProblem(ok)).toBeNull();
      expect(termsSchema.parse(ok)).toEqual(ok);
    }
  });

  it("refuses what the contract refuses", () => {
    const refused = [
      terms({ constraintInfo: "x" }),
      terms({ aiTraining: "constrained" }),
      terms({ aiTraining: "constrained", constraintInfo: "x".repeat(257) }),
      terms({ aiTraining: "constrained", constraintInfo: "line\nbreak" }),
      terms({ aiTraining: "constrained", constraintInfo: "café" }),
    ];
    for (const one of refused) {
      expect(termsProblem(one), one.constraintInfo.slice(0, 10)).not.toBeNull();
      expect(termsSchema.safeParse(one).success).toBe(false);
    }
    expect(termsSchema.safeParse({ ...terms({}), extra: 1 }).success).toBe(false);
    expect(termsSchema.safeParse({ ...terms({}), aiTraining: "maybe" }).success).toBe(false);
  });
});

describe("previews only through pinned content (P36)", () => {
  const cid = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

  it("shows a title as one line of text and a thumbnail only as a bare ipfs content id", () => {
    expect(previewOf({ name: " Harbour lights ", thumbnail: `ipfs://${cid}`, extra: true })).toEqual({ title: "Harbour lights", image: `ipfs://${cid}` });
    for (const document of [
      { name: "Harbour", thumbnail: `https://evil.example/${cid}` },
      { name: "Harbour", thumbnail: `ipfs://${cid}/../x` },
      { name: "x".repeat(121), thumbnail: `ipfs://${cid}` },
      { name: "Click‮evil", thumbnail: `ipfs://${cid}` },
      { name: "two\nlines", thumbnail: `ipfs://${cid}` },
      { name: "", thumbnail: `ipfs://${cid}` },
      { thumbnail: `ipfs://${cid}` },
      "not an object",
    ]) {
      expect(previewOf(document), JSON.stringify(document).slice(0, 40)).toBeNull();
    }
  });

  it("never reads a metadata address that is not pinned content, and shows no preview when the read fails", async () => {
    const asked: string[] = [];
    const reader = previewReader(async (uri) => {
      asked.push(uri);
      if (uri.endsWith("broken")) throw new Error("gateway down");
      return { name: "Harbour", thumbnail: `ipfs://${cid}` };
    });
    expect(await reader("https://evil.example/doc.json")).toBeNull();
    expect(await reader(null)).toBeNull();
    expect(asked).toEqual([]);
    expect(await reader("ipfs://bafkreibroken")).toBeNull();
    expect(await reader(`ipfs://${cid}`)).toEqual({ title: "Harbour", image: `ipfs://${cid}` });
    expect(await reader(`ipfs://${cid}`)).toEqual({ title: "Harbour", image: `ipfs://${cid}` });
    expect(asked).toEqual(["ipfs://bafkreibroken", `ipfs://${cid}`]);
  });
});
