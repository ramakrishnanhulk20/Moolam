import { describe, expect, it } from "vitest";
import { percent, readAnswer, verifyProblem } from "@/components/verify/answer";
import { VerifierError, verifyResponseSchema } from "@/lib/verifier/client";

const ID = `0x${"1a".repeat(32)}`;
const OTHER = `0x${"2b".repeat(32)}`;

const queried = {
  sha256: `0x${"3c".repeat(32)}`,
  phash: "7840159428093749285",
  blockhash: `0x${"4d".repeat(32)}`,
  width: 1536,
  height: 1024,
  format: "jpeg",
};

function payload(result: Record<string, unknown>, manifest = false) {
  return verifyResponseSchema.parse({
    result: { exact: null, best: null, matches: [], confidence: 0, queried, ...result },
    manifest: { present: manifest },
  });
}

describe("what the screen shows for one verify answer", () => {
  it("calls identical bytes an exact hit, at full confidence and no distance", () => {
    const best = { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 };
    const answer = readAnswer(payload({ exact: ID, best, matches: [best], confidence: 1 }, true));

    expect(answer.kind).toBe("exact");
    expect(answer).toMatchObject({ id: ID, phashDistance: 0, blockhashDistance: 0, others: 0, manifest: true });
    expect(percent(1)).toBe(100);
  });

  it("keeps the distances and the orientation of a perceptual match", () => {
    const best = { id: ID, phashDistance: 3, blockhashDistance: 24, variant: "mirror-rot90", score: 0.6 };
    const second = { id: OTHER, phashDistance: 9, blockhashDistance: 38, variant: "identity", score: 0.2 };
    const answer = readAnswer(payload({ best, matches: [best, second], confidence: 0.6431 }));

    expect(answer.kind).toBe("close");
    expect(answer).toMatchObject({ id: ID, phashDistance: 3, blockhashDistance: 24, variant: "mirror-rot90", others: 1 });
    expect(percent(0.6431)).toBe(64);
  });

  it("says nothing matched when the service returns no candidate", () => {
    const answer = readAnswer(payload({}));

    expect(answer.kind).toBe("miss");
    expect(answer.manifest).toBe(false);
    expect(answer.queried.format).toBe("jpeg");
  });

  it("still reads an exact hit that arrives without a best row", () => {
    const answer = readAnswer(payload({ exact: ID, confidence: 1 }));

    expect(answer).toMatchObject({ kind: "exact", id: ID, variant: "identity", phashDistance: 0 });
  });
});

describe("the schema this screen validates the service against", () => {
  it("refuses a confidence outside zero to one and a pHash sent as a number", () => {
    expect(verifyResponseSchema.safeParse({ result: { exact: null, best: null, matches: [], confidence: 1.4, queried }, manifest: { present: false } }).success).toBe(false);
    expect(
      verifyResponseSchema.safeParse({
        result: { exact: null, best: null, matches: [], confidence: 0.5, queried: { ...queried, phash: 78401594 } },
        manifest: { present: false },
      }).success,
    ).toBe(false);
  });
});

describe("what a reader is told when the check does not run", () => {
  const cases: [number, string, string][] = [
    [413, "too-large", "problem.tooLarge"],
    [415, "not-an-image", "problem.notAnImage"],
    [400, "bad-request", "problem.badRequest"],
    [429, "rate-limited", "problem.rateLimited"],
    [500, "bad-response", "problem.badResponse"],
    [0, "offline", "offline"],
  ];

  for (const [status, code, key] of cases) {
    it(`turns ${code} into ${key}`, () => {
      const problem = verifyProblem(new VerifierError(code as never, status, "the service said so"));
      expect(problem.key).toBe(key);
      // The offline line names the service already, and the not-an-image
      // sentence says in the reader's language what the English reason says.
      expect(problem.reason).toBe(key === "offline" || key === "problem.notAnImage" ? undefined : "the service said so");
    });
  }

  it("keeps the words of anything thrown that is not a VerifierError", () => {
    expect(verifyProblem(new Error("the browser gave up"))).toEqual({ key: "problem.badResponse", reason: "the browser gave up" });
  });
});
