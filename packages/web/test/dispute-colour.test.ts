import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createFormatter, createTranslator } from "next-intl";
import { parseEther, type Hex } from "viem";
import en from "@/messages/en.json";
import { initialFlagState, type FlagState } from "@/lib/disputes/flag";
import type { FlagPassport } from "@/lib/disputes/useFlagPassport";

/**
 * Red on this site means something failed. A challenge is not a failure: it is
 * somebody putting money behind a claim, so every part of one wears the dispute
 * colour, and only the lines that report a real failure inside the challenge
 * panel keep the red.
 */

// The hook is where Privy lives, and Privy only runs in a browser.
const flagStub = vi.hoisted(() => ({ current: null as unknown as FlagPassport }));
vi.mock("@/lib/disputes/useFlagPassport", () => ({ useFlagPassport: () => flagStub.current }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () =>
    createFormatter({
      locale: "en",
      timeZone: "Asia/Kolkata",
      formats: { dateTime: { moment: { dateStyle: "medium", timeStyle: "short" } } },
    }),
}));

// The challenger's words come from the index and are checked against the hash on
// the record. Both are answered here so the quoted claim, which has its own rule,
// is drawn too.
vi.mock("@/lib/disputes/indexed", () => ({
  indexAvailable: () => true,
  indexedDispute: async () => ({ evidenceURI: "data:text/plain,claim" }),
}));
// The holder's answer and the chain's clock would be read over the network.
vi.mock("@/lib/disputes/answerService", () => ({ readAnswer: async () => ({ kind: "none" }) }));
vi.mock("@/lib/chain/time", () => ({ headTimestamp: async () => 1_788_965_000n }));
vi.mock("@/lib/disputes/evidence", async (load) => ({
  ...(await load<object>()),
  evidenceMatches: () => true,
  reasonFrom: () => "The same file is on a stock library from 2019.",
}));

const { Challenge, KeptReceipt } = await import("@/components/passport/Challenge");
const { DisputeNote } = await import("@/components/passport/DisputeNote");
const { Lineage } = await import("@/components/passport/Lineage");

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const PARENT = `0x${"7e".repeat(32)}` as Hex;
const OWNER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const STRANGER = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const BOND = parseEther("1");
const NOOP = () => undefined;
const ASYNC_NOOP = async () => undefined;

/** Any failed-colour utility, in any of its forms: text, fill, edge, underline, hover or focus, with or without an opacity. */
const RED = /(?:^|[\s:])(?:text|bg|border|decoration)-failed(?:\/\d+)?(?=\s|$)/;

function flag(balance: bigint, state: Partial<FlagState> = {}): FlagPassport {
  const enough = balance >= BOND;
  return {
    ready: true,
    authenticated: true,
    isOwner: false,
    wallet: STRANGER,
    reading: false,
    bond: BOND,
    balance,
    check: { enough, shortfall: enough ? 0n : BOND - balance },
    state: { ...initialFlagState, open: true, reason: "The same file is on a stock library from 2019.", ...state },
    actions: {
      open: NOOP,
      close: NOOP,
      setReason: NOOP,
      submit: ASYNC_NOOP,
      recheck: ASYNC_NOOP,
      signIn: NOOP,
      reset: NOOP,
    },
  } as FlagPassport;
}

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

function panel(stub: FlagPassport): string {
  flagStub.current = stub;
  return render(createElement(Challenge, { passportId: PASSPORT, owner: OWNER, disputeOpen: false }));
}

/** Every class attribute in the markup, one string each. */
function classes(markup: string): string[] {
  return [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1] ?? "");
}

/** The class attribute of the first element that carries this attribute. */
function classOf(markup: string, attribute: string): string {
  const at = markup.indexOf(attribute);
  expect(at).toBeGreaterThan(-1);
  const opens = markup.lastIndexOf("<", at);
  const tag = markup.slice(opens, markup.indexOf(">", at) + 1);
  return /class="([^"]*)"/.exec(tag)?.[1] ?? "";
}

