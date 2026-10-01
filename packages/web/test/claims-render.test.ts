// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { readClaims, type ClaimsAnswer } from "@/lib/claims/client";
import { sessionEmails } from "@/lib/claims/offers";
import { unreadLine } from "@/lib/claims/refusal";
import { failureKey } from "@/lib/claims/useClaims";
import type { PendingGroup } from "@/lib/claims/usePendingConfirm";
import { consentForChoice } from "@/components/consent/draft";

/**
 * "Waiting for you" on My pictures (WO-264), drawn on the server from fixture
 * answers with the session stood in for: the address named is the person's
 * own from their session and never one an answer carries, an offer with no
 * preview still shows its passport id, the platform's check is worded as the
 * platform's claim, the section is absent when there is nothing in it, and the
 * confirm card shows the exact pictures and terms it would write.
 *
 * WO-268 adds the section mounted live with Privy stood in for and fetch
 * stubbed (the verify service's default address is this machine's own port,
 * which the network guard lets through, so nothing here may go unstubbed): a
 * list that could not be read leaves one quiet line whose button reads again,
 * a service with its claim routes closed leaves nothing, and a refusal shows
 * only under the control that was pressed.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The session stood in for: the token Privy hands over (null when the sign-in ran out) and its sign-in prompt. */
const privy = vi.hoisted(() => {
  const session = { token: "privy-token" as string | null, login: vi.fn() };
  return { session, getAccessToken: async () => session.token };
});

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ getAccessToken: privy.getAccessToken, user: { email: { address: "ram@example.com" } }, login: privy.session.login }),
  useWallets: () => ({ wallets: [] }),
  useSendTransaction: () => ({ sendTransaction: async () => ({ hash: "0x" }) }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

const { ClaimsView } = await import("@/components/claims/ClaimsView");
const { ConfirmCard } = await import("@/components/claims/ConfirmCard");
const { ClaimsSection } = await import("@/components/claims/ClaimsSection");
const { ConsentChoice } = await import("@/components/consent/ConsentChoice");

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
    const source = readFileSync("components/claims/ClaimsSection.tsx", "utf8");
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
    const own = readFileSync("components/mine/OwnPictures.tsx", "utf8");
    expect(own.indexOf("{waiting}")).toBeGreaterThan(-1);
    expect(own.indexOf("{waiting}")).toBeLessThan(own.indexOf("<YourPassports"));
    const pictures = readFileSync("components/mine/MinePictures.tsx", "utf8");
    expect(pictures).toMatch(/dynamic\(\(\) => import\("@\/components\/claims\/ClaimsSection"\)/);
    expect(pictures).toContain("waiting={<ClaimsSection wallet={wallet} />}");
  });
});

