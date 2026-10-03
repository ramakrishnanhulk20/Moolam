import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import hi from "@/messages/hi.json";
import ja from "@/messages/ja.json";
import ko from "@/messages/ko.json";
import pt from "@/messages/pt.json";
import ta from "@/messages/ta.json";
import zh from "@/messages/zh.json";
import type { Art } from "@/components/passport/art";
import type { PassportMarkFacts } from "@/components/mark/read";
import { initialEditState } from "@/lib/passport/edit";
import type { PassportEdit } from "@/lib/passport/useEditPassport";

/**
 * The trust mark's loose ends (WO-284a2): the second-print line with no
 * number in it, the seenEarlier sentence and the platform's statement label,
 * the sworn line beside the edit button, and the look-alike amber as one token.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => createTranslator({ locale: "en", messages: en, namespace: namespace as never }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
}));
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/passport/useEditPassport", () => ({
  useEditPassport: (): PassportEdit => ({
    ready: true,
    isOwner: true,
    configured: true,
    granted: true,
    granting: false,
    revoking: false,
    grantFailure: null,
    state: initialEditState,
    actions: {
      grant: async () => undefined,
      revoke: async () => undefined,
      choose: () => undefined,
      setTitle: () => undefined,
      setNote: () => undefined,
      submit: async () => undefined,
      recheck: async () => undefined,
      signIn: () => undefined,
      reset: () => undefined,
    },
  }),
}));

const { markCopy } = await import("@/components/mark/copy");
const { claimCopy, ClaimLines } = await import("@/components/mark/claim");
const { Editor } = await import("@/components/passport/Editor");

const ID = `0x${"7c".repeat(32)}` as Hex;
const EARLIER = `0x${"e1".repeat(32)}` as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const ALL = { de, en, es, fr, hi, ja, ko, pt, ta, zh };

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

const shown = (line: string): string => line.replace(/'/g, "&#x27;");

function facts(secondPrint: boolean): PassportMarkFacts {
  return {
    mark: { state: "mismatch", verdict: { network: true, matched: false, phashBits: secondPrint ? 3 : 27, at: 1_790_000_600 }, secondPrint },
    registeredAt: 1_790_000_000,
    challenge: null,
    earlier: null,
    lookalike: { kind: "quiet" },
    later: { first: null, count: 0 },
    testRun: false,
  };
}

const art: Art = { title: "Nets", thumbnailUrl: "https://gateway.example/ipfs/x", statements: { sworn: true }, missing: false };
const passport = { creator: CREATOR, generatorAgentId: 0n, registeredAt: 1_790_000_000n, metadataURI: "ipfs://bafkreidocument" };

describe("the three words, in all ten files", () => {
  it("carries the second-print line with no number, and the two claim keys, in every language", () => {
    expect(ALL.en.mark.secondPrint).toBe(
      "Chainlink's network found the look fingerprint matches and the layout fingerprint does not. Both have to match, so this passport does not pass.",
    );
    expect(ALL.en.claim.seenEarlier).toBe("Before signing, they were shown an earlier passport like this one.");
    expect(ALL.en.claim.platformStatement).toBe("{platform}'s statement");
    for (const [locale, messages] of Object.entries(ALL)) {
      // The chain keeps only the look distance, so no language may print a layout figure.
      expect(messages.mark.secondPrint, locale).not.toMatch(/[0-9]/);
      expect(messages.claim.seenEarlier.length, locale).toBeGreaterThan(0);
      expect(messages.claim.platformStatement, locale).toContain("{platform}");
    }
  });
});

describe("the second-print mismatch", () => {
  it("says only the layout fingerprint missed when the look fingerprint was inside the shared limit", async () => {
    expect((await markCopy(facts(true), "en")).line).toBe(en.mark.secondPrint);
    expect((await markCopy(facts(false), "en")).line).toBe(en.mark.states.mismatch.line);
  });
});

describe("the registrant's statements, worded", () => {
  it("draws the seenEarlier sentence above the open-earlier link", async () => {
    const markup = render(
      ClaimLines({ copy: await claimCopy({ passport, art: { ...art, statements: { sworn: true, seenEarlier: EARLIER } }, platform: null }) }),
    );
    const sentence = markup.indexOf(en.claim.seenEarlier);
    expect(sentence).toBeGreaterThan(-1);
    expect(markup.indexOf(`href="/passport/${EARLIER}"`)).toBeGreaterThan(sentence);
  });

  it("draws a platform's statement under the listed platform's name, and draws none for a creator the list does not name", async () => {
    const statement = { sworn: false, platformStatement: "Drawn on Dreamloom by the person signed in." };
    const listed = render(
      ClaimLines({ copy: await claimCopy({ passport, art: { ...art, statements: statement }, platform: { status: "kit", name: "Dreamloom" } }) }),
    );
    expect(listed).toContain(shown("Dreamloom's statement"));
    expect(listed).toContain(statement.platformStatement);
    const outside = render(
      ClaimLines({ copy: await claimCopy({ passport, art: { ...art, statements: statement }, platform: { status: "outsideKit", name: "Dreamloom" } }) }),
    );
    expect(outside).toContain(shown("Dreamloom's statement"));
    expect(outside).toContain(statement.platformStatement);
    const unlisted = render(ClaimLines({ copy: await claimCopy({ passport, art: { ...art, statements: statement }, platform: null }) }));
    expect(unlisted).not.toContain(statement.platformStatement);
    expect(unlisted).not.toContain("data-claim-platform-statement");
    expect(unlisted).not.toContain("figcaption");
    expect(unlisted).not.toContain("blockquote");
  });
});

describe("the edit form", () => {
  it("puts the sworn line beside the button that signs the edit (L21)", () => {
    const markup = render(createElement(Editor, { parentId: ID, owner: CREATOR }));
    const sworn = markup.indexOf("data-sworn");
    const submit = markup.indexOf(en.passport.edit.form.submit);
    expect(markup).toContain("data-edit-submit");
    expect(sworn).toBeGreaterThan(markup.indexOf("data-edit-submit"));
    expect(submit).toBeGreaterThan(sworn);
    expect(markup).toContain(shown(en.sworn.line));
  });
});

describe("the look-alike amber is one token", () => {
  it("is defined at the measured shades, light once and dark in its two selectors, and no screen spells the hex out", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles/globals.css", import.meta.url)), "utf8");
    expect(css.match(/--status-lookalike: #875400;/g)).toHaveLength(1);
    // The dark shade is written twice: in the dark class, and again in the block
    // a page with no theme class gets on a dark device. A test in light-default
    // holds those two lists identical.
    expect(css.match(/--status-lookalike: #f2a93b;/g)).toHaveLength(2);
    expect(css).toContain("--color-lookalike: var(--status-lookalike);");
    for (const file of ["../components/mark/tones.ts", "../components/mark/MarkBand.tsx", "../components/studio/BeforeSigning.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/#875400|#f2a93b/i);
      expect(source, file).toContain("lookalike");
    }
  });
});
