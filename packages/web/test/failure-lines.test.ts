// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createFormatter, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import hi from "@/messages/hi.json";
import ja from "@/messages/ja.json";
import ko from "@/messages/ko.json";
import pt from "@/messages/pt.json";
import ta from "@/messages/ta.json";
import zh from "@/messages/zh.json";
import { timeFormats } from "@/lib/i18n/timeFormats";
import type { Attestation } from "@/lib/chain/registry";
import type { FlagPassport } from "@/lib/disputes/useFlagPassport";
import { initialFlagState } from "@/lib/disputes/flag";
import type { RecheckState } from "@/lib/recheck/state";
import type { RecheckControl } from "@/lib/recheck/useRecheck";

/**
 * The failure lines the proof walk still found wrong (rooms 16, 26, 27, 30 and
 * 40). A failure prints its translated sentence with its warning mark, and the
 * library's own English only inside the folded Details, cleaned the way
 * FailureDetails cleans it. An id inside a label in capitals keeps its own
 * lower case. A re-check's time never breaks inside itself. Verify's next check
 * is under the verdict on a phone. The privacy line's bracket travels with the
 * address it opens.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (arg?: string | { namespace?: string }) =>
    createTranslator({
      locale: "en",
      messages: en,
      namespace: (typeof arg === "string" ? arg : arg?.namespace) as never,
    }),
  getFormatter: async () => createFormatter({ locale: "en", timeZone: "UTC", formats: timeFormats }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  useParams: () => ({ locale: "en" }),
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: async () => "simulation" }));

const recheckStub = vi.hoisted(() => ({ current: null as unknown as RecheckControl }));
vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: () => recheckStub.current,
}));

const flagStub = vi.hoisted(() => ({ current: null as unknown as FlagPassport }));
vi.mock("@/lib/disputes/useFlagPassport", () => ({ useFlagPassport: () => flagStub.current }));

const { reason: oneLine } = await import("@/lib/chain/client");
const { Grid } = await import("@/components/explore/Grid");
const { ReadingProvider } = await import("@/components/explore/Reading");
const { Masthead } = await import("@/components/explore/Masthead");
const { Board } = await import("@/components/agents/Board");
const { Standing } = await import("@/components/agent/Standing");
const { RecheckRequest } = await import("@/components/passport/RecheckRequest");
const { AnswerCard } = await import("@/components/verify/AnswerCard");
const { PrivateCopyCard } = await import("@/components/passport/PrivateCopyPanel");
const { Challenge } = await import("@/components/passport/Challenge");
const { Attestations, splitClock } = await import("@/components/passport/Attestations");
const { Privacy, HOST_MARK } = await import("@/components/verify/VerifyScreen");
const { DEFAULT_SEARCH } = await import("@/components/explore/query");
const { readAnswer } = await import("@/components/verify/answer");
const { verifyResponseSchema } = await import("@/lib/verifier/client");

const HASH = `0x${"ab".repeat(32)}`;
/** What a chain read throws: a first line naming the endpoint and a hash, then the whole request. */
const RAW = `HTTP request failed at https://rpc.example.com/v1?key=secret for ${HASH}.\n\nRequest body: {"method":"eth_call"}`;
const CLEANED = oneLine(RAW);

const LOCALES = { en, de, es, fr, hi, ja, ko, pt, ta, zh } as const;

function render(node: ReactElement, messages: object = en, locale = "en"): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale, messages, timeZone: "UTC" }, node));
}

function dom(markup: string): Document {
  return new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
}

/** The page's words outside every Details fold, where the reader meets them. */
function outsideDetails(markup: string): string {
  const doc = dom(markup);
  doc.querySelectorAll("details").forEach((node) => node.remove());
  return doc.body.textContent ?? "";
}

/** Every failure line's own text: the red lines that carry the warning mark. */
function markedLines(markup: string): string[] {
  return [...dom(markup).querySelectorAll("svg polygon")]
    .map((mark) => mark.closest("p, div[role=alert]"))
    .filter((line): line is Element => line !== null)
    .map((line) => (line.textContent ?? "").trim());
}

function detailsText(markup: string): string[] {
  return [...dom(markup).querySelectorAll("[data-failure-details] p")].map((node) => node.textContent ?? "");
}

/** Checks one failure: the sentence alone and marked, the reason only folded and cleaned. */
function expectFolded(markup: string, sentence: string) {
  expect(markedLines(markup)).toContain(sentence);
  expect(outsideDetails(markup)).not.toContain("HTTP request failed");
  expect(markup).not.toContain("rpc.example.com");
  expect(detailsText(markup)).toContain(CLEANED);
}

function recheckAt(state: RecheckState): RecheckControl {
  return { state, spent: false, checking: false, actions: { request: () => undefined, check: () => undefined } };
}

