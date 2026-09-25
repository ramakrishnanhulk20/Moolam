import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { VerifierError } from "@/lib/verifier/client";

/**
 * The holder's delete for Moolam's private copy of a sealed picture.
 *
 * Privy only runs in a browser, so its two hooks are replaced by values each
 * case sets. What is tested is who sees the control, that the delete asks
 * first and says what it cannot undo, that the answer lands where the press
 * was, and that every refusal the route documents has a sentence of its own.
 */

const privy = vi.hoisted(() => ({
  ready: true,
  authenticated: true,
  wallet: "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as string | undefined,
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ready: privy.ready,
    authenticated: privy.authenticated,
    login: () => undefined,
    getAccessToken: async () => "privy-token",
  }),
  useWallets: () => ({
    wallets: privy.wallet === undefined ? [] : [{ walletClientType: "privy", address: privy.wallet }],
  }),
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", () => ({
  default: (load: () => Promise<FunctionComponent<never>>) => {
    let Panel: FunctionComponent<never> | null = null;
    chunks.pending.push(
      load().then((component) => {
        Panel = component;
      }),
    );
    return (props: never) => (Panel === null ? null : createElement(Panel, props));
  },
}));

const { WalletMounted } = await import("@/components/providers/WalletProvider");
const panelModule = await import("@/components/passport/PrivateCopyPanel");
const {
  PrivateCopyPanel,
  PrivateCopyCard,
  describeForgetFailure,
  initialPrivateCopyState,
  privateCopyReducer,
  runForget,
} = panelModule;

await Promise.all(chunks.pending);

const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const HOLDER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const words = en.passport.privateCopy;
const NOOP = () => undefined;
const ACTIONS = { ask: NOOP, keep: NOOP, forget: NOOP, signIn: NOOP };

function render(node: ReactElement, mounted = true): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "Asia/Kolkata" },
      createElement(WalletMounted.Provider, { value: mounted }, node),
    ),
  );
}

function panel(
  privateCopy: "kept" | "gone" | "unknown" | undefined,
  options: { sealed?: boolean; mounted?: boolean } = {},
): string {
  return render(
    createElement(PrivateCopyPanel, { passportId: PASSPORT, owner: HOLDER, sealed: options.sealed ?? true, privateCopy }),
    options.mounted ?? true,
  );
}

function card(state: Parameters<typeof PrivateCopyCard>[0]["state"]): string {
  return render(createElement(PrivateCopyCard, { state, actions: ACTIONS }));
}

/** React escapes an apostrophe in the rendered markup, the message file does not. */
function asRendered(line: string): string {
  return line.replace(/'/g, "&#x27;");
}

afterEach(() => {
  privy.ready = true;
  privy.authenticated = true;
  privy.wallet = HOLDER;
  vi.unstubAllGlobals();
});

describe("who sees the delete", () => {
  it("draws itself for the holder while the copy is kept", () => {
    const markup = panel("kept");

    expect(markup).toContain(asRendered(words.heading));
    expect(markup).toContain(asRendered(words.delete));
  });

  it("says nothing to a signed in stranger", () => {
    privy.wallet = "0x0000000000000000000000000000000000000001";
    expect(panel("kept")).toBe("");
  });

  it("says nothing to a reader who is signed out, or before Privy has answered", () => {
    privy.authenticated = false;
    expect(panel("kept")).toBe("");

    privy.authenticated = true;
    privy.ready = false;
    expect(panel("kept")).toBe("");
  });

  it("says nothing before the wallet provider is mounted", () => {
    expect(panel("kept", { mounted: false })).toBe("");
  });

  it("says nothing to the holder once the copy is gone, or when nobody can tell", () => {
    expect(panel("gone")).toBe("");
    expect(panel("unknown")).toBe("");
  });

  it("says nothing on a passport that never asked for a copy, or is not sealed", () => {
    expect(panel(undefined)).toBe("");
    expect(panel("kept", { sealed: false })).toBe("");
  });
});

describe("the delete asks first", () => {
  it("offers one button and says what the copy is before anything is pressed", () => {
    const markup = card(initialPrivateCopyState);

    expect(markup).toContain(asRendered(words.delete));
    expect(markup).toContain(asRendered(words.body));
    expect(markup).not.toContain(asRendered(words.confirm));
  });

  it("asks in place, saying what cannot be undone, with Delete and Keep it", () => {
    const markup = card(privateCopyReducer(initialPrivateCopyState, { type: "ask" }));

    expect(markup).toContain(words.confirm);
    expect(markup).toContain(`>${words.confirmDelete}<`);
    expect(markup).toContain(`>${words.keep}<`);
    expect(markup).not.toContain(asRendered(words.delete));
  });

  it("goes back to the one button on Keep it", () => {
    const asked = privateCopyReducer(initialPrivateCopyState, { type: "ask" });
    expect(privateCopyReducer(asked, { type: "keep" })).toEqual(initialPrivateCopyState);
  });

  it("names the wait and holds both buttons while the delete is out", () => {
    const markup = card({ step: "sending", failure: null });

    expect(markup).toContain(words.sending);
    expect(markup).toContain('role="status"');
    expect(markup.match(/disabled=""/g)?.length).toBe(2);
  });
});

describe("once the copy is deleted", () => {
  it("says so where the confirmation was, and nothing else is left to press", () => {
    const markup = card({ step: "done", failure: null });

    expect(markup).toContain(words.done);
    expect(markup).not.toContain(`>${words.confirmDelete}<`);
    expect(markup).not.toContain(asRendered(words.delete));
  });

  it("does not go back on a late press", () => {
    const done = { step: "done" as const, failure: null };
    expect(privateCopyReducer(done, { type: "ask" })).toBe(done);
    expect(privateCopyReducer(done, { type: "keep" })).toBe(done);
  });

  it("says deleted before the page is asked to read itself again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ passportId: PASSPORT, deleted: 1 }), { status: 200 })),
    );
    const order: string[] = [];

    await runForget({
      passportId: PASSPORT,
      getAccessToken: async () => "privy-token",
      dispatch: (action) => order.push(action.type),
      onDeleted: () => {
        order.push("refresh");
      },
    });

    expect(order).toEqual(["sending", "done", "refresh"]);
  });

  it("sends nothing without a token and asks the holder to sign in", async () => {
    const stub = vi.fn();
    vi.stubGlobal("fetch", stub);
    const actions: { type: string; failure?: { key: string; next?: string } }[] = [];

    await runForget({ passportId: PASSPORT, getAccessToken: async () => null, dispatch: (action) => actions.push(action) });

    expect(stub).not.toHaveBeenCalled();
    expect(actions.at(-1)).toEqual({ type: "failed", failure: { key: "signedOut", next: "signIn" } });
  });

  it("lands a refusal back on the question, with the reason under it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "not-holder", passportId: PASSPORT }), { status: 403 })),
    );
    let state = privateCopyReducer(initialPrivateCopyState, { type: "ask" });

    await runForget({
      passportId: PASSPORT,
      getAccessToken: async () => "privy-token",
      dispatch: (action) => {
        state = privateCopyReducer(state, action);
      },
    });

    expect(state).toEqual({ step: "confirming", failure: { key: "notHolder" } });
  });
});

