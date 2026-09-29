import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { Answer } from "@/components/verify/answer";
import type { Passport } from "@/lib/chain/registry";

/**
 * The passport's words and ways on (WO-214): the owner hint, Copy link, a read
 * that failed, a record that was not read, the fingerprint method beside the
 * fingerprints, the lineage by name, the download that says what it is doing,
 * a failed copy check, the colour of a wait, and the day slider's focus.
 *
 * What this does not cover: a real clipboard, a real download or a real
 * sign-in. Those run only in a browser; here the logic behind each is a small
 * function and the markup is read as the server would send it.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
  setRequestLocale: () => undefined,
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
  useParams: () => ({ locale: "en" }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { sources: string[] }) => createElement("span", { "data-picture": props.sources[0] }),
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: async () => "simulation" }));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

const { ownerHintShows, HintLine } = await import("@/components/passport/OwnerHint");
const { pageAddress, ShareLink } = await import("@/components/passport/ShareLink");
const { ReadFailed } = await import("@/components/passport/ReadFailed");
const { Poster } = await import("@/components/passport/Poster");
const { recordUnread } = await import("@/components/passport/unread");
const { Facts } = await import("@/components/passport/Facts");
const { Lineage } = await import("@/components/passport/Lineage");
const { savedName, DownloadOriginal } = await import("@/components/passport/DownloadOriginal");
const { ProblemLine, Verdict } = await import("@/components/passport/CheckCopy");
const { stampFor } = await import("@/components/passport/RecheckRequest");
const challenge = await import("@/components/passport/Challenge");
const editor = await import("@/components/passport/Editor");
const { PrivateCopyCard, initialPrivateCopyState, privateCopyReducer } = await import(
  "@/components/passport/PrivateCopyPanel"
);
const { ConsentLedger, DayAnswerLine, HIDDEN_THUMB } = await import("@/components/consent/ConsentLedger");
const { shortHex } = await import("@/lib/chain/client");

const ID = `0x${"7c".repeat(32)}` as Hex;
const PARENT = `0x${"3f".repeat(32)}` as Hex;
const CHILD = `0x${"9e".repeat(32)}` as Hex;
const OTHER = `0x${"ab".repeat(32)}` as Hex;
const CREATOR = "0x85a88C5b1b7D1b1a3F3b8c0cF4d7a0F1E4b239a6" as Hex;

const passport: Passport = {
  id: ID,
  exactHash: ID,
  parentId: `0x${"00".repeat(32)}` as Hex,
  creator: CREATOR,
  generatorAgentId: 0n,
  phash: 0x6ccf137087789a25n,
  blockhash256: `0x${"11".repeat(32)}` as Hex,
  manifestHash: `0x${"22".repeat(32)}` as Hex,
  kind: 0,
  fingerprintVersion: 1,
  registeredAt: 1_788_881_666n,
  disputed: false,
  metadataURI: "ipfs://bafkreimetadata",
};

const publicArt: Art = {
  title: "Kites at dusk",
  imageUrl: "https://gateway.example/ipfs/full",
  thumbnailUrl: "https://gateway.example/ipfs/thumb",
  original: true,
  missing: false,
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

/** React escapes an apostrophe in the markup; the message file does not. */
function asRendered(line: string): string {
  return line.replace(/'/g, "&#x27;");
}

const WARNING_MARK = "<polygon";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("step 2: the owner hint", () => {
  it("shows to a signed out reader only, and offers sign-in", () => {
    expect(ownerHintShows({ privy: true, owner: CREATOR, signedIn: false })).toBe(true);
    // A signed in stranger, and the holder, who is always signed in.
    expect(ownerHintShows({ privy: true, owner: CREATOR, signedIn: true })).toBe(false);
    // Nobody can tell yet, so nothing flashes.
    expect(ownerHintShows({ privy: true, owner: CREATOR, signedIn: null })).toBe(false);
    // No sign-in on this build, or nobody holds the passport.
    expect(ownerHintShows({ privy: false, owner: CREATOR, signedIn: false })).toBe(false);
    expect(ownerHintShows({ privy: true, owner: null, signedIn: false })).toBe(false);

    const markup = render(createElement(HintLine, { onSignIn: () => undefined }));
    expect(markup).toContain(en.passport.ownerHint);
    expect(markup).toContain(`>${en.passport.consent.control.actions.signIn}</button>`);
  });
});

describe("step 3: Copy link", () => {
  it("copies the page without its hash, and holds both labels in one cell so the width never jumps", () => {
    expect(pageAddress(`https://moolam.example/en/passport/${ID}#ai-use`)).toBe(
      `https://moolam.example/en/passport/${ID}`,
    );

    const markup = render(
      createElement(ShareLink, {
        words: { copy: en.passport.share.copy, copied: en.passport.share.copied, copyFailed: en.common.copyFailed },
      }),
    );
    expect(markup).toContain(en.passport.share.copy);
    expect(markup).toContain(en.passport.share.copied);
    expect(markup.match(/\[grid-area:1\/1\]/g)).toHaveLength(2);
    expect(markup).toContain("invisible");

    return Poster({ passport, art: publicArt, locale: "en" }).then((poster) => {
      expect(render(poster)).toContain("data-copy-link");
    });
  });
});

describe("step 4: a chain read that failed", () => {
  it("says so, offers Try again and Explore, and keeps the raw reason inside a closed Details", () => {
    const markup = render(
      createElement(ReadFailed, {
        sentence: en.passport.error,
        retry: en.common.tryAgain,
        explore: en.notFound.explore,
        exploreHref: "/en/explore",
        details: en.common.details,
        reason: "the endpoint answered 503",
      }),
    );
    expect(markup).toContain(en.passport.error);
    expect(markup).toContain(`>${en.common.tryAgain}</button>`);
    expect(markup).toContain('href="/en/explore"');
    expect(markup).toContain(WARNING_MARK);
    const details = /<details[^>]*>([\s\S]*)<\/details>/.exec(markup);
    expect(details?.[0]).not.toMatch(/<details[^>]*\sopen/);
    expect(details?.[1]).toContain(en.common.details);
    expect(details?.[1]).toContain("the endpoint answered 503");
    expect(markup.indexOf("the endpoint answered 503")).toBeGreaterThan(markup.indexOf("<details"));
  });
});

describe("step 5: a record that was not read", () => {
  it("titles the poster with the short id and says the title is not read yet, never Untitled", async () => {
    expect(recordUnread({ missing: true })).toBe(true);
    // A document that was read and simply has no name is Untitled, as before.
    expect(recordUnread({ title: undefined, missing: true })).toBe(false);

    const unread = render(await Poster({ passport, art: { missing: true }, locale: "en" }));
    const title = /<h1 data-title-unread="true"[^>]*>([^<]*)<\/h1>/.exec(unread);
    expect(title?.[1]).toBe(shortHex(ID, 6, 4));
    expect(unread).toContain(en.passport.titleUnread);
    expect(unread).not.toContain(`>${en.passport.untitled}<`);

    const nameless = render(await Poster({ passport, art: { title: undefined, missing: true }, locale: "en" }));
    expect(nameless).toContain(`>${en.passport.untitled}</h1>`);
    expect(nameless).not.toContain(en.passport.titleUnread);
  });
});

describe("step 6: the fingerprint method", () => {
  it("leaves the poster's credit line and sits beside the fingerprints in the record", async () => {
    const version = en.passport.fingerprintVersion.replace("{version}", "1");
    const poster = render(await Poster({ passport, art: publicArt, locale: "en" }));
    expect(poster).not.toContain(version);

    const facts = render(
      await Facts({ passport, art: publicArt, owner: CREATOR, hasPasskey: false, standing: "verified", txHash: null }),
    );
    const heading = facts.indexOf(`>${en.passport.fingerprints}<`);
    const line = /<p data-fingerprint-version="true"[^>]*>([^<]*)<\/p>/.exec(facts);
    expect(line?.[1]).toBe(version);
    expect(facts.indexOf("data-fingerprint-version")).toBeGreaterThan(heading);
  });

  it("claims anyone can re-check the picture only where the picture is public", async () => {
    const facts = (art: Art) =>
      Facts({ passport, art, owner: CREATOR, hasPasskey: false, standing: "unverified", txHash: null }).then(render);
    const sealed: Art = { title: "Kept back", sealed: true, commitment: { algorithm: "sha-256", value: ID }, missing: false };

    const open = await facts(publicArt);
    expect(open).toContain("data-fingerprints-body");
    expect(open).toContain(asRendered(en.passport.fingerprintsBody));

    const closed = await facts(sealed);
    expect(closed).not.toContain("data-fingerprints-body");
    expect(closed).not.toContain(asRendered(en.passport.fingerprintsBody));
    // The sealed record still says what can be compared.
    expect(closed).toContain(en.passport.sealed.commitmentLine);
  });
});

describe("step 7: the lineage by name", () => {
  it("shows each relative's title and thumbnail with the short id quiet, and the id alone when unread", async () => {
    const markup = renderToStaticMarkup(
      await Lineage({
        parentId: PARENT,
        edits: [CHILD, OTHER],
        family: {
          [PARENT]: { title: "Harbour", thumbnailUrl: "https://gateway.example/ipfs/parent-thumb" },
          [CHILD]: { title: "Harbour, cropped" },
        },
      }),
    );
    expect(markup).toContain(">Harbour</span>");
    expect(markup).toContain(">Harbour, cropped</span>");
    expect(markup).toContain('data-picture="https://gateway.example/ipfs/parent-thumb"');
    expect(markup).toContain(shortHex(PARENT, 6, 4));
    // No thumbnail: the seal stands in. Not read at all: the id is the name.
    expect(markup).toContain("motif absolute inset-0");
    expect(markup).toContain(shortHex(OTHER, 12, 10));
  });
});

describe("step 8: the download", () => {
  it("saves under the route's own name, and has a pending and a failure line in the reader's words", async () => {
    expect(savedName('attachment; filename="kites-at-dusk-7c7c7c7c.jpg"', "fallback")).toBe("kites-at-dusk-7c7c7c7c.jpg");
    expect(savedName(null, "moolam-7c7c7c7c")).toBe("moolam-7c7c7c7c");
    expect(savedName("attachment", "moolam-7c7c7c7c")).toBe("moolam-7c7c7c7c");

    const link = render(
      createElement(DownloadOriginal, {
        href: `/api/passports/${ID}/picture`,
        fallbackName: "x",
        words: {
          download: en.passport.download,
          downloading: en.passport.downloading,
          downloadFailed: en.passport.downloadFailed,
        },
      }),
    );
    expect(link).toContain(en.passport.download);
    expect(link).toContain(`href="/api/passports/${ID}/picture"`);
    expect(link).toContain("data-download-original");
    expect(en.passport.downloading).not.toMatch(/gateway did not answer/i);
    expect(en.passport.downloadFailed).toMatch(/try again/i);
  });
});

describe("step 9: checking a copy", () => {
  it("gives a failed check Try again and Verify, with the service's words under Details", () => {
    const failed = render(
      createElement(ProblemLine, {
        problem: { key: "problem.rateLimited", reason: "slow down" },
        again: () => undefined,
      }),
    );
    expect(failed).toContain(en.passport.check.failed);
    expect(failed).toContain(`>${en.common.tryAgain}</button>`);
    expect(failed).toContain('href="/verify"');
    expect(failed).toContain(WARNING_MARK);
    expect(failed.indexOf("slow down")).toBeGreaterThan(failed.indexOf("<details"));

    const answer = {
      kind: "close",
      id: OTHER,
      confidence: 0.97,
      variant: "identity",
      others: 0,
      manifest: false,
      phashDistance: 2,
      blockhashDistance: 6,
      queried: {},
    } as unknown as Answer;
    const other = render(
      createElement(Verdict, {
        answer,
        name: "copy.jpg",
        passportId: ID,
        other: {
          id: OTHER,
          kind: 0,
          registeredAt: "1788881666",
          creator: CREATOR,
          generatorAgentId: "0",
          disputed: false,
          title: "Someone else's harbour",
        },
      }),
    );
    expect(other).toContain(en.passport.check.openOther);
    expect(other).toContain(asRendered("Someone else's harbour"));
    expect(other).toContain(`href="/passport/${OTHER}"`);
    expect(other).toContain(shortHex(OTHER, 10, 8));
  });
});

describe("step 10: colour roles", () => {
  it("draws waits in the pending blue, a recorded challenge as done, and the irreversible delete in red", () => {
    for (const kind of ["sending", "queued", "running", "confirming"] as const) {
      const stamp = stampFor({ kind } as Parameters<typeof stampFor>[0]);
      expect(stamp?.tone, kind).toBe("text-pending");
      expect(stamp?.mark, kind).not.toMatch(/accent|motif/);
    }

    expect(challenge.NUMBER_TONE.running).toBe("text-pending");
    expect(challenge.NUMBER_TONE.done).toBe("text-verified");
    expect(challenge.MARKER_TONE.done).toBe("bg-verified");
    expect(editor.NUMBER_TONE.running).toBe("text-pending");
    expect(editor.MARKER_TONE.running).toContain("bg-pending");

    const asked = privateCopyReducer(initialPrivateCopyState, { type: "ask" });
    const noop = () => undefined;
    const markup = render(
      createElement(PrivateCopyCard, { state: asked, actions: { ask: noop, keep: noop, forget: noop, signIn: noop } }),
    );
    const button = /<button[^>]*data-confirm-delete="true"[^>]*class="([^"]*)"/.exec(markup)?.[1] ?? "";
    expect(button.split(/\s+/)).toContain("bg-failed");
    expect(button).not.toContain("bg-accent");

    const failed = render(
      createElement(PrivateCopyCard, {
        state: { step: "confirming", failure: { key: "deleteFailed" } },
        actions: { ask: noop, keep: noop, forget: noop, signIn: noop },
      }),
    );
    expect(failed).toContain(WARNING_MARK);
  });
});

