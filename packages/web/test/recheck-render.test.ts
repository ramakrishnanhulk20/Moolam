import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { MatchedPassport } from "@/components/verify/lookup";
import type { Stage } from "@/components/verify/AnswerCard";
import type { RecheckState } from "@/lib/recheck/state";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The button on the two screens that carry it, and in every state it has.
 *
 * Two things are settled here. A sealed passport never shows it, because a
 * re-check works by fetching the published picture and a sealed one has none:
 * offering the button there would promise something that cannot happen. And
 * every state fits in the room the control already reserved, which is what
 * keeps the page still under a reader while a request moves along the queue.
 *
 * Run with RECHECK_FIXTURE=1 to write the markup to the file named at the end
 * of this test, where a real browser measures it.
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

/** The route the control is standing in, which is where the passport page hands it the id. */
const route = vi.hoisted(() => ({ params: { locale: "en" } as Record<string, string> }));

vi.mock("next/navigation", () => ({ useParams: () => route.params }));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true", className: "absolute inset-0 block bg-bg-sunken" }),
}));

const stub = vi.hoisted(() => ({ current: null as unknown as RecheckControl }));

vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: () => stub.current,
}));

const { Attestations } = await import("@/components/passport/Attestations");
const { AnswerCard } = await import("@/components/verify/AnswerCard");
const { RecheckRequest } = await import("@/components/passport/RecheckRequest");

const ID = `0x${"7c".repeat(32)}` as Hex;
const TX = `0x${"91".repeat(32)}` as Hex;
const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const PHASH = 0x6ccf137087789a25n;

function at(state: RecheckState, spent = false): RecheckControl {
  return {
    state,
    spent,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  };
}

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

function control(state: RecheckState, spent = false): string {
  stub.current = at(state, spent);
  return render(createElement(RecheckRequest, { passportId: ID }));
}

const matched: MatchedPassport = {
  id: ID,
  kind: 1,
  registeredAt: "1788876082",
  creator: CREATOR,
  generatorAgentId: "0",
  disputed: false,
  title: "Monsoon nets, Kovalam",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  sealed: false,
  blockhash256: BLOCKHASH,
};

const answerBody = {
  result: {
    exact: ID,
    best: {
      id: ID,
      phashDistance: 0,
      blockhashDistance: 0,
      variant: "identity",
      score: 1,
      recheck: { source: "index", attestations: 0 },
    },
    matches: [
      {
        id: ID,
        phashDistance: 0,
        blockhashDistance: 0,
        variant: "identity",
        score: 1,
        recheck: { source: "index", attestations: 0 },
      },
    ],
    confidence: 1,
    queried: { sha256: ID, phash: "7840506850305415717", blockhash: BLOCKHASH, width: 1536, height: 1024, format: "jpeg" },
  },
  manifest: { present: true },
};

async function verifyCard(passport: MatchedPassport, recheck: unknown): Promise<string> {
  const { readAnswer } = await import("@/components/verify/answer");
  const body = structuredClone(answerBody) as Record<string, never>;
  const result = (body as unknown as { result: { best: Record<string, unknown>; matches: Record<string, unknown>[] } }).result;
  if (recheck === undefined) {
    delete result.best.recheck;
    delete result.matches[0].recheck;
  } else {
    result.best.recheck = recheck;
    result.matches[0].recheck = recheck;
  }
  const stage: Stage = { kind: "answer", answer: readAnswer(verifyResponseSchema.parse(body)), passport };
  return render(createElement(AnswerCard, { stage }));
}

describe("where the button shows and where it does not", () => {
  it("sits under the second opinion on a public passport page, reading the id off the route", async () => {
    route.params = { locale: "en", id: ID };
    stub.current = at({ kind: "none" });
    const markup = render(
      await Attestations({ attestations: [], indexed: [], phash: PHASH, locale: "en", sealed: false }),
    );

    expect(markup).toContain("data-recheck");
    expect(markup).toContain("Request a re-check");
    expect(markup).toContain("Requests are run in batches");
  });

  it("is not offered on a sealed passport, which has no published picture to fetch", async () => {
    route.params = { locale: "en", id: ID };
    stub.current = at({ kind: "none" });
    const markup = render(
      await Attestations({ attestations: [], indexed: [], phash: PHASH, locale: "en", sealed: true }),
    );

    expect(markup).not.toContain("data-recheck");
    expect(markup).not.toContain("Request a re-check");
  });

  it("sits under the second opinion line on the verify card", async () => {
    stub.current = at({ kind: "none" });
    const markup = await verifyCard(matched, { source: "index", attestations: 0 });

    expect(markup).toContain("data-recheck");
    expect(markup).toContain("Request a re-check");
  });

  it("is still offered when the service could not say what anyone else found", async () => {
    stub.current = at({ kind: "none" });
    const markup = await verifyCard(matched, { source: "unavailable" });

    expect(markup).not.toContain("data-second-opinion");
    expect(markup).toContain("data-recheck");
  });

  it("is not offered on the verify card for a sealed match", async () => {
    stub.current = at({ kind: "none" });
    const markup = await verifyCard({ ...matched, sealed: true, thumbnailUrl: undefined }, undefined);

    expect(markup).not.toContain("data-recheck");
  });

  it("needs no wallet, no sign in and no account to draw", () => {
    const markup = control({ kind: "none" });
    expect(markup.toLowerCase()).not.toContain("sign in");
    expect(markup).toContain("Free.");
  });
});