describe("every refusal has one sentence", () => {
  const cases: [number, string, string][] = [
    [401, "unauthorized", "signedOut"],
    [403, "not-holder", "notHolder"],
    [404, "no-passport", "noPassport"],
    [404, "nothing-kept", "nothingKept"],
    [502, "privy-unavailable", "dependencyDown"],
    [502, "delete-failed", "deleteFailed"],
    [503, "chain-unavailable", "dependencyDown"],
    [503, "metadata-unavailable", "dependencyDown"],
    [503, "lookup-unavailable", "dependencyDown"],
  ];

  for (const [status, word, key] of cases) {
    it(`${status} ${word}`, () => {
      const failure = describeForgetFailure(new VerifierError("bad-response", status, word, undefined, { serviceCode: word }));
      expect(failure.key).toBe(key);

      const markup = card({ step: "confirming", failure });
      const sentence = (words.failure as Record<string, string>)[key];
      expect(sentence).toBeTypeOf("string");
      expect(markup).toContain(asRendered(sentence));
      expect(markup).toContain('role="alert"');
    });
  }

  it("offers sign in only when the session is the problem", () => {
    const signedOut = card({ step: "confirming", failure: { key: "signedOut", next: "signIn" } });
    const notHolder = card({ step: "confirming", failure: { key: "notHolder" } });

    expect(signedOut).toContain(`>${words.actions.signIn}<`);
    expect(notHolder).not.toContain(`>${words.actions.signIn}<`);
  });

  it("reads a silent network, a rate limit and a strange answer by their family", () => {
    expect(describeForgetFailure(new VerifierError("offline", 0, "the verify service did not answer")).key).toBe("offline");
    expect(describeForgetFailure(new VerifierError("rate-limited", 429, "rate-limited")).key).toBe("rateLimited");
    expect(describeForgetFailure(new VerifierError("bad-response", 200, "shape")).key).toBe("badResponse");
    expect(describeForgetFailure(new Error("boom"))).toEqual({ key: "unknown", reason: "boom" });
  });

  it("keeps the service's own reason under the sentence when it says more than its word", () => {
    const failure = describeForgetFailure(
      new VerifierError("pin-failed", 502, "pinata refused one delete", undefined, { serviceCode: "delete-failed" }),
    );
    expect(failure).toEqual({ key: "deleteFailed", reason: "pinata refused one delete" });
    expect(card({ step: "confirming", failure })).toContain("pinata refused one delete");
  });
});

describe("every language carries the private re-check words", () => {
  const locales = readdirSync("messages")
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(".json", ""));

  /** Every string's path under a branch, so a missing or extra key shows by name. */
  function leaves(value: unknown, path: string, into: Map<string, string>): Map<string, string> {
    if (typeof value === "string") {
      into.set(path, value);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        leaves(child, `${path}.${key}`, into);
      }
    }
    return into;
  }

  function branches(messages: { passport: Record<string, Record<string, unknown>> }): Map<string, string> {
    const into = new Map<string, string>();
    leaves(messages.passport.privateCopy, "passport.privateCopy", into);
    leaves(messages.passport.attestations.private, "passport.attestations.private", into);
    leaves(messages.passport.sealed.privateCopy, "passport.sealed.privateCopy", into);
    leaves(messages.passport.sealed.posterLinePrivate, "passport.sealed.posterLinePrivate", into);
    return into;
  }

  const english = branches(en as never);

  it("is ten languages, and English has every word the screens ask for", () => {
    expect(locales.length).toBe(10);
    expect(english.size).toBe(31);
  });

  for (const locale of locales) {
    it(`${locale} has every key, filled, with the date kept and no long dash`, () => {
      const words = branches(JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as never);

      expect([...words.keys()].sort()).toEqual([...english.keys()].sort());
      for (const [path, text] of words) {
        expect(text.trim().length, path).toBeGreaterThan(0);
        expect(text, path).not.toContain(String.fromCharCode(0x2014));
      }
      expect(words.get("passport.sealed.posterLinePrivate")).toContain("{date}");
      // The one fact every line about a private verdict exists to keep honest.
      expect(words.get("passport.attestations.private.lead")).toContain("Chainlink");
    });
  }
});
