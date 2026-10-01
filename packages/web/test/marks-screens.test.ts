import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import type { ExplorePlate } from "@/components/explore/sort";
import type { ExploreSearch } from "@/components/explore/query";
import type { FirstRegistration, MatchedPassport } from "@/components/verify/lookup";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import { readAnswer } from "@/components/verify/answer";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The mark on the two screens that are not a passport page (WO-284a step 5):
 * the word on an Explore plate and the two look-alike chips, and the verify
 * answer leading with the first registration. Every value is a fixture; the
 * reads behind them are test/marks.test.ts.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }) }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/components/passport/Picture", () => ({ Picture: () => createElement("span", { "data-picture": "true" }) }));
vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: { kind: "none" },
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

const { Plate } = await import("@/components/explore/Plate");
const { Filters } = await import("@/components/explore/Filters");
const { ReadingProvider } = await import("@/components/explore/Reading");
const { AnswerCard } = await import("@/components/verify/AnswerCard");
const { filterFor, readExploreSearch } = await import("@/components/explore/query");
const { passportWhere } = await import("@/lib/data/passports");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

const shown = (line: string): string => line.replace(/'/g, "&#x27;");

const PLATE: ExplorePlate = {
  id: `0x${"7c".repeat(32)}`,
  kind: 1,
  registeredAt: 1_790_000_000,
  title: "Monsoon Fishing Nets Drying",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  manifest: false,
  rechecked: true,
  chainlink: true,
  disputed: false,
  agentId: null,
  consent: null,
};

describe("Explore: the mark's word on a plate", () => {
  it("draws the word in the mark's own ink, amber for a look-alike", () => {
    const markup = render(createElement(Plate, { plate: { ...PLATE, mark: "lookalike" } }));
    expect(markup).toContain('data-plate-mark="lookalike"');
    expect(markup).toContain(en.mark.states.lookalike.word);
    expect(markup).toContain("text-lookalike");

    const checked = render(createElement(Plate, { plate: { ...PLATE, mark: "checked" } }));
    expect(checked).toContain(en.mark.states.checked.word);
    expect(checked).toContain("text-verified");
  });

  it("draws no word where the index does not serve the mark's fields, or a sheet held from before them", () => {
    expect(render(createElement(Plate, { plate: { ...PLATE, mark: null } }))).not.toContain('data-plate-mark="');
    expect(render(createElement(Plate, { plate: PLATE }))).not.toContain('data-plate-mark="');
  });

  it("does not say sealed a third time on a sealed plate", () => {
    const markup = render(createElement(Plate, { plate: { ...PLATE, thumbnailUrl: null, sealed: true, mark: "sealed" } }));
    expect(markup).not.toContain('data-plate-mark="');
  });
});

describe("Explore: the two look-alike chips", () => {
  const search: ExploreSearch = { view: "pictures", search: "", agent: null, ai: null };
  const chips = (lookalikeChips: boolean) =>
    render(createElement(ReadingProvider, null, createElement(Filters, { search, lookalikeChips })));

  it("are drawn only where the index serves the look-alike records", () => {
    expect(chips(true)).toContain(en.explore.chips.lookalike);
    expect(chips(true)).toContain(en.explore.chips.later);
    expect(chips(false)).not.toContain(en.explore.chips.lookalike);
    expect(chips(false)).not.toContain(en.explore.chips.later);
  });

  it("ask the index for its own two fields, and only under their chips", () => {
    expect(passportWhere(filterFor(readExploreSearch({ view: "lookalike" })))).toEqual({ _and: [{ earlierFound: { _eq: true } }] });
    expect(passportWhere(filterFor(readExploreSearch({ view: "later" })))).toEqual({ _and: [{ laterLookalikeCount: { _gt: 0 } }] });
    expect(JSON.stringify(passportWhere(filterFor(readExploreSearch({ view: "all" }))))).not.toContain("earlierFound");
  });
});

describe("Verify: the answer leads with the first registration", () => {
  const HEADLINE = `0x${"7c".repeat(32)}` as Hex;
  const FIRST = `0x${"0a".repeat(32)}` as Hex;
  const HOLDER = "0x1111111111111111111111111111111111111111" as Hex;
  const closest: MatchedPassport = {
    id: HEADLINE,
    kind: 1,
    registeredAt: String(1_790_000_000 + 3 * 86_400 + 60),
    creator: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
    generatorAgentId: "0",
    disputed: false,
    title: "A later copy",
    thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
    sealed: false,
  };
  const first: FirstRegistration = { ...closest, id: FIRST, registeredAt: "1790000000", title: "The first nets", holder: HOLDER };
  const statement = {
    source: "chain",
    stated: true,
    standard: "cawg.training-mining/1.1",
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "notAllowed",
    dataMining: "notAllowed",
    at: 1_790_000_100,
    writer: HOLDER,
  };
  const answer = readAnswer(
    verifyResponseSchema.parse({
      result: {
        exact: null,
        best: { id: HEADLINE, phashDistance: 1, blockhashDistance: 8, variant: "identity", score: 0.9 },
        matches: [
          { id: HEADLINE, phashDistance: 1, blockhashDistance: 8, variant: "identity", score: 0.9 },
          { id: FIRST, phashDistance: 2, blockhashDistance: 9, variant: "identity", score: 0.8, consent: statement },
        ],
        confidence: 0.9,
        queried: {
          sha256: `0x${"ab".repeat(32)}`,
          phash: "123",
          blockhash: `0x${"cd".repeat(32)}`,
          width: 640,
          height: 480,
          format: "jpeg",
        },
        firstRegisteredId: FIRST,
      },
      manifest: { present: false },
    }),
  );

  it("puts the first registration, its holder, its AI use and its link above the closest match", () => {
    const markup = render(createElement(AnswerCard, { stage: { kind: "answer", answer, passport: closest, first } }));
    const lead = markup.indexOf("data-first-lead");
    const verdict = markup.indexOf(shown(en.verify.verdict.replace("{title}", "A later copy")));
    expect(lead).toBeGreaterThan(-1);
    expect(verdict).toBeGreaterThan(lead);
    expect(markup).toContain(en.verify.first.heading);
    expect(markup).toContain("First registered as The first nets on");
    expect(markup).toContain("Held by 0x111111…1111");
    expect(markup).toContain(`AI use: ${en.passport.consent.summary.closed}`);
    expect(markup).toContain(`href="/passport/${FIRST}"`);
    expect(markup).toContain("The file you checked is closest to A later copy, registered 3 days later.");
    // The plain line that used to carry the link is not said twice.
    expect(markup).not.toContain("data-first-registered=");
    expect(markup).not.toMatch(/data-first-registered(?!-consent)[ >"]/);
  });

  it("keeps the plain line with the link when the first registration could not be read", () => {
    const markup = render(createElement(AnswerCard, { stage: { kind: "answer", answer, passport: closest, first: null } }));
    expect(markup).not.toContain("data-first-lead");
    expect(markup).toContain("data-first-registered");
    expect(markup).toContain(`href="/passport/${FIRST}"`);
  });
});
