import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
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
import type { Stage } from "@/components/verify/AnswerCard";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import { readAnswer, upheldAncestor, type Answer } from "@/components/verify/answer";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * The line a verify card adds when an earlier version of the matched picture lost a challenge.
 *
 * The registry marks only the passport a challenge named, so an edit of a disputed picture reads
 * "none" in its own dispute field. The service now sends inheritedDispute beside it, and this pins
 * what the card makes of each of its shapes, and of a service that does not send it at all.
 *
 * Does NOT cover how the service walks the edit chain or its depth cap (the verifier's own suite),
 * nor the line's wording beyond English and the presence of the link in the other nine files.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }) }));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: { kind: "none" },
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

const { AnswerCard } = await import("@/components/verify/AnswerCard");

const ID = `0x${"5e".repeat(32)}` as Hex;
const ANCESTOR = `0x${"a1".repeat(32)}` as Hex;
const LINE = "An earlier version of this picture lost a challenge.";

const queried = {
  sha256: `0x${"3c".repeat(32)}`,
  phash: "7840159428093749285",
  blockhash: `0x${"4d".repeat(32)}`,
  width: 1536,
  height: 1024,
  format: "jpeg",
};

/** One exact answer off the wire, clean in its own dispute field, carrying the inherited fact given. */
function wire(inheritedDispute?: unknown) {
  const best = {
    id: ID,
    phashDistance: 0,
    blockhashDistance: 0,
    variant: "identity",
    score: 1,
    dispute: { source: "chain", status: "none" },
    ...(inheritedDispute === undefined ? {} : { inheritedDispute }),
  };
  return verifyResponseSchema.safeParse({
    result: { exact: ID, best, matches: [best], confidence: 1, queried },
    manifest: { present: true },
  });
}

function answerWith(inheritedDispute?: unknown): Answer {
  const parsed = wire(inheritedDispute);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return readAnswer(parsed.data);
}

function card(answer: Answer): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  const stage: Stage = { kind: "answer", answer, passport: null };
  return renderToStaticMarkup(
    createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, createElement(AnswerCard, { stage })),
  );
}

describe("the inherited dispute field on the wire", () => {
  it("reads the upheld shape with the ancestor it names", () => {
    const answer = answerWith({ source: "chain", status: "upheld", ancestor: ANCESTOR });
    expect(answer.kind === "miss" ? null : answer.inheritedDispute).toEqual({
      source: "chain",
      status: "upheld",
      ancestor: ANCESTOR,
    });
  });

  it("still parses an answer from a service that does not send it", () => {
    expect(wire().success).toBe(true);
    const answer = answerWith();
    expect(answer.kind === "miss" ? null : answer.inheritedDispute).toBeUndefined();
  });

  // The service now says when it read each fact (verifier review pass 6, V46). The card shows nothing new.
  it("parses facts that carry readAt, and draws the same card as facts without it", () => {
    const readAt = 1_790_000_000;
    const upheld = { source: "chain", status: "upheld", ancestor: ANCESTOR };
    const stamped = wire({ ...upheld, readAt });
    expect(stamped.success).toBe(true);
    const best = stamped.success ? stamped.data.result.best : null;
    expect(best?.inheritedDispute).toEqual(upheld);

    const withTimes = verifyResponseSchema.safeParse({
      result: {
        exact: ID,
        best: {
          id: ID,
          phashDistance: 0,
          blockhashDistance: 0,
          variant: "identity",
          score: 1,
          consent: { source: "chain", stated: false, readAt },
          dispute: { source: "chain", status: "none", readAt },
          inheritedDispute: { ...upheld, readAt },
          picture: { state: "public", readAt },
        },
        matches: [],
        confidence: 1,
        queried,
      },
      manifest: { present: true },
    });
    expect(withTimes.success).toBe(true);
    expect(card(answerWith({ ...upheld, readAt }))).toBe(card(answerWith(upheld)));
  });

  it("drops an ancestor that is not a 32 byte id instead of failing the whole answer", () => {
    for (const ancestor of ["0x1234", "javascript:alert(1)", `0x${"zz".repeat(32)}`, `${"a1".repeat(32)}`, 7]) {
      const parsed = wire({ source: "chain", status: "upheld", ancestor });
      expect(parsed.success).toBe(true);
      const answer = answerWith({ source: "chain", status: "upheld", ancestor });
      expect(answer.kind === "miss" ? null : answer.inheritedDispute).toBeUndefined();
    }
  });
});

describe("the inherited dispute line on the answer card", () => {
  it("says an earlier version lost a challenge and links to that version's passport", () => {
    const markup = card(answerWith({ source: "chain", status: "upheld", ancestor: ANCESTOR }));
    expect(markup).toContain("data-inherited-dispute");
    expect(markup).toContain(LINE);
    expect(markup).toContain(`href="/passport/${ANCESTOR}"`);
    expect(markup).toContain(">Open that version</a>");
    expect(markup).toContain("text-disputed");
  });

  it("sits right after the direct dispute line, which still reads clean", () => {
    const markup = card(answerWith({ source: "chain", status: "upheld", ancestor: ANCESTOR }));
    expect(markup).toContain("No challenge is open against this passport.");
    expect(markup.indexOf("data-dispute-line")).toBeLessThan(markup.indexOf("data-inherited-dispute"));
    expect(markup.indexOf("data-inherited-dispute")).toBeLessThan(markup.indexOf(`href="/passport/${ID}"`));
  });

  it("adds nothing for none, for unavailable, or when the field is absent", () => {
    const absent = card(answerWith());
    expect(absent).not.toContain("data-inherited-dispute");
    expect(absent).not.toContain(LINE);
    for (const shape of [{ source: "chain", status: "none" }, { source: "unavailable" }]) {
      expect(card(answerWith(shape))).toBe(absent);
    }
  });

  it("never turns an invalid ancestor into a link, from the wire or from an answer built by hand", () => {
    const absent = card(answerWith());
    expect(card(answerWith({ source: "chain", status: "upheld", ancestor: "0x1234" }))).toBe(absent);

    const built = answerWith();
    if (built.kind === "miss") {
      throw new Error("expected a match");
    }
    const forged = {
      ...built,
      inheritedDispute: { source: "chain", status: "upheld", ancestor: "https://evil.example" as Hex },
    } as Answer;
    const markup = card(forged);
    expect(markup).not.toContain("data-inherited-dispute");
    expect(markup).not.toContain("evil.example");
    expect(upheldAncestor({ source: "chain", status: "upheld", ancestor: `${ANCESTOR}00` as Hex })).toBeNull();
    expect(upheldAncestor({ source: "chain", status: "upheld", ancestor: ANCESTOR })).toBe(ANCESTOR);
  });

  it("has the line in all ten languages, each with its one link", () => {
    for (const messages of [en, de, es, fr, hi, ja, ko, pt, ta, zh]) {
      expect(messages.verify.dispute.inherited.match(/<link>[^<]+<\/link>/g)?.length).toBe(1);
    }
  });
});