const source = (path: string) => readFileSync(path, "utf8");

describe("step 2: raw reasons out of the sentences (room 26)", () => {
  it("Explore's sheet says the index could not be read, marked, with the reason folded", () => {
    const grid = (indexError: string, messages: object = en, locale = "en") =>
      render(
        createElement(ReadingProvider, null, createElement(Grid, { first: [], cursor: null, search: DEFAULT_SEARCH, indexError })),
        messages,
        locale,
      );
    expectFolded(grid(RAW), "The index could not be read.");

    // The reason's slot and the colon before it leave together in every language.
    const alone: Record<string, string> = {
      en: "The index could not be read.",
      de: "Der Index konnte nicht gelesen werden.",
      fr: "L'index n'a pas pu être lu.",
      hi: "इंडेक्स नहीं पढ़ा जा सका।",
      ja: "インデックスを読み取れませんでした。",
      zh: "无法读取索引。",
    };
    for (const [locale, messages] of Object.entries(LOCALES)) {
      const line = markedLines(grid(RAW, messages, locale))[0] ?? "";
      expect(line, locale).not.toMatch(/[:：]\s*[.。।]?$/);
      expect(line, locale).not.toContain("HTTP");
      if (alone[locale] !== undefined) {
        expect(line, locale).toBe(alone[locale]);
      }
    }
  });

  it("Explore's counts, the Agents board and an agent's two panels do the same", async () => {
    expectFolded(
      render(await Masthead({ locale: "en", counts: null, countsError: RAW, split: null, view: DEFAULT_SEARCH.view })),
      "The counts could not be read.",
    );
    // No reason at all is the page's own translated words, which may stay in the sentence.
    const missing = render(await Masthead({ locale: "en", counts: null, countsError: null, split: null, view: DEFAULT_SEARCH.view }));
    expect(markedLines(missing)).toContain("The counts could not be read: no index answered.");

    expectFolded(render(await Board({ agents: [], error: RAW, locale: "en" })), "The index could not be read.");

    const standing = render(
      await Standing({ locale: "en", record: null, recordError: RAW, reputation: null, reputationError: RAW }),
    );
    expect(markedLines(standing)).toContain("The index could not be read.");
    expect(markedLines(standing)).toContain("The reputation registry could not be read.");
    expect(outsideDetails(standing)).not.toContain("HTTP request failed");
    expect(detailsText(standing).filter((text) => text === CLEANED)).toHaveLength(2);
  });

  it("a re-check that could not run says so, with the runner's words folded", () => {
    recheckStub.current = recheckAt({ kind: "failed", reason: RAW });
    expectFolded(render(createElement(RecheckRequest, { passportId: HASH as Hex })), "Could not run");
  });

  it("the studio's passkey line formats its sentence without the reason and folds it under", () => {
    const studio = source("components/studio/LiveStudio.tsx");
    expect(studio).toContain('t("passkey.unreadable", { reason: REASON_SLOT }).replace(REASON_CUT, "")');
    expect(studio).toContain("<FailureDetails reason={studio.binding.error}");
    expect(studio).not.toContain("oneLine(");
  });

  it("no file in this order passes a raw reason into a sentence any more", () => {
    const files = [
      "components/explore/Grid.tsx",
      "components/explore/Masthead.tsx",
      "components/agents/Board.tsx",
      "components/agent/Standing.tsx",
      "components/studio/LiveStudio.tsx",
      "components/passport/RecheckRequest.tsx",
    ];
    for (const file of files) {
      const passed = [...source(file).matchAll(/\{ reason: ([^})]+)/g)].map((match) => match[1].trim());
      expect(passed.filter((value) => value !== "REASON_SLOT" && value !== 't("countsMissing"'), file).toEqual([]);
    }
  });
});

