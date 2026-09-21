import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { AnswerCard, type Stage } from "@/components/verify/AnswerCard";
import { DisputeLine } from "@/components/verify/DisputeLine";
import { SecondOpinion } from "@/components/verify/SecondOpinion";
import { readAnswer, type Answer } from "@/components/verify/answer";
import { verifyResponseSchema, type MatchRecheck } from "@/lib/verifier/client";

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The link is the one thing this line uses from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

/**
 * The second opinion a verify answer carries, from the wire to the line on the
 * card.
 *
 * The service sends three shapes and no fourth, and an older service sends
 * nothing at all. Each of them means a different sentence, and the one that
 * must never happen is a reader being told a picture was re-checked because the
 * service could not tell.
 */

const ID = `0x${"5e".repeat(32)}` as const;
const RECEIVER = "0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04";

const queried = {
  sha256: `0x${"3c".repeat(32)}`,
  phash: "7840159428093749285",
  blockhash: `0x${"4d".repeat(32)}`,
  width: 1536,
  height: 1024,
  format: "jpeg",
};

/** One answer off the wire, with whatever the match rows should carry. */
function answerWith(recheck: unknown, options: { onlyInList?: boolean } = {}): Answer {
  const best = { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1, recheck };
  const listed = { ...best };
  return readAnswer(
    verifyResponseSchema.parse({
      result: {
        exact: null,
        best: options.onlyInList === true ? { ...best, recheck: undefined } : best,
        matches: [listed],
        confidence: 0.99,
        queried,
      },
      manifest: { present: true },
    }),
  );
}

