import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { OpenDispute } from "@/lib/disputes/queue";

/**
 * The second half of the loose ends the polish orders left (WO-226, steps 9 to
 * 16): the resolver's rows lead with the picture, a challenge's receipt outlives
 * the refresh, a filtered Explore opens its AI-use row, two small labels reach
 * 11 px, the re-check room holds three phone lines, phone fields stop iOS from
 * zooming, and a refusal's plain sentence leads its answer box.
 *
 * What this does not cover: a real refresh, a real iPhone focus or a real
 * eth_call. Those were checked once each in a browser at 375 px; here the
 * markup is read as the server would send it and the rule is read from the file.
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));

vi.mock("next/image", () => ({
  default: (props: { src: string; alt?: string }) => createElement("img", { src: String(props.src), alt: props.alt ?? "" }),
}));

vi.mock("@/lib/images", () => ({
  pictureSources: (url: string) => [url],
  isOptimizable: () => true,
  nextSource: () => null,
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/disputes/useResolveDisputes", () => ({ useResolveDisputes: () => null }));

const { ResolveConsole } = await import("@/components/resolve/ResolveConsole");
const { KeptReceipt, challengeView, keepChallenge, keptChallenge } = await import("@/components/passport/Challenge");
const { Filters } = await import("@/components/explore/Filters");
const { FailureDetails } = await import("@/components/studio/FailureDetails");
const { Billing } = await import("@/components/home/Billing");
const { AnswerLines } = await import("@/components/docs/BreakIt");
const { ATTACKS } = await import("@/components/docs/breakIt/attacks");
const { shortHex } = await import("@/lib/chain/client");

const WEB = path.resolve(__dirname, "..");
const source = (file: string): string => readFileSync(path.join(WEB, file), "utf8");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

/** The class list of the first tag that carries a marker attribute. */
function classOf(markup: string, marker: string): string {
  const at = markup.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const tag = markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at));
  return /class="([^"]*)"/.exec(tag)?.[1] ?? "";
}

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;

