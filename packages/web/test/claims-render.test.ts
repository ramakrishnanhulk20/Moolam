import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { readClaims, type ClaimsAnswer } from "@/lib/claims/client";
import { sessionEmails } from "@/lib/claims/offers";
import type { PendingGroup } from "@/lib/claims/usePendingConfirm";

/**
 * "Waiting for you" on My pictures (WO-264), drawn on the server from fixture
 * answers with the session stood in for: the address named is the person's
 * own from their session and never one an answer carries, an offer with no
 * preview still shows its passport id, the platform's check is worded as the
 * platform's claim, the section is absent when there is nothing in it, and the
 * confirm card shows the exact pictures and terms it would write.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

const { ClaimsView } = await import("@/components/claims/ClaimsView");
const { ConfirmCard } = await import("@/components/claims/ConfirmCard");

const NOOP = () => undefined;
const KEY_A = `0x${"a1".repeat(32)}` as Hex;
const KEY_B = `0x${"b2".repeat(32)}` as Hex;
const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const MINE = "ram@example.com";
const EVIL = "someone.else@example.org";
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

const TERMS = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "allowed",
  dataMining: "notAllowed",
  constraintInfo: "",
} as const;

function passport(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

const EMPTY: ClaimsAnswer = { offers: [], waiting: [], standing: [], muted: [] };

const ANSWER: ClaimsAnswer = {
  ...EMPTY,
  offers: [
    {
      ticketId: "1".padStart(32, "0"),
      passportId: passport(1),
      platform: { name: "Dreamloom", keyHash: KEY_A },
      verifiedBy: "google",
      preview: { title: "Lighthouse in a storm", image: `ipfs://${CID}` },
      createdAt: 1_790_000_000,
    },
    {
      ticketId: "2".padStart(32, "0"),
      passportId: passport(2),
      platform: { name: "Dreamloom", keyHash: KEY_A },
      verifiedBy: "google",
      preview: null,
      createdAt: 1_789_999_000,
    },
    {
      ticketId: "3".padStart(32, "0"),
      passportId: passport(3),
      platform: { name: "Inkwell", keyHash: KEY_B },
      verifiedBy: "email-code",
      preview: { title: "Not on our gateway", image: "https://evil.example/picture.png" },
      createdAt: 1_789_998_000,
    },
  ],
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

function view(answer: ClaimsAnswer, extra: Partial<Parameters<typeof ClaimsView>[0]> = {}): string {
  return render(
    createElement(ClaimsView, {
      answer,
      emails: [MINE],
      busy: {},
      failures: {},
      refusal: null,
      watching: false,
      pending: { status: "idle", groups: [] },
      confirmedNow: [],
      renderConfirm: () => null,
      onMine: NOOP,
      onNotMine: NOOP,
      onStop: NOOP,
      onUnmute: NOOP,
      onReload: NOOP,
      onReread: NOOP,
      onSignIn: NOOP,
      ...extra,
    }),
  );
}

describe("Waiting for you", () => {
  it("names the signed-in person's own address from their session, never one the answer carries", async () => {
    // The service never sends an address; one that tried would be dropped by the client before the view.
    const fetcher = async () =>
      new Response(JSON.stringify({ ...ANSWER, email: EVIL, offers: ANSWER.offers.map((one) => ({ ...one, email: EVIL })) }), { status: 200 });
    const read = await readClaims("token", fetcher);
    if (!read.ok) throw new Error("the fixture answer did not parse");

    const emails = sessionEmails({ email: { address: MINE }, google: { email: "RAM@example.com" } });
    expect(emails).toEqual([MINE]);
    const markup = view(read.value, { emails });
    expect(markup).toContain(`Dreamloom is holding 2 pictures for ${MINE}`);
    expect(markup).toContain(`Inkwell is holding 1 picture for ${MINE}`);
    expect(markup).not.toContain(EVIL);

    // The section is handed the session's addresses and nothing else names one.
    const source = readFileSync(fileURLToPath(new URL("../components/claims/ClaimsSection.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/emails=\{sessionEmails\(user as SignedInUser \| null\)\}/);
  });

  it("names two verified addresses as either one, and none as 'your email'", () => {
    const both = sessionEmails({ email: { address: MINE }, google: { email: "ram.k@gmail.com" } });
    expect(view(ANSWER, { emails: both })).toContain(`Dreamloom is holding 2 pictures for ${MINE} or ram.k@gmail.com`);
    expect(view(ANSWER, { emails: [] })).toContain("Dreamloom is holding 2 pictures for your email");
  });

  it("shows 'no preview' with the passport id when the service sent none, or a picture off the pinned rule", () => {
    const markup = view(ANSWER);
    const cards = markup.split("data-claims-offer=").slice(1);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain("Lighthouse in a storm");
    expect(cards[0]).toContain(`https://gateway.pinata.cloud/ipfs/${CID}`);
    expect(cards[1]).toContain(en.claims.noPreview);
    expect(cards[1]).toContain("0x00000000…000002");
    expect(cards[2]).toContain(en.claims.noPreview);
    expect(cards[2]).not.toContain("evil.example");
    expect(cards[2]).toContain("0x00000000…000003");
  });

  it("words how the address was checked as the platform's claim, beside the platform's name", () => {
    const markup = view(ANSWER);
    expect(markup).toContain("Dreamloom says it checked this address with a Google sign-in.");
    expect(markup).toContain("Inkwell says it checked this address with a code sent to it.");
    const own = view({ ...ANSWER, offers: [{ ...ANSWER.offers[0], verifiedBy: "platform" }] });
    expect(own).toContain("Dreamloom says it checked this address in its own way.");
  });

  it("offers the AI-use choice, the send-future tick and both answers on each platform's card", () => {
    const markup = view(ANSWER);
    const card = markup.split(`data-claims-platform="${KEY_A}"`)[1].split("data-claims-platform=")[0];
    expect(card).toContain(en.passport.consent.control.choices.closed.title);
    expect(card).toContain("Send my future Dreamloom pictures straight to my account");
    expect(card).toContain(en.claims.mine);
    expect(card).toContain(en.claims.notMine);
  });

  it("draws nothing at all when nothing waits and nothing is set", () => {
    expect(view(EMPTY)).toBe("");
  });

  it("says where accepted pictures stand, and when a platform could not hand them over", () => {
    const waiting = (state: "accepted" | "failed", n: number) => ({
      ticketId: String(n).padStart(32, "0"),
      passportId: passport(n),
      platform: { name: "Dreamloom", keyHash: KEY_A },
      state,
      destination: WALLET,
      terms: TERMS,
    });
    const markup = view({ ...EMPTY, waiting: [waiting("accepted", 1), waiting("accepted", 2), waiting("failed", 3)] }, { watching: true });
    expect(markup).toContain("Waiting for Dreamloom to hand them over");
    expect(markup).toContain("2 pictures");
    expect(markup).toContain("Dreamloom could not hand this picture over. Ask Dreamloom to send it again.");
  });

  it("keeps the standing choices with their actions, alone when nothing else waits", () => {
    const markup = view({
      ...EMPTY,
      standing: [{ platform: { name: "Dreamloom", keyHash: KEY_A }, destination: WALLET }],
      muted: [{ platform: { name: "Inkwell", keyHash: KEY_B } }],
    });
    expect(markup).toContain('data-claims="settings"');
    expect(markup).not.toContain(en.claims.heading);
    expect(markup).toContain("Future Dreamloom pictures go straight to you");
    expect(markup).toContain(">Stop<");
    expect(markup).toContain("You said no to Inkwell");
    expect(markup).toContain(">Allow again<");
  });

  it("hands each delivered group to the confirm card", () => {
    const group: PendingGroup = { key: "k", terms: TERMS, entries: [], ids: [passport(9)] };
    const markup = view(EMPTY, { pending: { status: "ready", groups: [group] }, renderConfirm: () => createElement("p", null, "CONFIRM-SLOT") });
    expect(markup).toContain(en.claims.heading);
    expect(markup).toContain("CONFIRM-SLOT");
  });
});

describe("the confirm card", () => {
  const rows = [
    { passportId: passport(1), platform: "Dreamloom", art: { title: "Lighthouse", imageUrl: "https://gateway.pinata.cloud/ipfs/x" } },
    { passportId: passport(2), platform: "Dreamloom", art: {} },
  ];

  function card(step: Parameters<typeof ConfirmCard>[0]["step"], extra: Partial<Parameters<typeof ConfirmCard>[0]> = {}) {
    return render(
      createElement(ConfirmCard, {
        rows,
        terms: TERMS,
        step,
        failure: null,
        onConfirm: NOOP,
        onRecheck: NOOP,
        onReread: NOOP,
        ...extra,
      }),
    );
  }

  it("shows the exact pictures, their ids and the terms before the one press", () => {
    const markup = card("ready");
    expect(markup).toContain(en.claims.confirm.heading);
    expect(markup).toContain("0x00000000…000001");
    expect(markup).toContain("0x00000000…000002");
    expect(markup).toContain("Lighthouse");
    expect(markup).toContain(en.passport.consent.state.allowed);
    expect(markup).toContain("Confirm all 2");
  });

  it("says confirmed with the receipt link only in the done state", () => {
    const hash = `0x${"77".repeat(32)}` as Hex;
    expect(card("ready")).not.toContain(en.claims.confirm.done);
    expect(card("confirming")).not.toContain(en.claims.confirm.done);
    expect(card("confirming")).toContain(en.claims.confirm.confirming);
    const done = card("done", { txHash: hash });
    expect(done).toContain(en.claims.confirm.done);
    expect(done).toContain(`/tx/${hash}`);
  });

  it("says a refused or failed send in words, with a way to try again or to look again", () => {
    const declined = card("failed", { failure: { key: "declined", next: "again" } });
    expect(declined).toContain(en.passport.consent.failure.declined);
    expect(declined).toContain(en.claims.confirm.again);
    const pending = card("failed", { failure: { key: "confirmPending", next: "recheck" } });
    expect(pending).toContain(en.passport.consent.failure.confirmPending);
    expect(pending).toContain(en.claims.confirm.recheck);
    expect(card("changed")).toContain(en.claims.confirm.changed);
  });
});

describe("where the section sits", () => {
  it("is handed to My pictures above the person's own grid, loaded only once they are signed in", () => {
    const own = readFileSync(fileURLToPath(new URL("../components/mine/OwnPictures.tsx", import.meta.url)), "utf8");
    expect(own.indexOf("{waiting}")).toBeGreaterThan(-1);
    expect(own.indexOf("{waiting}")).toBeLessThan(own.indexOf("<YourPassports"));
    const pictures = readFileSync(fileURLToPath(new URL("../components/mine/MinePictures.tsx", import.meta.url)), "utf8");
    expect(pictures).toMatch(/dynamic\(\(\) => import\("@\/components\/claims\/ClaimsSection"\)/);
    expect(pictures).toContain("waiting={<ClaimsSection wallet={wallet} />}");
  });
});
