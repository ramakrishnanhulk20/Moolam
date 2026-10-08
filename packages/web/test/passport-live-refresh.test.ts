import { describe, expect, it, vi } from "vitest";

// The component file also imports the router and the server action. Only the
// timing rule is under test, so neither is loaded for real.
vi.mock("@/lib/i18n/routing", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

const { nextDelayMs } = await import("@/components/passport/LiveRefresh");

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const toSeconds = (ms: number) => Math.floor(ms / 1000);

describe("when a passport page looks again for its Chainlink verdict", () => {
  it("looks every 15 seconds just after the page opens", () => {
    const registered = toSeconds(NOW - 10_000);

    expect(nextDelayMs(NOW + 1_000, NOW, registered)).toBe(15_000);
    expect(nextDelayMs(NOW + 3 * MINUTE - 1, NOW, registered)).toBe(15_000);
  });

  it("slows to once a minute after three minutes on the page", () => {
    const registered = toSeconds(NOW - 10_000);

    expect(nextDelayMs(NOW + 3 * MINUTE, NOW, registered)).toBe(60_000);
    expect(nextDelayMs(NOW + 10 * MINUTE, NOW, registered)).toBe(60_000);
  });

  it("stops once 15 minutes have passed since the registration", () => {
    const registered = toSeconds(NOW);

    expect(nextDelayMs(NOW + 15 * MINUTE - 1, NOW, registered)).toBe(60_000);
    expect(nextDelayMs(NOW + 15 * MINUTE, NOW, registered)).toBeNull();
    expect(nextDelayMs(NOW + 40 * MINUTE, NOW, registered)).toBeNull();
  });

  it("never starts for a passport registered 20 minutes ago", () => {
    const registered = toSeconds(NOW - 20 * MINUTE);

    expect(nextDelayMs(NOW, NOW, registered)).toBeNull();
  });
});