describe("step 3: every raw failure text is cleaned the way FailureDetails cleans it", () => {
  it("cleans the refusal on Verify's card", () => {
    const markup = render(createElement(AnswerCard, { stage: { kind: "problem", problem: { key: "problem.serviceFailed", reason: RAW } } }));
    expect(detailsText(markup)).toEqual([CLEANED]);
    expect(markup).not.toContain("rpc.example.com");
    expect(markup).toContain(HASH);
  });

  it("cleans a refused re-check", () => {
    recheckStub.current = recheckAt({ kind: "refused", key: "unknown", reason: RAW, canRetry: true });
    const markup = render(createElement(RecheckRequest, { passportId: HASH as Hex }));
    expect(markup).toContain(`>${CLEANED}</p>`);
    expect(markup).not.toContain("rpc.example.com");
  });

  it("cleans the private copy panel's refusal", () => {
    const markup = render(
      createElement(PrivateCopyCard, {
        state: { step: "confirming", failure: { key: "unknown", reason: RAW } },
        actions: { ask: () => undefined, keep: () => undefined, forget: () => undefined, signIn: () => undefined },
      }),
    );
    expect(markup).toContain(`>${CLEANED}</p>`);
    expect(markup).not.toContain("rpc.example.com");
  });

  it("cleans the challenge panel's failure", () => {
    flagStub.current = {
      ready: true,
      authenticated: true,
      isOwner: false,
      wallet: `0x${"85".repeat(20)}`,
      reading: false,
      bond: 10n ** 18n,
      balance: 3n * 10n ** 18n,
      check: { enough: true, shortfall: 0n },
      state: { ...initialFlagState, open: true, reason: "x".repeat(40), failure: { key: "unknown", reason: RAW } },
      actions: {
        open: () => undefined,
        close: () => undefined,
        setReason: () => undefined,
        submit: async () => undefined,
        recheck: async () => undefined,
        signIn: () => undefined,
        reset: () => undefined,
      },
    } as unknown as FlagPassport;
    const markup = render(createElement(Challenge, { passportId: HASH as Hex, owner: `0x${"55".repeat(20)}` as Hex, disputeOpen: false }));
    expect(markup).toContain(`>${CLEANED}</p>`);
    expect(markup).not.toContain("rpc.example.com");
  });
});

describe("step 4: the warning mark on every failure line (room 40)", () => {
  it("Verify's refused copy is an alert with its mark, as the poster's Copy link is", () => {
    const share = source("components/verify/ShareAnswer.tsx");
    expect(share).toMatch(/<div role="alert" data-share-failed[^>]*text-failed[^>]*>\s*<WarningMark/);
  });

  it("Explore's two failure lines and its counts line carry the mark", async () => {
    const grid = render(
      createElement(ReadingProvider, null, createElement(Grid, { first: [], cursor: null, search: DEFAULT_SEARCH, indexError: RAW })),
    );
    expect(markedLines(grid)).toHaveLength(1);
    const counts = render(await Masthead({ locale: "en", counts: null, countsError: RAW, split: null, view: DEFAULT_SEARCH.view }));
    expect(markedLines(counts)).toHaveLength(1);
    // The Load more failure is the same line under the sheet.
    expect(source("components/explore/Grid.tsx").match(/<WarningMark className="mt-\[5px\]" \/>/g)).toHaveLength(2);
  });

  it("the resolver desk's failure is marked and set at the body size", () => {
    const page = source("app/[locale]/resolve/page.tsx");
    expect(page).toMatch(/<p className="[^"]*text-base[^"]*text-failed">\s*<WarningMark/);
    expect(page).not.toContain("text-sm leading-relaxed text-failed");
  });
});

describe("step 5: an id inside a label in capitals keeps its own lower case (room 30)", () => {
  const chainlinkRow = async () => {
    const { addresses } = await import("@/lib/chain/client");
    const attestation: Attestation = {
      receiver: addresses.receiver as Hex,
      matched: true,
      distance: 0,
      recomputed: `0x${"6c".repeat(8)}` as Hex,
      at: 1_790_523_000n,
    };
    const txHash = `0x35c130${"0".repeat(54)}4c1a` as Hex;
    return {
      attestation,
      txHash,
      markup: render(
        await Attestations({
          attestations: [attestation],
          indexed: [{ txHash, receiver: attestation.receiver, matched: true, distance: 0, at: attestation.at }],
          phash: 0x6c6c6c6c6c6c6c6cn,
          locale: "en",
        }),
      ),
    };
  };

  it("the passport's transaction button sets the hash in a normal-case span", async () => {
    const { markup } = await chainlinkRow();
    expect(markup).toMatch(/Transaction <span data-hex="true" class="normal-case">0x35c130…4c1a<\/span>/);
  });

  it("every other label named in the order puts its id through withHex", () => {
    const wrapped: Record<string, string[]> = {
      "components/passport/Challenge.tsx": ['withHex(t("done.openTx", { hash: HEX_MARK })'],
      "components/passport/ConsentEditor.tsx": ['withHex(t("openTx", { hash: HEX_MARK })'],
      "components/passport/Editor.tsx": ['withHex(t("done.openTx", { hash: HEX_MARK })'],
      "components/studio/DoneActions.tsx": [
        'withHex(t("register.openTx", { hash: HEX_MARK })',
        'withHex(t("register.openAddress", { wallet: HEX_MARK })',
      ],
      "components/story/LandingStory.tsx": [
        'withHex(t("sealed.readout", { passport: HEX_MARK, date: registered })',
        't("verified.provenance", { passport: HEX_MARK, date: measuredOn })',
      ],
    };
    for (const [file, calls] of Object.entries(wrapped)) {
      const text = source(file);
      for (const call of calls) {
        expect(text, file).toContain(call);
      }
    }
    const showcase = source("components/studio/Showcase.tsx");
    expect(showcase).toMatch(/<span data-hex className="(?![^"]*uppercase)[^"]*">\s*\{shortHex\(passport\.id, 6, 4\)\}/);
  });
});

