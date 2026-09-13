import { describe, expect, it } from "vitest";
import { publicEnv } from "@/lib/env";
import { VerifierError, generate } from "@/lib/verifier/client";
import { describeFailure } from "@/lib/studio/problems";

/**
 * The one check that talks to the real service, and the only one that costs
 * nothing to run: a token the service will not accept never reaches the model.
 *
 * It runs when NEXT_PUBLIC_VERIFIER_URL points at a service that is up, so the
 * everyday suite stays offline:
 *
 *   NEXT_PUBLIC_VERIFIER_URL=https://verifier-production-d76f.up.railway.app npx vitest run test/live-generate.test.ts
 */
const local = publicEnv.verifierUrl.startsWith("http://localhost");

describe("the hosted /generate route", () => {
  it.skipIf(local)("refuses a bad token, and the browser turns that into the sign in line", async () => {
    const failure = await generate({
      prompt: "a fishing boat at first light off the Coromandel coast",
      title: "First light",
      creator: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      accessToken: "not-a-real-token",
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(VerifierError);
    expect((failure as VerifierError).status).toBe(401);
    expect((failure as VerifierError).code).toBe("unauthorized");
    expect(describeFailure(failure, "prepare")).toMatchObject({ key: "signedOut", next: "signIn" });
  });
});
