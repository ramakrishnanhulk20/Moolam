import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Attestation } from "@/lib/chain/registry";
import type { RecheckState } from "@/lib/recheck/state";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import type { MatchedPassport } from "@/components/verify/lookup";
import type { Stage } from "@/components/verify/AnswerCard";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The button is offered only where a press can do something.
 *
 * The runner closes any request for a picture that already carries a
 * re-check, and it re-checks every new picture within minutes of registration.
 * So under a verdict the button could only ever come back refused. A passport
 * page that holds one says when it was re-checked instead, and the verify card
 * keeps the button only where no verdict is known.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en", id: `0x${"7c".repeat(32)}` }) }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: async () => "simulation" }));

const stub = vi.hoisted(() => ({ state: { kind: "none" } as RecheckState }));
vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: stub.state,
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

const { Attestations } = await import("@/components/passport/Attestations");
const { SecondOpinion } = await import("@/components/verify/SecondOpinion");
const { AnswerCard } = await import("@/components/verify/AnswerCard");
const { readAnswer } = await import("@/components/verify/answer");
const { addresses } = await import("@/lib/chain/client");

const ID = `0x${"7c".repeat(32)}` as Hex;
const TX = `0x${"91".repeat(32)}` as Hex;
const PHASH = 0x6ccf137087789a25n;
const BUTTON = en.recheck.button;
const NOTE = en.recheck.note.replace(/'/g, "&#x27;");

const row: Attestation = {
  receiver: addresses.simulationReceiver,
  matched: true,
  distance: 0,
  recomputed: `0x${PHASH.toString(16).padStart(16, "0")}${"00".repeat(24)}` as Hex,
  // 14 Sept 2026 in UTC.
  at: 1_789_368_639n,
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

async function passportPage(rows: Attestation[]): Promise<string> {
  return render(
    await Attestations({
      attestations: rows,
      indexed: rows.map((one) => ({ txHash: TX, receiver: one.receiver, at: one.at, distance: one.distance })) as never,
      phash: PHASH,
      locale: "en",
      sealed: false,
    }),
  );
}

describe("the passport page", () => {
  it("says when a passport with a verdict was re-checked, with no button and no note, while nobody has asked here", async () => {
    stub.state = { kind: "none" };
    const markup = await passportPage([row]);

    expect(markup).toContain("Re-checked on 14 Sept 2026");
    expect(markup).toContain('data-recheck-state="rechecked"');
    expect(markup).not.toContain(BUTTON);
    expect(markup).not.toContain(NOTE);
  });

  it("offers the button and its note on a passport with no verdict yet", async () => {
    stub.state = { kind: "none" };
    const markup = await passportPage([]);

    expect(markup).toContain(BUTTON);
    expect(markup).toContain(NOTE);
    expect(markup).not.toContain("Re-checked on");
  });
});

describe("the verify card's second opinion", () => {
  it("draws the verdict and its link to the passport's re-check block, and no button", () => {
    stub.state = { kind: "none" };
    const markup = render(
      createElement(SecondOpinion, {
        id: ID,
        recheck: {
          source: "index",
          attestations: 1,
          matched: 1,
          mismatched: 0,
          latest: { matched: true, distance: 0, at: 1_789_368_639, receiver: addresses.simulationReceiver },
        },
      }),
    );

    expect(markup).toContain("data-second-opinion");
    expect(markup).toContain(`/passport/${ID}#second-opinion`);
    expect(markup).not.toContain("data-recheck");
    expect(markup).not.toContain(BUTTON);
  });

  it("keeps the button where nothing has re-checked the picture yet", () => {
    stub.state = { kind: "none" };
    const markup = render(createElement(SecondOpinion, { id: ID, recheck: { source: "index", attestations: 0 } }));

    expect(markup).toContain("data-recheck");
    expect(markup).toContain(BUTTON);
  });
});

describe("the verify card when the service could not say what anyone else found", () => {
  it("keeps the button, because nothing says a verdict exists", () => {
    stub.state = { kind: "none" };
    const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;
    const match = { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1, recheck: { source: "unavailable" } };
    const body = {
      result: {
        exact: ID,
        best: match,
        matches: [match],
        confidence: 1,
        queried: { sha256: ID, phash: "7840506850305415717", blockhash: BLOCKHASH, width: 1536, height: 1024, format: "jpeg" },
      },
      manifest: { present: true },
    };
    const passport: MatchedPassport = {
      id: ID,
      kind: 1,
      registeredAt: "1788876082",
      creator: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a",
      generatorAgentId: "0",
      disputed: false,
      title: "Monsoon nets, Kovalam",
      thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
      sealed: false,
      blockhash256: BLOCKHASH,
    };
    const stage: Stage = { kind: "answer", answer: readAnswer(verifyResponseSchema.parse(body)), passport };
    const markup = render(createElement(AnswerCard, { stage }));

    expect(markup).not.toContain("data-second-opinion");
    expect(markup).toContain("data-recheck");
    expect(markup).toContain(BUTTON);
  });
});