describe("step 9: a dispute row on the resolver's desk", () => {
  const dispute: OpenDispute = {
    passportId: PASSPORT,
    challenger: `0x${"85".repeat(20)}` as Hex,
    bond: "1000000000000000000",
    openedAt: 1788876082,
    evidenceURI: null,
    reason: null,
    verified: false,
    title: "Monsoon fishing nets drying",
    thumbnailUrl: null,
  };

  it("leads with the picture's title and follows it with the id, short and quiet, never the full 66 characters", () => {
    const html = render(createElement(ResolveConsole, { resolver: `0x${"55".repeat(20)}` as Hex, disputes: [dispute] }));
    const head = html.slice(html.indexOf(`href="/passport/${PASSPORT}"`));
    const title = head.indexOf(dispute.title as string);
    const id = head.indexOf(shortHex(PASSPORT));

    expect(title).toBeGreaterThan(-1);
    expect(id).toBeGreaterThan(title);
    // The full id is only ever the link's address, never printed text.
    expect(html.split(PASSPORT)).toHaveLength(2);
    expect(html).toContain(`href="/passport/${PASSPORT}"`);
    expect(head).toMatch(/text-text-faint[^>]*><span>Passport<\/span><span data-hex="true" class="text-sm normal-case/);
  });

  it("still names the passport, short, when the record carries no title", () => {
    const html = render(
      createElement(ResolveConsole, { resolver: `0x${"55".repeat(20)}` as Hex, disputes: [{ ...dispute, title: null }] }),
    );
    expect(html).toContain(shortHex(PASSPORT));
    expect(html.split(PASSPORT)).toHaveLength(2);
  });
});

describe("step 10: the challenge's Recorded receipt", () => {
  const HASH = `0x${"ab".repeat(32)}` as Hex;

  it("is kept for the rest of the visit, whatever case the id is asked in", () => {
    const id = `0x${"7D".repeat(32)}` as Hex;
    expect(keptChallenge(id)).toBeUndefined();
    keepChallenge(id, { hash: HASH, block: 108_977_352n });
    expect(keptChallenge(id.toLowerCase() as Hex)).toEqual({ hash: HASH, block: 108_977_352n });
  });

  it("wins over the open dispute the refresh brings, and over a sign-out", () => {
    const signedIn = { ready: true, authenticated: true, isOwner: false };
    expect(challengeView({ kept: true, disputeOpen: true, ...signedIn })).toBe("receipt");
    expect(challengeView({ kept: true, disputeOpen: true, ready: true, authenticated: false, isOwner: false })).toBe(
      "receipt",
    );
    expect(challengeView({ kept: false, disputeOpen: true, ...signedIn })).toBe("none");
    expect(challengeView({ kept: false, disputeOpen: false, ...signedIn })).toBe("panel");
    expect(challengeView({ kept: false, disputeOpen: false, ...signedIn, isOwner: true })).toBe("none");
    // A reader with no session gets the rules and who decides, with sign-in where the form would be.
    expect(challengeView({ kept: false, disputeOpen: false, ready: true, authenticated: false, isOwner: false })).toBe("rules");
    expect(challengeView({ kept: false, disputeOpen: true, ready: true, authenticated: false, isOwner: false })).toBe("none");
    expect(challengeView({ kept: false, disputeOpen: false, ready: false, authenticated: false, isOwner: false })).toBe("none");
  });

  it("draws the Recorded stamp, the block and the transaction link, with no toggle that could close it", () => {
    const flag = en.passport.dispute.flag;
    const html = render(createElement(KeptReceipt, { receipt: { hash: HASH, block: 108_977_352n } }));
    expect(html).toContain("data-challenge-kept");
    expect(html).toContain(flag.done.label);
    expect(html).toContain("108977352");
    expect(html).toContain(`/tx/${HASH}`);
    // The id keeps its own lower case inside the label in capitals.
    expect(html).toContain(
      flag.done.openTx.replace("{hash}", `<span data-hex="true" class="normal-case">${shortHex(HASH)}</span>`),
    );
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain(`>${flag.close}<`);
  });
});

describe("step 11: Explore's folded AI-use row from md", () => {
  const search = { view: "all" as const, search: "", agent: null, ai: null };

  it("opens by itself when an answer other than Any is narrowing the sheet", () => {
    const html = render(createElement(Filters, { search: { ...search, ai: "open" as const } }));
    const row = classOf(html, "data-ai-row");
    expect(row).not.toContain("md:hidden");
    expect(row).toContain("rise");
    expect(html).toMatch(/data-ai-toggle="true" aria-expanded="true"/);
  });

  it("stays folded on Any", () => {
    const html = render(createElement(Filters, { search }));
    expect(classOf(html, "data-ai-row")).toContain("md:hidden");
    expect(html).toMatch(/data-ai-toggle="true" aria-expanded="false"/);
  });
});

describe("step 12: the Details summary under a failure", () => {
  it("is set in 11 px, never 10", () => {
    const html = render(createElement(FailureDetails, { reason: "HTTP request failed" }));
    const summary = /<summary class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(summary).toContain("text-[11px]");
    expect(summary).not.toContain("text-[10px]");
  });
});

describe("step 13: the sponsor line on the home page", () => {
  it("was already 11 px after the home text pass, so it was left as it is", () => {
    const line = classOf(render(createElement(Billing, {})), "data-first-billing");
    expect(line).toContain("text-[11px]");
    expect(line).not.toContain("text-[10px]");
  });
});

describe("step 14: the room for the re-check sentence on a phone", () => {
  it("holds three 16 px lines at the sentence's relaxed leading", () => {
    const threeLines = (3 * 16 * 1.625) / 16;
    expect(threeLines).toBe(4.875);
    const file = source("components/passport/RecheckRequest.tsx");
    expect(file).toContain(`min-h-[${threeLines}rem] sm:min-h-[3.25rem]`);
    expect(file).not.toContain("min-h-[4.25rem]");
  });
});

describe("step 15: phone fields at 16 px so iOS Safari does not zoom", () => {
  const css = source("styles/globals.css");
  const at = css.indexOf("textarea,\n  select {\n    font-size: 16px;");

  it("sets every typed field to 16 px below sm, and leaves the buttons, boxes, sliders and file pickers alone", () => {
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(css.lastIndexOf("@media", at), css.indexOf("}", at));
    expect(rule.startsWith("@media (max-width: 639px) {")).toBe(true);
    for (const kept of ["checkbox", "radio", "range", "file", "button", "submit"]) {
      expect(rule).toContain(`[type="${kept}"]`);
    }
    expect(rule).toMatch(/input:not\(/);
  });

  it("sits outside every layer, so it beats the text-[12px] utility on the Explore search box", () => {
    const before = css.slice(0, css.lastIndexOf("@media", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    const depth = [...before].reduce((open, char) => open + (char === "{" ? 1 : char === "}" ? -1 : 0), 0);
    expect(depth).toBe(0);
    expect(source("components/explore/Filters.tsx")).toContain("font-mono text-[12px]");
  });
});

describe("step 16: an answer box on the try-to-break-it page", () => {
  const attack = ATTACKS.find((one) => one.id === "edit-by-non-owner");
  const refused = {
    kind: "refused" as const,
    name: "NotParentOwner",
    args: [`0x${"c5".repeat(20)}`],
    decoded: true,
    block: 108_977_352n,
  };
  const sentence = en.passport.edit.failure.notOwner;

  it("puts the plain refusal first and the decoded call with its hex under it", () => {
    expect(attack).toBeDefined();
    const html = render(createElement(AnswerLines, { attack: attack!, row: refused, sentence }));
    const said = html.indexOf(sentence);
    const call = html.indexOf("Refused: NotParentOwner(");
    expect(said).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(said);
    expect(html.indexOf("data-refusal-sentence")).toBeLessThan(html.indexOf("data-refusal-call"));
    expect(html.indexOf("simulated at block")).toBeGreaterThan(call);
  });

  it("keeps the decoded call as the headline when no sentence was written for the error", () => {
    const html = render(createElement(AnswerLines, { attack: attack!, row: refused, sentence: null }));
    expect(html.startsWith('<p class="text-text">Refused: NotParentOwner(')).toBe(true);
    expect(html).not.toContain("data-refusal-sentence");
  });
});
