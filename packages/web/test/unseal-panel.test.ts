import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { initialUnsealState, type PassportUnseal, type UnsealState } from "@/lib/passport/unseal";

/**
 * The panel that publishes a sealed picture, drawn in every state it has.
 *
 * The hook is where Privy lives and Privy only runs in a browser, so it is
 * replaced by a value each case sets for itself. What is tested here is what
 * the holder is told: that the button to publish does not exist until the file
 * has been proved on this machine, that a passport which is public already is
 * not shouted at as a failure, and that nobody but the holder sees any of it.
 */

const stub = vi.hoisted(() => ({ current: null as unknown as PassportUnseal }));

vi.mock("@/lib/passport/unseal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/passport/unseal")>()),
  useUnsealPassport: () => stub.current,
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
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
const { UnsealPanel } = await import("@/components/passport/UnsealPanel");

await Promise.all(chunks.pending);

const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const HOLDER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;

const NOOP = () => undefined;
const ASYNC_NOOP = async () => undefined;

const RESULT = {
  passportId: PASSPORT,
  image: { cid: "bafkreiimage", uri: "ipfs://bafkreiimage", gatewayUrl: "https://service.example/ipfs/bafkreiimage" },
  thumbnail: { cid: "bafkreithumb", uri: "ipfs://bafkreithumb", gatewayUrl: "https://service.example/ipfs/bafkreithumb" },
  record: { cid: "bafkreirecord", uri: "ipfs://bafkreirecord", gatewayUrl: "https://service.example/ipfs/bafkreirecord" },
  unsealedBy: HOLDER,
  unsealedAt: "2026-09-22T06:12:44.000Z",
};

function unseal(over: Partial<PassportUnseal> = {}, state: Partial<UnsealState> = {}): PassportUnseal {
  return {
    ready: true,
    isHolder: true,
    ...over,
    state: { ...initialUnsealState, ...state },
    actions: { choose: ASYNC_NOOP, publish: ASYNC_NOOP, signIn: NOOP, reset: NOOP },
  };
}

function render(locale: "en" | "ta", node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  const mounted = createElement(WalletMounted.Provider, { value: true }, node);
  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, mounted),
  );
}

function panel(value: PassportUnseal, locale: "en" | "ta" = "en", sealed = true): string {
  stub.current = value;
  return render(locale, createElement(UnsealPanel, { passportId: PASSPORT, owner: HOLDER, sealed }));
}

const kept = { file: new File([new Uint8Array([1])], "kadal.jpg", { type: "image/jpeg" }), name: "kadal-at-dawn.jpg", size: 2_400_000 };

describe("who sees the publish control", () => {
  it("says nothing at all to a visitor who is not the holder", () => {
    expect(panel(unseal({ isHolder: false }))).toBe("");
  });

  it("says nothing while Privy has not answered about the session", () => {
    expect(panel(unseal({ ready: false }))).toBe("");
  });

  it("says nothing on a passport that is already public", () => {
    expect(panel(unseal(), "en", false)).toBe("");
  });

  it("draws itself for the wallet the registry says holds this passport", () => {
    const markup = panel(unseal());
    expect(markup).toContain(en.passport.unseal.heading);
    expect(markup).toContain(en.passport.unseal.kicker);
  });
});

describe("before a file is chosen", () => {
  it("says what the file is, what happens to it, and that it cannot be undone", () => {
    const markup = panel(unseal());

    expect(markup).toContain(en.passport.unseal.body);
    expect(markup).toContain(en.passport.unseal.permanent);
    expect(markup).toContain(en.passport.unseal.choose);
  });

  it("offers no way to publish until a file has been proved on this machine", () => {
    expect(panel(unseal())).not.toContain(en.passport.unseal.publish);
    expect(panel(unseal({}, { kept }))).toContain(en.passport.unseal.publish);
  });

  it("says what it is doing while it hashes the file, and offers nothing to press", () => {
    const markup = panel(unseal({}, { checking: true }));

    expect(markup).toContain(en.passport.unseal.checking);
    expect(markup).not.toContain(en.passport.unseal.publish);
  });

  it("names the proved file and says why it is the right one", () => {
    const markup = panel(unseal({}, { kept }));

    expect(markup).toContain("kadal-at-dawn.jpg");
    expect(markup).toContain("2.4 MB");
    expect(markup).toContain(en.passport.unseal.matched);
  });

  it("says it in the reader's own language", () => {
    const markup = panel(unseal(), "ta");

    expect(markup).toContain(ta.passport.unseal.heading);
    expect(markup).not.toContain(en.passport.unseal.permanent);
  });
});

describe("while the picture is being published", () => {
  it("names the wait for what it is rather than leaving the button hanging", () => {
    const markup = panel(unseal({}, { kept, sending: true }));

    expect(markup).toContain(en.passport.unseal.sending);
    expect(markup).toContain('role="status"');
  });
});

describe("once the picture is public", () => {
  it("shows the picture and all four addresses it now lives at", () => {
    const markup = panel(unseal({}, { kept, result: RESULT }));

    expect(markup).toContain(en.passport.unseal.done.label);
    expect(markup).toContain("bafkreiimage");
    expect(markup).toContain("bafkreithumb");
    expect(markup).toContain("bafkreirecord");
    // Compared without the apostrophe, which the renderer writes as an entity.
    expect(markup).toContain(en.passport.unseal.done.body.split("Nothing on chain")[0]);
  });

  it("leaves the file chooser behind, because there is nothing left to choose", () => {
    const markup = panel(unseal({}, { kept, result: RESULT }));
    expect(markup).not.toContain(en.passport.unseal.choose);
  });
});

describe("when the service refuses", () => {
  it("says the wrong file is the wrong file, and offers another one", () => {
    const markup = panel(unseal({}, { failure: { key: "notTheFile", next: "chooseAgain" } }));

    expect(markup).toContain(en.passport.unseal.failure.notTheFile);
    expect(markup).toContain(en.passport.unseal.actions.chooseAgain);
    expect(markup).toContain('role="alert"');
  });

  it("treats a passport that is already public as news, not as an alarm", () => {
    const markup = panel(unseal({}, { failure: { key: "alreadyUnsealed", next: "showPicture" } }));

    expect(markup).toContain(en.passport.unseal.failure.alreadyUnsealed);
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
  });

  it("tells a holder whose picture is out and whose record is not exactly that", () => {
    const markup = panel(unseal({}, { failure: { key: "recordPinFailed", reason: "the picture is published", next: "again" } }));

    expect(markup).toContain(en.passport.unseal.failure.recordPinFailed);
    expect(markup).toContain("the picture is published");
  });

  it("prints the allowance the service sent back with a refusal", () => {
    const markup = panel(
      unseal({}, { failure: { key: "quota" }, quota: { used: 5, limit: 5, resetsAt: 1_788_961_533 } }),
    );

    expect(markup).toContain("5 of 5");
  });
});