describe("every state the reader can meet", () => {
  const scenes: [string, RecheckState, boolean][] = [
    ["Nobody has asked yet: the button and its promise", { kind: "none" }, false],
    ["The request is going out", { kind: "sending" }, false],
    ["In the queue, with its place in the line", { kind: "queued", requestedAt: 1_790_000_000_000, position: 3, already: false }, false],
    ["Somebody had already asked for this one", { kind: "queued", requestedAt: 1_790_000_000_000, position: 2, already: true }, false],
    ["Waiting, with no place to report", { kind: "queued", requestedAt: 1_790_000_000_000, already: false }, false],
    ["The workflow is running now", { kind: "running", startedAt: 1_790_000_060_000 }, false],
    ["Done, with the transaction the verdict was written in", { kind: "done", finishedAt: 1_790_000_300_000, reportTx: TX, matched: true, distance: 0 }, false],
    ["The run could not finish", { kind: "failed", reason: "the picture could not be fetched from IPFS" }, false],
    ["Too many presses from one place", { kind: "refused", key: "rateLimited", canRetry: true }, false],
    ["A sealed passport, refused with a sentence", { kind: "refused", key: "sealed", canRetry: false }, false],
    ["The service is not answering", { kind: "refused", key: "notAnswering", canRetry: true, reason: "the verify service at https://verify.moolam.xyz/recheck/request did not answer" }, false],
    ["Half an hour of waiting, and the next look is the reader's own", { kind: "queued", requestedAt: 1_790_000_000_000, already: false }, true],
  ];

  it("draws each one, and says the one thing that state is about", () => {
    const drawn = scenes.map(([caption, state, spent]) => [caption, control(state, spent)] as const);

    expect(drawn[0][1]).toContain("Request a re-check");
    expect(drawn[1][1]).toContain("Sending the request.");
    expect(drawn[2][1]).toContain("Position 3 in the queue.");
    expect(drawn[3][1]).toContain("Already requested");
    expect(drawn[4][1]).toContain("Waiting in the queue.");
    expect(drawn[5][1]).toContain("Running now");
    expect(drawn[6][1]).toContain("Done: re-checked");
    expect(drawn[6][1]).toContain(`${TX}`);
    expect(drawn[7][1]).toContain("Could not run: the picture could not be fetched from IPFS");
    expect(drawn[8][1]).toContain("Too many requests from here, wait a minute.");
    expect(drawn[9][1]).toContain("never published");
    expect(drawn[10][1]).toContain("The verify service is not answering just now.");
    expect(drawn[11][1]).toContain("stopped checking after half an hour");

    if (process.env.RECHECK_FIXTURE === "1") {
      const body = drawn
        .map(
          ([caption, markup]) =>
            `<section class="fixture-scene"><p class="fixture-caption">${caption}</p>${markup}</section>`,
        )
        .join("\n");
      writeFileSync(fileURLToPath(new URL("../../../kitchen/reports/WO-121c-fixture.html", import.meta.url)), body, "utf8");
    }
  });

  it("offers a way to try again only where trying again is worth anything", () => {
    expect(control({ kind: "none" })).toContain("<button");
    expect(control({ kind: "failed", reason: "no" })).toContain("Try again");
    expect(control({ kind: "refused", key: "rateLimited", canRetry: true })).toContain("Try again");
    // A sealed passport and an unknown passport will not change by pressing again.
    expect(control({ kind: "refused", key: "sealed", canRetry: false })).not.toContain("<button");
    expect(control({ kind: "refused", key: "noPassport", canRetry: false })).not.toContain("<button");
    // Nothing to press while the queue still owes an answer.
    expect(control({ kind: "running" })).not.toContain("<button");
    expect(control({ kind: "queued", requestedAt: 1_790_000_000_000, already: false }, true)).toContain("Check again");
  });

  it("keeps the same room for every state, so the page does not move under the reader", () => {
    for (const [caption, state, spent] of scenes) {
      const markup = control(state, spent);
      expect(markup, caption).toContain("min-h-[2.75rem]");
      expect(markup, caption).toContain("min-h-[4.25rem]");
    }
  });

  it("says nothing at all without a passport to say it about", () => {
    route.params = { locale: "en" };
    stub.current = at({ kind: "none" });
    expect(render(createElement(RecheckRequest, {}))).toBe("");
  });
});