describe("step 6: a re-check's time stays on one line (Attestations)", () => {
  it("splits a date around its clock, and gives up cleanly when the clock is not in it", () => {
    expect(splitClock("Sep 27, 2026, 3:49 PM UTC", "3:49 PM UTC")).toEqual({
      before: "Sep 27, 2026, ",
      clock: "3:49 PM UTC",
      after: "",
    });
    expect(splitClock("27.09.2026", "15:49 UTC")).toBeNull();
    expect(splitClock("27.09.2026", "")).toBeNull();
  });

  it("sets the time and its zone unbreakable and lets only the date wrap", async () => {
    const { markup } = await chainlinkRow();
    const clock = dom(markup).querySelector("[data-clock]");
    expect(clock?.className).toBe("whitespace-nowrap");
    expect(clock?.textContent).toMatch(/^\d{1,2}:\d{2}\s(AM|PM)\sUTC$/);
    const field = clock?.closest("dd");
    expect(field?.className).toContain("break-words");
    expect(field?.className).not.toContain("break-all");
  });

  async function chainlinkRow() {
    const { addresses } = await import("@/lib/chain/client");
    const attestation: Attestation = {
      receiver: addresses.receiver as Hex,
      matched: true,
      distance: 0,
      recomputed: `0x${"6c".repeat(8)}` as Hex,
      at: 1_790_523_000n,
    };
    return { markup: render(await Attestations({ attestations: [attestation], indexed: [], phash: 0x6c6c6c6c6c6c6c6cn, locale: "en" })) };
  }
});

describe("step 7: Verify's next check is under the verdict on a phone (room 16)", () => {
  const body = {
    result: {
      exact: HASH,
      best: { id: HASH, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 },
      matches: [{ id: HASH, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 }],
      confidence: 1,
      queried: { sha256: HASH, phash: "7840506850305415717", blockhash: HASH, width: 1536, height: 1024, format: "jpeg" },
    },
    manifest: { present: false },
  };
  const answer = () => readAnswer(verifyResponseSchema.parse(body));

  it("puts a quiet Choose another straight under the verdict, on a phone only, when the page hands it a way to choose", () => {
    const markup = render(
      createElement(AnswerCard, {
        stage: { kind: "answer", answer: answer(), passport: null },
        onChooseAnother: () => undefined,
      }),
    );
    const doc = dom(markup);
    const near = doc.querySelector("[data-choose-near]");
    expect(near?.textContent).toBe(en.verify.replace);
    expect(near?.className).toContain("lg:hidden");
    expect(near?.className).toContain("border-line-strong");
    const verdict = markup.indexOf("Byte for byte");
    const at = markup.indexOf("data-choose-near");
    expect(verdict).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(verdict);
    expect(at).toBeLessThan(markup.indexOf(en.verify.confidence));
  });

  it("draws nothing extra where no way to choose was handed over, like the home page", () => {
    const markup = render(createElement(AnswerCard, { stage: { kind: "answer", answer: answer(), passport: null } }));
    expect(markup).not.toContain("data-choose-near");
  });

  it("keeps one file input and the Choose another at the foot", () => {
    const screen = source("components/verify/VerifyScreen.tsx");
    expect(screen.match(/type="file"/g)).toHaveLength(1);
    expect(screen).toContain("data-choose-after");
    expect(screen).toContain('onChooseAnother={stage.kind === "answer" ? () => input.current?.click() : undefined}');
  });
});

describe("step 8: the privacy line's bracket travels with the address (room 27)", () => {
  it("keeps the opening bracket, the address and the closing bracket in one piece, breaking only at the dots", () => {
    const host = "verifier-production-d76f.up.railway.app";
    for (const [locale, messages] of Object.entries(LOCALES)) {
      const line = messages.verify.privacy.replace("{host}", HOST_MARK);
      const doc = dom(renderToStaticMarkup(createElement(Privacy, { line, host })));
      const piece = doc.querySelector("[data-privacy-host]");
      expect(piece?.textContent, locale).toMatch(/^[(（].*verifier-production-d76f\.up\.railway\.app[)）]/u);
      expect(piece?.querySelectorAll("wbr").length, locale).toBe(3);
      for (const label of piece?.querySelectorAll(".whitespace-nowrap") ?? []) {
        expect(label.textContent, locale).not.toMatch(/\.\S/);
      }
      const before = (piece?.previousSibling?.textContent ?? doc.body.textContent ?? "").trimEnd();
      expect(before.endsWith("("), locale).toBe(false);
      expect(doc.body.textContent, locale).toBe(messages.verify.privacy.replace("{host}", host));
    }
  });
});