describe("a list that could not be read", () => {
  let root: Root | null = null;
  let host: HTMLElement;

  beforeEach(() => {
    privy.session.token = "privy-token";
    privy.session.login.mockClear();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  /** Answers the verify service's routes in order, one answer per call, and keeps what was asked. */
  function service(...answers: [number, unknown][]) {
    const asked: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        asked.push({ url, method: String(init.method) });
        const [status, body] = answers[Math.min(asked.length - 1, answers.length - 1)];
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }),
    );
    return asked;
  }

  async function settle() {
    for (let turn = 0; turn < 5; turn += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  }

  async function mount() {
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
    await act(async () => {
      root = createRoot(host);
      root.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(ClaimsSection, { wallet: WALLET })));
    });
    await settle();
  }

  async function press(selector: string, within: ParentNode = host) {
    const button = within.querySelector<HTMLButtonElement>(selector);
    if (button === null) throw new Error(`no ${selector} to press`);
    await act(async () => button.click());
  }

  it("draws one quiet line, and Try again reads the list again", async () => {
    const asked = service([500, { error: "Internal Server Error" }], [500, { error: "Internal Server Error" }], [200, EMPTY]);
    await mount();

    expect(asked.map((one) => one.method)).toEqual(["GET"]);
    expect(asked[0].url).toMatch(/\/claims$/);
    const line = host.querySelector('[data-claims="read-failed"]');
    expect(line?.textContent).toContain(en.claims.readFailed);
    expect(line?.querySelector("[data-claims-read-again]")?.textContent).toBe(en.claims.next.again);

    // Still failing: the read was made again and the line stays.
    await press("[data-claims-read-again]");
    await settle();
    expect(asked).toHaveLength(2);
    expect(host.querySelector('[data-claims="read-failed"]')?.textContent).toContain(en.claims.readFailed);

    // Answered now, with nothing waiting: the line goes and nothing takes its place.
    await press("[data-claims-read-again]");
    await settle();
    expect(asked).toHaveLength(3);
    expect(asked.every((one) => one.method === "GET" && one.url.endsWith("/claims"))).toBe(true);
    expect(host.innerHTML).toBe("");
  });

  it("draws the same line for a service that is down without a word of its own", async () => {
    service([503, null]);
    await mount();
    expect(host.querySelector('[data-claims-unread="readFailed"]')?.textContent).toContain(en.claims.readFailed);
  });

  it("draws nothing when the service has its claim routes closed", async () => {
    const asked = service([503, { error: "claims-unavailable" }]);
    await mount();
    expect(asked).toHaveLength(1);
    expect(host.innerHTML).toBe("");
  });

  it("offers the sign-in step, not Try again, when the sign-in ran out", async () => {
    privy.session.token = null;
    const asked = service([200, EMPTY]);
    await mount();
    expect(asked).toHaveLength(0);
    const line = host.querySelector('[data-claims-unread="signIn"]');
    expect(line?.textContent).toContain(en.claims.refusal.signIn);
    expect(line?.textContent).not.toContain(en.claims.readFailed);
    expect(line?.querySelector("[data-claims-read-again]")).toBeNull();
    await press('[data-claims-refusal="signIn"] button');
    expect(privy.session.login).toHaveBeenCalledTimes(1);
  });

  it("offers the sign-in step when the service says the token is no good", async () => {
    service([401, { error: "unauthorized" }]);
    await mount();
    expect(host.querySelector('[data-claims-unread="signIn"]')?.textContent).toContain(en.claims.refusal.signIn);
  });

  it("names its line from the refusal, the closed routes by the service's own word", () => {
    expect(unreadLine({ key: "unavailable", next: "again", word: "claims-unavailable" })).toBe("none");
    expect(unreadLine({ key: "unavailable", next: "again" })).toBe("readFailed");
    expect(unreadLine({ key: "signIn", next: "signIn", word: "unauthorized" })).toBe("signIn");
    for (const key of ["offline", "badResponse", "limit", "globalLimit", "privy"] as const) {
      expect(unreadLine({ key }), key).toBe("readFailed");
    }
  });

  it("shows a refused Stop under the settings row only, and a refused Not mine under the card only", async () => {
    const both: ClaimsAnswer = {
      ...EMPTY,
      offers: [ANSWER.offers[0]],
      standing: [{ platform: { name: "Dreamloom", keyHash: KEY_A }, destination: WALLET }],
    };
    const asked = service([200, both], [404, { error: "not-found" }], [200, both], [409, { error: "not-open" }], [200, both]);
    await mount();
    const card = () => host.querySelector(`[data-claims-platform="${KEY_A}"]`) as HTMLElement;
    const row = () => host.querySelector('[data-claims-setting="standing"]') as HTMLElement;
    expect(card()).not.toBeNull();
    expect(row()).not.toBeNull();

    await press("button", row());
    await settle();
    expect(asked[1].method).toBe("DELETE");
    expect(asked[1].url).toMatch(new RegExp(`/claims/standing/${KEY_A}$`));
    expect(row().querySelector('[data-claims-refusal="notFound"]')).not.toBeNull();
    expect(card().querySelector("[data-claims-refusal]")).toBeNull();

    await press("[data-claims-not-mine]", card());
    await settle();
    expect(asked[3].url).toMatch(/\/claims\/refuse$/);
    expect(card().querySelector('[data-claims-refusal="notOpen"]')).not.toBeNull();
    expect(card().querySelector('[data-claims-refusal="notFound"]')).toBeNull();
    expect(row().querySelector('[data-claims-refusal="notOpen"]')).toBeNull();
    expect(row().querySelector('[data-claims-refusal="notFound"]')).not.toBeNull();
  });

  it("keys the two places apart in the view as well", () => {
    const both: ClaimsAnswer = {
      ...EMPTY,
      offers: [ANSWER.offers[0]],
      standing: [{ platform: { name: "Dreamloom", keyHash: KEY_A }, destination: WALLET }],
    };
    expect(failureKey("offer", KEY_A)).not.toBe(failureKey("setting", KEY_A));
    const split = (markup: string) => {
      const [, after] = markup.split(`data-claims-platform="${KEY_A}"`);
      const [cardPart, settingsPart] = after.split("data-claims-settings");
      return { cardPart, settingsPart };
    };
    const onRow = split(view(both, { failures: { [failureKey("setting", KEY_A)]: { key: "notFound", next: "reload" } } }));
    expect(onRow.settingsPart).toContain('data-claims-refusal="notFound"');
    expect(onRow.cardPart).not.toContain("data-claims-refusal");
    const onCard = split(view(both, { failures: { [failureKey("offer", KEY_A)]: { key: "notOpen", next: "reload" } } }));
    expect(onCard.cardPart).toContain('data-claims-refusal="notOpen"');
    expect(onCard.settingsPart).not.toContain("data-claims-refusal");
  });
});

describe("two AI-use choices on one page", () => {
  it("give each conditions field its own id, and each label points at its own field", () => {
    const asks = { consent: consentForChoice("ask"), constraintInfo: "" };
    const markup = render(
      createElement(
        "div",
        null,
        createElement(ConsentChoice, { draft: asks, onChange: NOOP, size: "compact" }),
        createElement(ConsentChoice, { draft: asks, onChange: NOOP, size: "compact" }),
      ),
    );
    const page = document.createElement("div");
    page.innerHTML = markup;
    const fields = [...page.querySelectorAll("textarea")];
    const labels = [...page.querySelectorAll("label")];
    expect(fields).toHaveLength(2);
    expect(labels).toHaveLength(2);
    expect(fields[0].id).not.toBe("");
    expect(fields[0].id).not.toBe(fields[1].id);
    labels.forEach((label, at) => {
      expect(label.htmlFor).toBe(fields[at].id);
      expect(page.querySelectorAll(`[id="${label.htmlFor}"]`)).toHaveLength(1);
    });
  });
});
