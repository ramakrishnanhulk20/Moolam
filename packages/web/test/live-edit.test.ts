import { describe, expect, it } from "vitest";
import { publicEnv } from "@/lib/env";
import { VerifierError, edit } from "@/lib/verifier/client";
import { describeEditFailure } from "@/lib/passport/edit";

/**
 * The one check the edit panel runs against the real service, and it costs nothing: a token the
 * service will not accept is turned away before a single pin or transaction happens.
 *
 * It runs when NEXT_PUBLIC_VERIFIER_URL points at a service that is up, so the everyday suite
 * stays offline:
 *
 *   NEXT_PUBLIC_VERIFIER_URL=https://verifier-production-d76f.up.railway.app npx vitest run test/live-edit.test.ts
 */
const local = publicEnv.verifierUrl.startsWith("http://localhost");

describe("the hosted /edit route", () => {
  it.skipIf(local)("refuses a bad token, and the panel turns that into the sign in line", async () => {
    const failure = await edit({
      file: new File([new Uint8Array([0xff, 0xd8, 0xff])], "edited.jpg", { type: "image/jpeg" }),
      title: "Kadal at dawn, warmer",
      parentId: "0x75bf8bf1fb8b63ddffd92a7457d2fc2a236ce189468db9a4d45544012419c1a0",
      note: "Lifted the shadows.",
      accessToken: "not-a-real-token",
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(VerifierError);
    expect((failure as VerifierError).status).toBe(401);
    expect((failure as VerifierError).code).toBe("unauthorized");
    expect(describeEditFailure(failure)).toMatchObject({ key: "signedOut", next: "signIn" });
  });
});