describe("the challenge panel", () => {
  const markup = panel(flag(parseEther("3")));

  it("frames the form in the dispute colour at the same weight the red had", () => {
    expect(markup).toContain("border-s-2 border-disputed bg-disputed/5");
    expect(markup).toContain("rotate-45 bg-disputed");
    expect(markup).toContain("hover:text-disputed");
    expect(markup).toContain("group-hover:decoration-disputed");
    expect(markup).toContain("focus:border-disputed");
  });

  it("fills the flag button with the dispute colour and a ground-coloured label", () => {
    const at = markup.indexOf(">Flag with 1 MON<");
    expect(at).toBeGreaterThan(-1);
    const button = markup.slice(markup.lastIndexOf("<button", at), at);
    const words = (/class="([^"]*)"/.exec(button)?.[1] ?? "").split(/\s+/);
    expect(words).toContain("bg-disputed");
    expect(words).toContain("text-bg");
    expect(words).not.toContain("bg-failed");
  });

  it("carries no red while nothing has gone wrong", () => {
    expect(classes(markup).filter((value) => RED.test(value))).toEqual([]);
  });

  it("keeps the red and the warning mark on a bond the account cannot cover", () => {
    const short = panel(
      flag(parseEther("0.4"), {
        steps: { account: "failed", send: "waiting" },
        failure: { key: "notEnough", shortfall: parseEther("0.6") },
      }),
    );
    const line = classOf(short, 'role="alert"');
    expect(line).toContain("border-failed bg-failed/10");
    expect(short).toContain("0.6 MON short of the bond");
    const alert = short.slice(short.indexOf('role="alert"'));
    expect(alert).toMatch(/<svg[^>]*>/);
    expect(alert).toMatch(/class="[^"]*text-failed/);
    // The frame around the failure is still the dispute's, not the failure's.
    expect(short).toContain("border-s-2 border-disputed bg-disputed/5");
  });
});

describe("the kept receipt", () => {
  const markup = render(createElement(KeptReceipt, { receipt: { hash: `0x${"cd".repeat(32)}`, block: 51_234_567n } }));

  it("stands in the dispute frame and its transaction link lights in the dispute colour", () => {
    expect(markup).toContain("border-s-2 border-disputed bg-disputed/5");
    expect(markup).toContain("hover:border-disputed hover:text-disputed");
    expect(classes(markup).filter((value) => RED.test(value))).toEqual([]);
  });
});

describe("the dispute note", () => {
  it("draws an open challenge in the dispute colour, with no red anywhere", async () => {
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
      locale: string;
      messages: unknown;
      timeZone: string;
      children?: unknown;
    }>;
    const note = await DisputeNote({
      dispute: { challenger: STRANGER, bond: BOND, evidenceHash: `0x${"ab".repeat(32)}`, status: 1, openedAt: 1_788_961_533n },
      passportId: PASSPORT,
      locale: "en",
    });
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { locale: "en", messages: en, timeZone: "Asia/Kolkata", formats: { dateTime: { moment: { dateStyle: "medium", timeStyle: "short" } } } } as never,
        note,
      ),
    );
    expect(markup).toContain("border-s-2 border-disputed bg-disputed/5");
    expect(markup).toContain("text-disputed");
    expect(markup).toContain("border-disputed/60");
    expect(markup).toContain("bg-disputed");
    expect(classes(markup).filter((value) => RED.test(value))).toEqual([]);
  });
});

describe("a disputed parent on the lineage", () => {
  it("marks the line up and its chip in the dispute colour", async () => {
    const markup = renderToStaticMarkup(await Lineage({ parentId: PARENT, edits: [], parentDisputed: true }));
    expect(markup).toContain("border-disputed/50");
    expect(markup).toContain("border-disputed/60");
    expect(markup).toContain("text-disputed");
    expect(classes(markup).filter((value) => RED.test(value))).toEqual([]);
  });
});
