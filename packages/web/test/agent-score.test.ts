import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFormatter, createTranslator } from "next-intl";
import en from "@/messages/en.json";
import { agentStanding } from "@/components/story/data";
import { Standing } from "@/components/agent/Standing";
import { generatorRecord } from "@/lib/data/passports";

/**
 * One agent, one score. The judge audit found 95 on the home story and 67 on
 * the agents page for agent 10248, because the story quoted the ERC-8004
 * reputation registry and every other page quoted the index. These fix the
 * source.
 */

// The page's own server helpers, which only resolve inside the bundler. Both
// are given the real English messages, so the test reads what a visitor reads.
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => createFormatter({ locale: "en", timeZone: "Asia/Kolkata" }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

vi.mock("@/lib/data/passports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/passports")>()),
  generatorRecord: vi.fn(),
}));

const row = { passportCount: 12, matchedCount: 1, trustScore: 67 };

beforeEach(() => {
  vi.mocked(generatorRecord).mockReset();
});

describe("the standing the home story quotes", () => {
  it("takes the score, the re-checks and the passports from the index row", async () => {
    expect(await agentStanding(10248n, row)).toEqual({
      id: "10248",
      score: 67,
      rechecks: 1,
      passports: 12,
    });
    expect(generatorRecord).not.toHaveBeenCalled();
  });

  it("reads the same row from the index when the story query did not carry one", async () => {
    vi.mocked(generatorRecord).mockResolvedValue({
      ...row,
      mismatchedCount: 0,
      disputesUpheld: 0,
      firstSeenAt: 1788875220n,
    });

    expect(await agentStanding(10248n)).toMatchObject({ score: 67, rechecks: 1, passports: 12 });
    expect(generatorRecord).toHaveBeenCalledWith(10248n);
  });

  it("shows no score at all for an agent the index has no row for", async () => {
    vi.mocked(generatorRecord).mockResolvedValue(null);
    expect(await agentStanding(10250n)).toBeNull();

    vi.mocked(generatorRecord).mockRejectedValue(new Error("the Envio endpoint answered 502"));
    expect(await agentStanding(10250n)).toBeNull();
  });

  it("never reaches for the reputation registry, whose feedback is a different thing", () => {
    const source = readFileSync(fileURLToPath(new URL("../components/story/data.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/chain\/reputation/);
    expect(source).toMatch(/trustScore/);
  });
});

describe("the two numbers the agent page keeps apart", () => {
  const record = {
    passportCount: 12,
    matchedCount: 1,
    mismatchedCount: 0,
    disputesUpheld: 0,
    trustScore: 67,
    firstSeenAt: 1788875220n,
  };

  async function page(): Promise<string> {
    return renderToStaticMarkup(
      await Standing({
        reputation: { count: 2n, value: 95n, decimals: 0 },
        reputationError: null,
        record,
        recordError: null,
        locale: "en",
      }),
    );
  }

  it("leads with the index score the story and the Agents page show, and links the formula", async () => {
    const html = await page();

    expect(html).toContain(">67<");
    expect(html).toContain("Trust score");
    expect(html).toContain("Verdicts matched");
    expect(html).toContain(en.agent.index.formula);
    expect(html).toContain("/docs/developers/envio-indexer#the-trust-score");
  });

  it("shows the registry's feedback as entries under its own label, never as the score", async () => {
    const html = await page();

    expect(html).toContain("Feedback on the public agent review board (ERC-8004)");
    expect(html).toContain("2 entries");
    expect(html).toContain(">95<");
    expect(html).toContain("Latest value");
    expect(html).toContain("Feedback posted on chain by hand, apart from the verdict score");
    expect(html).not.toContain("Average score");
  });
});
