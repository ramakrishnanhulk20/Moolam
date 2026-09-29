import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

/**
 * Every Studio and My pictures state leaves the creator a way on (WO-213).
 *
 * One case per step of the order: the expired session's Sign in again, the
 * title field that answers an empty press, the 0 MON account, the grid's
 * loading, failed and empty faces, the grey Register another, the account on
 * My pictures, the two failures that used to end in nothing, the raw reason
 * folded under Details, the warning mark, the sealed list's real field names,
 * and the copy button that says when it could not copy.
 *
 * Node renders markup, not a screen, so what is held is what the markup
 * carries. How it sits at 375 px is checked on the dev server.
 */

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ logout: async () => undefined }),
}));

const passports = vi.hoisted(() => ({
  current: {
    status: "ready" as "reading" | "ready" | "unreadable",
    passports: [] as unknown[],
    error: null as string | null,
    refresh: () => undefined,
    hasMore: false,
    loadingMore: false,
    moreError: null as string | null,
    more: () => undefined,
  },
}));

vi.mock("@/lib/studio/useCreatorPassports", () => ({ useCreatorPassports: () => passports.current }));

// The failure note and the done screen's actions arrive through next/dynamic.
// Every loader is started and awaited once, so the panels render them whole.
const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", async () => {
  const { createElement: make } = await import("react");
  return {
    default: (load: () => Promise<FunctionComponent<never>>) => {
      let Loaded: FunctionComponent<never> | null = null;
      chunks.pending.push(
        load().then((component) => {
          Loaded = component;
        }),
      );
      return (props: never) => (Loaded === null ? null : make(Loaded, props));
    },
  };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

const { RegisterPanel } = await import("@/components/studio/RegisterPanel");
const { GeneratePanel } = await import("@/components/studio/GeneratePanel");
const { FailureNote } = await import("@/components/studio/FailureNote");
const { DoneActions } = await import("@/components/studio/DoneActions");
const { StatusBand } = await import("@/components/studio/StatusBand");
const { SealedChoice, SealedFileCard } = await import("@/components/studio/SealedFile");
const { YourPassports } = await import("@/components/studio/YourPassports");
const { OwnPictures } = await import("@/components/mine/OwnPictures");
const { CopyButton, copyValue } = await import("@/components/studio/CopyButton");
const { pressRefusal } = await import("@/components/studio/press");
const { canPayOwnFee, describeFailure } = await import("@/lib/studio/problems");
const { DigestMismatch } = await import("@/lib/chain/digest");
const { fixtureState } = await import("./studio-fixtures");

for (let seen = -1; seen !== chunks.pending.length; ) {
  seen = chunks.pending.length;
  await Promise.all(chunks.pending);
}

const NOOP = () => undefined;
const MARK = 'points="4.6,1 9.4,1 13,4.6 13,9.4 9.4,13 4.6,13 1,9.4 1,4.6"';
const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

/** The same text escaped the way the markup carries it. */
function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}

/** The opening tag of the element that carries this mark. */
function tagOf(markup: string, mark: string): string {
  const at = markup.indexOf(mark);
  expect(at, `no ${mark} in the markup`).toBeGreaterThanOrEqual(0);
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
}

type State = ReturnType<typeof fixtureState>;

function upload(state: State, extra: Record<string, unknown> = {}) {
  return createElement(RegisterPanel, {
    state,
    onChoose: NOOP,
    onTitle: NOOP,
    onConsent: NOOP,
    onSealed: NOOP,
    onSaved: NOOP,
    onRegister: NOOP,
    onReset: NOOP,
    onUnsponsored: NOOP,
    onBind: NOOP,
    ...extra,
  });
}

function generate(state: State, extra: Record<string, unknown> = {}) {
  return createElement(GeneratePanel, {
    state,
    onPrompt: NOOP,
    onTitle: NOOP,
    onConsent: NOOP,
    onSealed: NOOP,
    onIncludePrompt: NOOP,
    onSaved: NOOP,
    onGenerate: NOOP,
    onReset: NOOP,
    onUnsponsored: NOOP,
    onBind: NOOP,
    ...extra,
  });
}

const studio = en.studio;

describe("T6: an expired session", () => {
  it("offers Sign in again on both paths once the panels pass onSignIn", () => {
    const signedOut = { key: "signedOut", next: "signIn" as const };
    for (const node of [
      upload({ ...fixtureState("upload", "failed"), failure: signedOut }, { onSignIn: NOOP }),
      generate({ ...fixtureState("generate", "failed"), failure: signedOut }, { onSignIn: NOOP }),
    ]) {
      const markup = render(node);
      expect(markup).toContain(html(studio.failure.signedOut));
      expect(markup).toContain(`>${studio.actions.signIn}</button>`);
    }
  });
});