describe("the recheck field a verify answer carries", () => {
  it("reads the live shape: one re-check that matched, with its distance, day and receiver", () => {
    const answer = answerWith({
      source: "index",
      attestations: 1,
      matched: 1,
      mismatched: 0,
      latest: { matched: true, distance: 0, at: 1789368639, receiver: RECEIVER },
    });

    expect(answer.kind).toBe("close");
    expect(answer.kind === "miss" ? null : answer.recheck).toEqual({
      source: "index",
      attestations: 1,
      matched: 1,
      mismatched: 0,
      latest: { matched: true, distance: 0, at: 1789368639, receiver: RECEIVER },
    });
  });

  it("keeps a re-check that did not match, which is the one nobody may round off", () => {
    const answer = answerWith({
      source: "index",
      attestations: 2,
      matched: 1,
      mismatched: 1,
      latest: { matched: false, distance: 19, at: 1789368639, receiver: RECEIVER },
    });

    const recheck = answer.kind === "miss" ? null : answer.recheck;
    expect(recheck).toMatchObject({ attestations: 2, mismatched: 1 });
    expect(recheck !== null && recheck !== undefined && recheck.source === "index" && "latest" in recheck
      ? recheck.latest.matched
      : null).toBe(false);
  });

  it("reads a picture nothing has re-checked yet as a count of zero, not as silence", () => {
    const answer = answerWith({ source: "index", attestations: 0 });

    expect(answer.kind === "miss" ? null : answer.recheck).toEqual({ source: "index", attestations: 0 });
  });

  it("keeps unavailable apart from zero, because one is a fact and the other is a shrug", () => {
    const answer = answerWith({ source: "unavailable" });

    expect(answer.kind === "miss" ? null : answer.recheck).toEqual({ source: "unavailable" });
  });

  it("leaves the field undefined when the service never sent one", () => {
    const answer = answerWith(undefined);

    expect(answer.kind === "miss" ? null : answer.recheck).toBeUndefined();
  });

  it("finds the fact on the matched row when the best block came back without it", () => {
    const answer = answerWith({ source: "index", attestations: 0 }, { onlyInList: true });

    expect(answer.kind === "miss" ? null : answer.recheck).toEqual({ source: "index", attestations: 0 });
  });

  it("refuses a count with no verdict behind it, rather than printing half a fact", () => {
    const half = { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 };
    const parsed = verifyResponseSchema.safeParse({
      result: {
        exact: null,
        best: { ...half, recheck: { source: "index", attestations: 3, matched: 3, mismatched: 0 } },
        matches: [half],
        confidence: 0.99,
        queried,
      },
      manifest: { present: false },
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a source this app has no sentence for, rather than drawing nothing quietly", () => {
    const half = { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 };
    const parsed = verifyResponseSchema.safeParse({
      result: {
        exact: null,
        best: { ...half, recheck: { source: "guess", attestations: 1 } },
        matches: [half],
        confidence: 0.99,
        queried,
      },
      manifest: { present: false },
    });

    expect(parsed.success).toBe(false);
  });
});

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

const MATCHED: MatchRecheck = {
  source: "index",
  attestations: 1,
  matched: 1,
  mismatched: 0,
  latest: { matched: true, distance: 1, at: 1789368639, receiver: RECEIVER as `0x${string}` },
};

describe("the second opinion line, in all four of its states", () => {
  it("says who re-checked the picture, what they did and how far apart it came out", () => {
    const markup = render(createElement(SecondOpinion, { recheck: MATCHED, id: ID }));

    expect(markup).toContain("The second opinion");
    expect(markup).toContain("Chainlink CRE workflow");
    expect(markup).toContain("recomputed the fingerprint and matched");
    expect(markup).toContain("1 of 64 bits apart");
    expect(markup).toContain("2026");
    expect(markup).toContain("See the second opinion");
    expect(markup).toContain(`/passport/${ID}`);
  });

  it("says a re-check that did not match plainly, and in the status colour rather than the accent", () => {
    const markup = render(
      createElement(SecondOpinion, {
        recheck: { ...MATCHED, matched: 0, mismatched: 1, latest: { ...MATCHED.latest, matched: false, distance: 19 } },
        id: ID,
      }),
    );

    expect(markup).toContain("did not match");
    expect(markup).toContain("19 of 64 bits apart");
    expect(markup).toContain("text-failed");
    expect(markup).not.toContain("text-accent");
  });

  it("says nothing has re-checked it yet when the count is zero", () => {
    const markup = render(
      createElement(SecondOpinion, { recheck: { source: "index", attestations: 0 }, id: ID }),
    );

    expect(markup).toContain("Not re-checked yet.");
    expect(markup).not.toContain("Chainlink");
  });

  it("draws nothing at all when the service could not tell, and nothing when it never said", () => {
    expect(render(createElement(SecondOpinion, { recheck: { source: "unavailable" }, id: ID }))).toBe("");
    expect(render(createElement(SecondOpinion, { recheck: undefined, id: ID }))).toBe("");
  });

  it("rides on the answer card itself, under the holder's own statement", () => {
    const answer: Answer = {
      kind: "close",
      id: ID,
      confidence: 0.99,
      phashDistance: 1,
      blockhashDistance: 0,
      variant: "identity",
      others: 0,
      manifest: true,
      recheck: MATCHED,
      queried,
    };
    const stage: Stage = { kind: "answer", answer, passport: null };

    const markup = render(createElement(AnswerCard, { stage }));
    expect(markup).toContain("Chainlink CRE workflow");
    expect(markup.indexOf("data-consent-stamp")).toBeLessThan(markup.indexOf("data-second-opinion"));
  });

  it("leaves the card unchanged for an answer from a service that carries no such field", () => {
    const answer: Answer = {
      kind: "exact",
      id: ID,
      confidence: 1,
      phashDistance: 0,
      blockhashDistance: 0,
      variant: "identity",
      others: 0,
      manifest: true,
      queried,
    };

    const markup = render(createElement(AnswerCard, { stage: { kind: "answer", answer, passport: null } }));
    expect(markup).not.toContain("data-second-opinion");
    expect(markup).toContain("Confidence");
  });
});

describe("the dispute line, in all five of its states", () => {
  /** One answer off the wire carrying whatever the match rows say about a challenge. */
  function disputeIn(dispute: unknown): Answer {
    const best = { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1, dispute };
    return readAnswer(
      verifyResponseSchema.parse({
        result: { exact: ID, best, matches: [best], confidence: 1, queried },
        manifest: { present: true },
      }),
    );
  }

  function lineFor(status: string): string {
    const answer = disputeIn({ source: "chain", status });
    return render(
      createElement(DisputeLine, { dispute: answer.kind === "miss" ? undefined : answer.dispute }),
    );
  }

  it("says a clean record plainly, in the faint colour, because it is not news", () => {
    const markup = lineFor("none");
    expect(markup).toContain("No challenge is open against this passport.");
    expect(markup).toContain("text-text-faint");
  });

  it("tells a reader not to rely on the statement while a challenge is open, in the status colour", () => {
    const markup = lineFor("open");
    expect(markup).toContain("This passport is under challenge.");
    expect(markup).toContain("Do not rely on its statement on AI use");
    expect(markup).toContain("text-failed");
    expect(markup).not.toContain("text-accent");
  });

  it("calls an upheld challenge what it is: the record and the statement are unreliable", () => {
    const markup = lineFor("upheld");
    expect(markup).toContain("was upheld");
    expect(markup).toContain("as unreliable");
    expect(markup).toContain("text-failed");
  });

  it("says a rejected challenge happened, without leaving a shadow over the record", () => {
    const markup = lineFor("rejected");
    expect(markup).toContain("raised against this passport and rejected");
    expect(markup).not.toContain("text-failed");
  });

  it("prints nothing when the service could not find out, and nothing when it never said", () => {
    expect(render(createElement(DisputeLine, { dispute: { source: "unavailable" } }))).toBe("");
    expect(render(createElement(DisputeLine, { dispute: undefined }))).toBe("");
    expect(disputeIn(undefined).kind === "miss" ? null : disputeIn(undefined).dispute).toBeUndefined();
  });

  it("refuses a status the registry's enum has no room for", () => {
    const half = { id: ID, phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 };
    const parsed = verifyResponseSchema.safeParse({
      result: {
        exact: ID,
        best: { ...half, dispute: { source: "chain", status: "maybe" } },
        matches: [half],
        confidence: 1,
        queried,
      },
      manifest: { present: true },
    });

    expect(parsed.success).toBe(false);
  });

  it("stands between the holder's statement and the second opinion on the card", () => {
    const answer: Answer = {
      kind: "exact",
      id: ID,
      confidence: 1,
      phashDistance: 0,
      blockhashDistance: 0,
      variant: "identity",
      others: 0,
      manifest: true,
      consent: { source: "chain", stated: false },
      dispute: { source: "chain", status: "open" },
      recheck: MATCHED,
      queried,
    };

    const markup = render(createElement(AnswerCard, { stage: { kind: "answer", answer, passport: null } }));
    expect(markup.indexOf("data-consent-stamp")).toBeLessThan(markup.indexOf("data-dispute-line"));
    expect(markup.indexOf("data-dispute-line")).toBeLessThan(markup.indexOf("data-second-opinion"));
  });

  it("points the second opinion link at the re-check block on the passport page", () => {
    const markup = render(createElement(SecondOpinion, { recheck: MATCHED, id: ID }));
    expect(markup).toContain(`/passport/${ID}#second-opinion`);
  });
});
