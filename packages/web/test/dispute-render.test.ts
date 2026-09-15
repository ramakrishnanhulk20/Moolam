import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { parseEther, type Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { initialFlagState, type FlagState } from "@/lib/disputes/flag";
import type { FlagPassport } from "@/lib/disputes/useFlagPassport";
import type { ResolveDisputes } from "@/lib/disputes/useResolveDisputes";
import type { OpenDispute } from "@/lib/disputes/queue";

// Both hooks are where Privy lives, and Privy only runs in a browser. The screens are
// what this file tests, so each case sets the hook's answer for itself.
const flagStub = vi.hoisted(() => ({ current: null as unknown as FlagPassport }));
const deskStub = vi.hoisted(() => ({ current: null as unknown as ResolveDisputes }));

vi.mock("@/lib/disputes/useFlagPassport", () => ({ useFlagPassport: () => flagStub.current }));
vi.mock("@/lib/disputes/useResolveDisputes", () => ({ useResolveDisputes: () => deskStub.current }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

const { DisputePanel } = await import("@/components/passport/DisputePanel");
const { ResolveConsole } = await import("@/components/resolve/ResolveConsole");

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const OWNER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const STRANGER = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const RESOLVER = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const BOND = parseEther("1");

const NOOP = () => undefined;
const ASYNC_NOOP = async () => undefined;

function flag(over: Partial<FlagPassport> = {}, state: Partial<FlagState> = {}): FlagPassport {
  const balance = over.balance === undefined ? parseEther("3") : over.balance;
  const bond = over.bond === undefined ? BOND : over.bond;
  return {
    ready: true,
    authenticated: true,
    isOwner: false,
    wallet: STRANGER,
    reading: false,
    ...over,
    bond,
    balance,
    check: balance === null || bond === null ? null : { enough: balance >= bond, shortfall: balance >= bond ? 0n : bond - balance },
    state: { ...initialFlagState, open: true, ...state },
    actions: {
      open: NOOP,
      close: NOOP,
      setReason: NOOP,
      submit: ASYNC_NOOP,
      recheck: ASYNC_NOOP,
      signIn: NOOP,
      reset: NOOP,
    },
  };
}

function desk(over: Partial<ResolveDisputes> = {}): ResolveDisputes {
  return {
    ready: true,
    authenticated: true,
    wallet: RESOLVER,
    isResolver: true,
    credit: 0n,
    busy: null,
    confirming: false,
    settled: {},
    failure: null,
    withdrawing: false,
    withdrawn: false,
    ...over,
    actions: { settle: ASYNC_NOOP, withdraw: ASYNC_NOOP, recheck: ASYNC_NOOP, signIn: NOOP },
  };
}

function row(over: Partial<OpenDispute> = {}): OpenDispute {
  return {
    passportId: PASSPORT,
    challenger: STRANGER,
    bond: BOND.toString(),
    openedAt: 1_788_961_533,
    reason: "The same file is on a stock library from 2019, under a different name.",
    evidenceURI: "data:text/plain;charset=utf-8,anything",
    verified: true,
    title: "A registered picture",
    thumbnailUrl: "https://gateway.pinata.cloud/ipfs/bafkreithumb",
    ...over,
  };
}

function render(locale: "en" | "ta", node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

/** The opening tag of the button whose label is this, so its disabled flag can be read. */
function buttonFor(markup: string, label: string): string {
  const at = markup.indexOf(`>${label}<`);
  expect(at).toBeGreaterThan(-1);
  const opens = markup.lastIndexOf("<button", at);
  return markup.slice(opens, at + 1);
}

function panel(value: FlagPassport, locale: "en" | "ta" = "en", disputeOpen = false): string {
  flagStub.current = value;
  return render(locale, createElement(DisputePanel, { passportId: PASSPORT, owner: OWNER, disputeOpen }));
}

function console_(value: ResolveDisputes, disputes: OpenDispute[], locale: "en" | "ta" = "en"): string {
  deskStub.current = value;
  return render(locale, createElement(ResolveConsole, { resolver: RESOLVER, disputes }));
}

describe("who the dispute panel draws itself for", () => {
  it("says nothing to a signed out visitor or before Privy has answered", () => {
    expect(panel(flag({ authenticated: false }))).toBe("");
    expect(panel(flag({ ready: false }))).toBe("");
  });

  it("says nothing to the wallet that holds the passport", () => {
    expect(panel(flag({ isOwner: true }))).toBe("");
  });

  it("says nothing while a challenge is already open, because the registry refuses a second one", () => {
    expect(panel(flag(), "en", true)).toBe("");
  });

  it("is one closed line for everybody else", () => {
    const markup = panel(flag({}, { open: false }));
    expect(markup).toContain("Dispute this passport");
    expect(markup).not.toContain("What is wrong with this record");
  });
});

describe("what the opened panel says before anything is sent", () => {
  it("names the bond, the balance and who pays the network fee", () => {
    const markup = panel(flag());
    expect(markup).toContain("a bond of 1 MON");
    expect(markup).toContain("3 MON");
    expect(markup).toContain("It cannot pay the bond");
    expect(markup).toContain("Flag with 1 MON");
  });

  it("says it is reading while the two numbers are still unknown", () => {
    const markup = panel(flag({ bond: null, balance: null }));
    expect(markup).toContain("Reading");
    expect(markup).toContain("Flag this passport");
  });

  it("names both steps before either has run", () => {
    const markup = panel(flag());
    expect(markup).toContain("Your account puts up the bond");
    expect(markup).toContain("Monad records the challenge");
  });

  it("says all of it in Tamil too", () => {
    const markup = panel(flag(), "ta");
    expect(markup).toContain("இந்தப் பதிவில் என்ன தவறு");
    expect(markup).toContain("1 MON");
  });
});

describe("every failure the panel can print", () => {
  const cases: [string, string][] = [
    ["reasonShort", "at least 20 characters"],
    ["reasonLong", "over 500 characters"],
    ["alreadyOpen", "one open dispute at a time"],
    ["alreadyDisputed", "already marked disputed"],
    ["notFound", "no passport with this id"],
    ["paused", "are paused on the registry"],
    ["declined", "Nothing was sent and nothing was spent"],
  ];

  for (const [key, sentence] of cases) {
    it(`says ${key} in words a reader can act on`, () => {
      expect(panel(flag({}, { failure: { key } }))).toContain(sentence);
    });
  }

  it("names the exact shortfall when the account cannot cover the bond", () => {
    const markup = panel(
      flag({ balance: parseEther("0.25") }, { failure: { key: "notEnough", shortfall: parseEther("0.75") } }),
    );
    expect(markup).toContain("0.75 MON short of the bond");
  });

  it("never offers to send again when the wait ran out", () => {
    const markup = panel(flag({}, { failure: { key: "confirmPending", next: "recheck" } }));
    expect(markup).toContain("it must not be sent again");
    expect(markup).toContain("Ask Monad again");
    expect(markup).toContain('data-tone="pending"');
  });
});

describe("the receipt once the challenge is on chain", () => {
  it("names the block and says where the bond is", () => {
    const markup = panel(
      flag({}, { steps: { account: "done", send: "done" }, block: 41273109n, hash: `0x${"2c".repeat(32)}` }),
    );
    expect(markup).toContain("The challenge is on the record");
    expect(markup).toContain("41273109");
    expect(markup).toContain("Held by the registry itself");
    expect(markup).toContain("Transaction");
  });
});

describe("who the resolver console lets act", () => {
  it("tells a stranger whose page this is, and offers no buttons", () => {
    const markup = console_(desk({ isResolver: false, wallet: STRANGER }), [row()]);
    expect(markup).toContain("This page is for the resolver named by the policy");
    expect(markup).toContain("0x85a8");
    expect(markup).not.toContain(">Uphold<");
  });

  it("offers sign in to a visitor who is signed out", () => {
    const markup = console_(desk({ isResolver: false, authenticated: false, wallet: undefined }), [row()]);
    expect(markup).toContain("Sign in with the resolver&#x27;s account");
    expect(markup).not.toContain(">Uphold<");
  });

  it("gives the resolver both buttons and says what each one does", () => {
    const markup = console_(desk(), [row()]);
    expect(markup).toContain("You are the resolver");
    expect(markup).toContain(">Uphold<");
    expect(markup).toContain(">Reject<");
    expect(markup).toContain("credits the bond back to the challenger");
  });

  it("shows the picture, the claim, the bond and the passport it is against", () => {
    const markup = console_(desk(), [row()]);
    expect(markup).toContain("bafkreithumb");
    expect(markup).toContain("The same file is on a stock library");
    expect(markup).toContain("1 MON");
    expect(markup).toContain(`/passport/${PASSPORT}`);
  });

  it("refuses to print a claim the registry's own hash does not back", () => {
    const markup = console_(desk(), [row({ reason: null, evidenceURI: null, verified: false })]);
    expect(markup).toContain("disagree on the evidence");
    expect(markup).not.toContain("The same file is on a stock library");
  });

  it("says so plainly when nothing is waiting", () => {
    expect(console_(desk(), [])).toContain("No challenge is open");
  });

  it("offers the withdraw button only when the registry owes this account something", () => {
    expect(console_(desk({ credit: 0n }), [])).not.toContain("Withdraw");
    expect(console_(desk({ credit: BOND }), [])).toContain("Withdraw 1 MON");
  });

  it("marks a dispute settled this session without a reload", () => {
    const markup = console_(desk({ settled: { [PASSPORT.toLowerCase()]: "upheld" } }), [row()]);
    expect(markup).toContain("Upheld. The bond is credited back to the challenger");
    expect(markup).not.toContain(">Uphold<");
  });

  it("prints a refused settle in the resolver's own words", () => {
    const markup = console_(desk({ failure: { key: "notResolver", reason: "NotResolver" } }), [row()]);
    expect(markup).toContain("is not the resolver the policy names");
    expect(markup).toContain("NotResolver");
  });

  it("says all of it in Tamil too", () => {
    const markup = console_(desk(), [row()], "ta");
    expect(markup).toContain("நீங்கள்தான் தீர்ப்பாளர்");
    expect(markup).toContain("ஏற்றுக்கொள்");
  });
});

describe("a flag that is out and has not been shown", () => {
  const REASON = "The same file is on a stock library from 2019, under a different name.";
  const SENT = `0x${"3f".repeat(32)}` as Hex;
  const out: Partial<FlagState> = {
    reason: REASON,
    hash: SENT,
    steps: { account: "done", send: "unconfirmed" },
    failure: { key: "confirmPending", next: "recheck", address: STRANGER },
  };

  it("leaves the flag button locked, with a recheck as the only thing to press", () => {
    const markup = panel(flag({}, out));

    expect(buttonFor(markup, "Flag with 1 MON")).toContain('disabled=""');
    expect(markup).toContain("it must not be sent again");
    expect(markup).toContain("Ask Monad again");
    expect(markup).toContain('data-tone="pending"');
  });

  it("is the unconfirmed state doing it, and not the typed reason", () => {
    const ready = panel(flag({}, { reason: REASON }));
    expect(buttonFor(ready, "Flag with 1 MON")).not.toContain('disabled=""');
  });

  it("marks the send step as neither done nor failed", () => {
    const markup = panel(flag({}, out));
    expect(markup).toContain('data-step="send" data-tone="unconfirmed"');
    expect(markup).toContain("Monad has not shown it");
  });

  it("offers the account to look in, and no receipt for a hash nobody has confirmed", () => {
    const markup = panel(flag({}, out));
    expect(markup).toContain(`/address/${STRANGER}`);
    expect(markup).not.toContain(`/tx/${SENT}`);
  });
});

describe("a settle that is out and has not been shown", () => {
  const pending = { key: "confirmPending", next: "recheck" as const, address: RESOLVER };

  it("leaves both settle buttons locked and offers another look", () => {
    const markup = console_(desk({ failure: pending }), [row()]);

    expect(buttonFor(markup, "Uphold")).toContain('disabled=""');
    expect(buttonFor(markup, "Reject")).toContain('disabled=""');
    expect(markup).toContain("Ask Monad again");
    expect(markup).toContain('data-tone="pending"');
    expect(markup).toContain(`/address/${RESOLVER}`);
  });

  it("locks the other rows too, because one unconfirmed write locks the desk", () => {
    const other = row({ passportId: `0x${"6d".repeat(32)}` as Hex });
    const markup = console_(desk({ failure: pending }), [row(), other]);

    expect(markup.match(/disabled=""/g)?.length).toBe(4);
  });

  it("locks the withdraw button behind the same unconfirmed write", () => {
    const markup = console_(desk({ failure: pending, credit: BOND }), [row()]);
    expect(buttonFor(markup, "Withdraw 1 MON")).toContain('disabled=""');
  });

  it("leaves both buttons live when nothing is out", () => {
    const markup = console_(desk(), [row()]);
    expect(buttonFor(markup, "Uphold")).not.toContain('disabled=""');
    expect(markup).not.toContain("Ask Monad again");
  });
});