describe("T16: an empty title and a missing picture", () => {
  it("marks the title field itself, never takes the press, and names the missing picture beside the grey button", () => {
    const empty = { ...fixtureState("upload", "idle"), title: "", failure: { key: "titleMissing" } };
    const markup = render(upload(empty));
    const field = tagOf(markup, 'aria-invalid="true"');
    const described = /aria-describedby="([^"]+)"/.exec(field)?.[1];
    expect(described).toBeDefined();
    expect(tagOf(markup, "data-title-needed")).toContain(`id="${described}"`);
    expect(markup).toContain(html(studio.titleNeeded));
    expect(markup).not.toContain(html(studio.failure.titleMissing));

    const withFile = { ...fixtureState("upload", "idle"), file: new File(["x"], "a.png"), title: " " };
    expect(pressRefusal(withFile)).toBe("titleMissing");
    expect(pressRefusal({ ...withFile, title: "Harbour" })).toBeNull();
    const source = readFileSync(fileURLToPath(new URL("../components/studio/RegisterPanel.tsx", import.meta.url)), "utf8");
    expect(source).toContain("onClick={pressRegister}");

    const noFile = render(upload(fixtureState("upload", "idle")));
    const reason = tagOf(noFile, "data-press-reason");
    const id = /id="([^"]+)"/.exec(reason)?.[1];
    expect(tagOf(noFile, "data-press")).toContain(`aria-describedby="${id}"`);
    expect(tagOf(noFile, "data-press")).toContain("disabled");
    expect(noFile).toContain(html(studio.failure.fileMissing));
  });
});

describe("T17: a 0 MON account", () => {
  it("hides pay the fee myself and says why; with MON it prints the balance beside the button", () => {
    const failure = { key: "sponsorship", next: "unsponsored" as const, reason: "policy refused" };
    const broke = render(createElement(FailureNote, { failure, balance: 0n, onUnsponsored: NOOP }));
    expect(broke).not.toContain(studio.actions.unsponsored);
    expect(broke).toContain(html(studio.register.balanceEmpty));

    const funded = render(createElement(FailureNote, { failure, balance: 10n ** 18n, onUnsponsored: NOOP }));
    const button = funded.indexOf(studio.actions.unsponsored);
    const balance = funded.indexOf("Your account holds 1.0000 MON.");
    expect(button).toBeGreaterThan(0);
    expect(balance).toBeGreaterThan(button);
    expect(funded.slice(button, balance)).not.toContain("<details");
    expect(canPayOwnFee(null)).toBe(true);
    expect(canPayOwnFee(0n)).toBe(false);
  });
});

describe("T18: Your pictures while reading, after a failed read, and empty", () => {
  it("draws card outlines, offers Try again on the refresh, and links an empty My pictures to the Studio", () => {
    const base = { ...passports.current };
    const reading = render(createElement(YourPassports, { passports: { ...base, status: "reading" } }));
    expect(reading.match(/data-outline/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(reading).toContain(html(studio.passports.reading));

    const failed = render(
      createElement(YourPassports, { passports: { ...base, status: "unreadable", error: "fetch failed" } }),
    );
    expect(tagOf(failed, "data-passports-retry")).toContain("button");
    expect(failed).toContain(`>${studio.passports.retry}</button>`);
    expect(failed).toContain(MARK);
    const source = readFileSync(fileURLToPath(new URL("../components/studio/YourPassports.tsx", import.meta.url)), "utf8");
    expect(source).toContain("onClick={passports.refresh}");

    passports.current = { ...base, status: "ready", passports: [] };
    const empty = render(createElement(OwnPictures, { wallet: WALLET, account: { kind: "email", value: "ram@example.com" }, onSignOut: NOOP }));
    expect(tagOf(empty, `>${en.mine.makeFirst}</a>`)).toContain('href="/studio"');
    expect(empty).toContain(en.mine.makeFirst);
  });
});

describe("T25: Register another while the statement is out", () => {
  it("says why the button is grey, and the button names that line", () => {
    const state = { ...fixtureState("upload", "donePublic") };
    const stating = { ...state, statement: { ...state.statement, state: "sending" as const } };
    const markup = render(createElement(DoneActions, { state: stating, onReset: NOOP }));
    const line = tagOf(markup, "data-another-waits");
    const id = /id="([^"]+)"/.exec(line)?.[1];
    expect(tagOf(markup, "data-again")).toContain(`aria-describedby="${id}"`);
    expect(markup).toContain(html(studio.register.anotherWaits));
  });
});

