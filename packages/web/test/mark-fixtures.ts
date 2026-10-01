import type { Hex } from "viem";
import type { MarkVerdict } from "@/components/mark/mark";
import type { PassportMarkFacts } from "@/components/mark/read";
import type { Attestation } from "@/lib/chain/registry";

/**
 * Trust mark facts for the tests that draw a poster for some other reason.
 * The poster reads its mark through components/mark/read.ts, which asks the
 * chain, the index and the verify service, so those tests hand it this instead:
 * a public picture Chainlink's network has not checked yet, and nothing about
 * look-alikes. test/marks.test.ts covers the reads and every mark.
 */
export const WAITING_FACTS: PassportMarkFacts = {
  mark: { state: "waiting" },
  registeredAt: 1_790_000_000,
  challenge: null,
  earlier: null,
  lookalike: { kind: "quiet" },
  later: { first: null, count: 0 },
  testRun: false,
};

export const EARLIER_ID = `0x${"e1".repeat(32)}` as Hex;

/**
 * The module a poster test mocks components/mark/read.ts with. Every verdict
 * reads as the network's, so a strip or a chip drawn in such a test says what
 * it would say for a checked passport; the reads behind the rule are covered
 * in test/marks.test.ts.
 */
export const markReadMock = {
  passportMarkFacts: async (): Promise<PassportMarkFacts> => WAITING_FACTS,
  networkVerdicts: async (
    _passport: unknown,
    attestations: readonly Attestation[],
  ): Promise<MarkVerdict[]> =>
    attestations.map((one) => ({ network: true, matched: one.matched, phashBits: one.distance, at: Number(one.at) })),
};
