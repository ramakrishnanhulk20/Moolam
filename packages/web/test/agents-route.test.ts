import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agents board is a page the build makes and the host keeps for a minute,
 * so the one thing that must hold is the same one Explore holds: a roster the
 * index would not answer for is never the page everybody is handed next.
 */

const holds = vi.hoisted(() => ({
  standings: vi.fn(),
  roster: vi.fn(),
  strips: vi.fn(),
  connection: vi.fn(),
}));

vi.mock("next/server", async (real) => ({
  ...(await real<typeof import("next/server")>()),
  connection: holds.connection,
}));

vi.mock("@/lib/data/passports", () => ({ heldGeneratorStandings: holds.standings }));
vi.mock("@/components/agents/roster", () => ({ roster: holds.roster }));
vi.mock("@/components/agents/strip", () => ({ boardStrips: holds.strips }));

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
  });

  it("is never left in the page the host keeps", async () => {
    holds.standings.mockRejectedValue(new Error("the Envio endpoint answered 429"));

    const drawn = (await AgentsSheet({ locale: "en" })) as { props: { error: string | null } };

    expect(holds.connection).toHaveBeenCalledTimes(1);
    expect(drawn.props.error).toBe("the Envio endpoint answered 429");
  });

  it("keeps a board whose read came back, including an empty one", async () => {
    await AgentsSheet({ locale: "en" });

    expect(holds.connection).not.toHaveBeenCalled();
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