describe("T27: My pictures names the account", () => {
  it("shows who is signed in and Sign out, with no second hairline or display heading", () => {
    passports.current = { ...passports.current, status: "ready", passports: [] };
    const markup = render(
      createElement(OwnPictures, { wallet: WALLET, account: { kind: "email", value: "ram@example.com" }, onSignOut: NOOP }),
    );
    expect(markup).toContain("Signed in as ram@example.com");
    expect(markup).toContain(`>${studio.signOut}</button>`);
    const section = tagOf(markup, "data-passports-on-page");
    expect(section).not.toContain("border-t");
    expect(section).not.toContain("mt-24");
    expect(tagOf(markup, `>${en.mine.grid}</h2>`)).toContain("sr-only");
  });
});

describe("T35: the two failures that used to end in nothing", () => {
  it("gives a digest mismatch Try again and a passkey from another site Bind this device", () => {
    expect(describeFailure(new DigestMismatch("0x01", "0x02"), "sign").next).toBe("again");
    const origin = Object.assign(new Error("wrong site"), { name: "SecurityError" });
    const failure = describeFailure(origin, "sign");
    expect(failure).toMatchObject({ key: "passkeyOrigin", next: "bind" });
    const markup = render(createElement(FailureNote, { failure, onBind: NOOP }));
    expect(markup).toContain(`>${studio.actions.bind}</button>`);
  });
});

describe("T11: the raw reason", () => {
  it("sits closed under Details, first line only, with the address taken out", () => {
    const failure = {
      key: "sendFailed",
      next: "again" as const,
      reason: "HTTP request failed. URL: https://rpc.example.org/key123\nRequest body: {}\nVersion: viem@2.0.0",
    };
    const markup = render(createElement(FailureNote, { failure, onAgain: NOOP }));
    const details = tagOf(markup, "data-failure-details");
    expect(details).toContain("<details");
    expect(details).not.toContain(" open");
    expect(markup).toContain(`${en.common.details}</summary>`);
    expect(markup).toContain("HTTP request failed. URL: the RPC endpoint");
    expect(markup).not.toContain("rpc.example.org");
    expect(markup).not.toContain("Version: viem");
    const sentence = markup.slice(0, markup.indexOf("<details"));
    expect(sentence).not.toContain("HTTP request failed");
  });
});

describe("T38: the warning mark and the failure colour", () => {
  it("starts every failure line with the mark, never a pending one, and draws the only-copy warning in the failure red", () => {
    expect(render(createElement(FailureNote, { failure: { key: "pinFailed", next: "again" as const }, onAgain: NOOP }))).toContain(MARK);
    expect(render(createElement(FailureNote, { failure: { key: "confirmPending" } }))).not.toContain(MARK);
    expect(tagOf(render(createElement(StatusBand, { state: fixtureState("upload", "failed") })), "data-band-mark")).toContain("text-failed");

    const sealed = fixtureState("upload", "doneSealed");
    expect(sealed.sealed.file).not.toBeNull();
    const card = render(
      createElement(SealedFileCard, {
        file: sealed.sealed.file!,
        bits: null,
        title: "Harbour",
        saved: false,
        onSaved: NOOP,
      }),
    );
    const warning = tagOf(card, 'data-only-copy="unsaved"');
    expect(warning).toContain("text-failed");
    expect(warning).not.toContain("text-accent");
  });
});

describe("T39: What becomes public", () => {
  it("prints each field's real name as code, in its own case", () => {
    const markup = render(createElement(SealedChoice, { on: true, onChange: NOOP, bits: null }));
    const key = tagOf(markup, "data-field-key");
    expect(key.startsWith("<code")).toBe(true);
    expect(key).toContain("normal-case");
    expect(markup).toContain(">createdAt</code>");
  });
});

describe("T40: the copy button", () => {
  it("reports a refused clipboard and reserves the wider label's width", async () => {
    expect(await copyValue("0xabc", undefined)).toBe("failed");
    expect(await copyValue("0xabc", { writeText: () => Promise.reject(new Error("denied")) })).toBe("failed");
    expect(await copyValue("0xabc", { writeText: () => Promise.resolve() })).toBe("copied");

    const markup = render(createElement(CopyButton, { value: "0xabc" }));
    expect(markup.match(/data-copy-label/g)?.length).toBe(2);
    expect(markup).toContain(`>${en.common.copy}</span>`);
    expect(markup).toContain(`>${en.common.copied}</span>`);
    expect(tagOf(markup, `>${en.common.copied}</span>`)).toContain("invisible");
  });
});