describe("step 11: the day slider", () => {
  it("keeps the real range input visible to focus, with only its own thumb and track hidden", () => {
    const markup = render(
      createElement(ConsentLedger, {
        id: ID,
        registeredAt: 1_788_000_000,
        now: 1_788_881_666,
        entries: [],
        standing: { stated: false, entry: null },
      }),
    );
    const input = (/<input type="range"[^>]*class="([^"]*)"/.exec(markup)?.[1] ?? "").replaceAll("&amp;", "&");
    expect(input).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(input).toContain(HIDDEN_THUMB.split(" ")[0]);
    expect(input).toContain("[&::-webkit-slider-thumb]:opacity-0");
    // The line a failed day prints already says what to do next.
    expect(en.passport.consent.askFailed).toMatch(/slider/);
  });

  it("lets the failed-day line wrap in the reading face, with the mark before it, in a row that grows", () => {
    const markup = render(createElement(DayAnswerLine, { state: "failed" }));
    const line = /<p role="alert" data-day-failed="true" class="([^"]*)">/.exec(markup)?.[1].split(/\s+/) ?? [];
    expect(line).toContain("text-sm");
    expect(line).not.toContain("uppercase");
    expect(line).not.toContain("font-mono");
    expect(line.some((name) => /^h-\d/.test(name))).toBe(false);
    expect(markup).toContain('class="mt-5 min-h-4"');
    expect(markup.indexOf(WARNING_MARK)).toBeLessThan(markup.indexOf(en.passport.consent.askFailed));

    // The wait keeps its one mono word.
    expect(render(createElement(DayAnswerLine, { state: "asking" }))).toContain(en.passport.consent.asking);
  });
});
