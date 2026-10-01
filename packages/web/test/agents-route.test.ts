import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agents board is drawn on every visit, with its reads held for a minute
 * and filed under the newest registration, so a roster the index would not
 * answer for is never the page everybody is handed next, and a board made
 * before the newest passport is never handed to anyone.
 */

const holds = vi.hoisted(() => ({
  standings: vi.fn(),
  roster: vi.fn(),
  strips: vi.fn(),
  connection: vi.fn(),
  newest: vi.fn(),
}));

vi.mock("next/server", async (real) => ({
  ...(await real<typeof import("next/server")>()),
  connection: holds.connection,
}));

vi.mock("@/lib/data/passports", () => ({ heldGeneratorStandings: holds.standings }));
vi.mock("@/components/agents/roster", () => ({ roster: holds.roster }));
vi.mock("@/components/agents/strip", () => ({ boardStrips: holds.strips }));
vi.mock("@/components/agents/fresh", () => ({ newestRegistration: holds.newest }));

vi.mock("@/lib/chain/client", () => ({
  reason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@/components/agents/Board", () => ({ Board: () => null }));

const { AgentsSheet } = await import("@/components/agents/Sheet");

describe("a roster that could not be read", () => {
  beforeEach(() => {
    holds.connection.mockReset().mockResolvedValue(undefined);
    holds.standings.mockReset().mockResolvedValue([]);
    holds.roster.mockReset().mockImplementation(async (rows: unknown[]) => rows);
    holds.strips.mockReset().mockResolvedValue({});
    holds.newest.mockReset().mockResolvedValue("");
  });

  it("is never left in the page the host keeps", async () => {
    holds.standings.mockRejectedValue(new Error("the Envio endpoint answered 429"));

    const drawn = (await AgentsSheet({ locale: "en" })) as { props: { error: string | null } };

    expect(holds.connection).toHaveBeenCalledTimes(1);
    expect(drawn.props.error).toBe("the Envio endpoint answered 429");
  });

  it("is drawn on every visit, a board whose read came back included", async () => {
    await AgentsSheet({ locale: "en" });

    expect(holds.connection).toHaveBeenCalledTimes(1);
  });

  it("files both held reads under the newest registration, so a new passport is read at once", async () => {
    const newest = `0x${"ab".repeat(32)}`;
    holds.newest.mockResolvedValue(newest);

    await AgentsSheet({ locale: "en" });

    expect(holds.connection.mock.invocationCallOrder[0]).toBeLessThan(holds.newest.mock.invocationCallOrder[0]);
    expect(holds.standings).toHaveBeenCalledWith(undefined, newest);
    expect(holds.strips).toHaveBeenCalledWith(newest);
  });

  it("hands the board what the index counted, not a list of its own", async () => {
    const row = { id: "10248", name: null, trustScore: 67 };
    holds.standings.mockResolvedValue([row]);

    const drawn = (await AgentsSheet({ locale: "ta" })) as {
      props: { agents: unknown[]; locale: string };
    };

    expect(drawn.props.agents).toEqual([row]);
    expect(drawn.props.locale).toBe("ta");
  });

  it("reads the roster through the held query, so ten built pages are one query", async () => {
    await AgentsSheet({ locale: "en" });

    expect(holds.standings).toHaveBeenCalledTimes(1);
  });
});
