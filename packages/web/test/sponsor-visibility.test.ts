import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { bitsOf } from "@/lib/chain/fingerprint";
import type { Attestation } from "@/lib/chain/registry";
import type { IndexStatus } from "@/lib/status/read";

/**
 * What each sponsor does, said on the real screens rather than in a caption.
 *
 * The four roll-ins are covered where a reader would meet them: the two
 * fingerprints drawn as bits under the poster, the index gap said out loud in
 * the footer, and every language carrying the lines that do it. The studio
 * receipt's own lines cannot be reached without a passkey prompt, so they are
 * covered from a fixture in studio-render.
 */

const locale = { current: "en" as "en" | "ta" };
const status = { current: null as IndexStatus | null };

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: locale.current, messages: locale.current === "en" ? en : ta, namespace }),
  getFormatter: async ({ locale: given }: { locale: string }) => ({
    dateTime: (date: Date) =>
      new Intl.DateTimeFormat(given, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date),
  }),
}));

vi.mock("@/lib/status/current", () => ({
  currentStatus: async () => ({
    verifier: { state: "live", records: 31 },
    index: status.current,
    chain: { state: "live", block: 105_255_866 },
  }),
}));

const { Attestations } = await import("@/components/passport/Attestations");
const { SystemStatus } = await import("@/components/status/SystemStatus");

const RECEIVER = "0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04" as Hex;
const REPORT_TX = `0x${"c3".repeat(32)}` as Hex;

/** The fingerprint on the record, and the word a re-check wrote it back in. */
const REGISTERED = 0x6ccf137087789a25n;
const RECOMPUTED = `0x${"0".repeat(48)}6ccf137087789a25` as Hex;

function attestation(over: Partial<Attestation> = {}): Attestation {
  return { receiver: RECEIVER, matched: true, distance: 0, recomputed: RECOMPUTED, at: 1_788_876_542n, ...over };
}

async function attestations(
  rows: Attestation[],
  phash = REGISTERED,
  language: "en" | "ta" = "en",
): Promise<string> {
  locale.current = language;
  return renderToStaticMarkup(
    await Attestations({
      attestations: rows,
      indexed: rows.map((row) => ({ receiver: row.receiver, at: row.at, txHash: REPORT_TX })),
      phash,
      locale: language,
    }),
  );
}

describe("the second opinion, drawn", () => {
  it("leads the passport page, straight under the poster and above the record", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../app/[locale]/passport/[id]/page.tsx", import.meta.url)),
      "utf8",
    );
    const poster = page.indexOf("<Poster");
    const second = page.indexOf("<Attestations");
    const facts = page.indexOf("<Facts");
    expect(poster).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(poster);
    expect(facts).toBeGreaterThan(second);
  });

  it("draws both fingerprints as 64 cells each and says how far apart they are", async () => {
    const markup = await attestations([attestation()]);
    expect(markup).toContain("Registered fingerprint");
    expect(markup).toContain(en.passport.attestations.recomputedGrid);
    expect(markup).toContain("0 of 64 bits apart");
    // Two grids, sixty four cells each, and nothing marked as disagreeing.
    expect(markup.match(/grid-cols-8/g)).toHaveLength(2);
    expect(markup).not.toContain("bg-failed");
  });

  it("counts the bits itself rather than reprinting the figure the receiver wrote", async () => {
    // Five bits flipped in the stored fingerprint, and a receiver that still
    // claims zero. The sentence follows the two values, not the claim.
    const markup = await attestations([attestation()], REGISTERED ^ 0b11111n);
    expect(markup).toContain("5 of 64 bits apart");
    expect(markup).toContain("As the receiver wrote it");
    expect(markup).toContain("0 of 64 bits");
    expect(markup.match(/bg-failed/g)?.length).toBe(5);
  });

  it("marks the verdict in the verified tone only when nothing is apart", async () => {
    expect(await attestations([attestation()])).toContain("text-verified");
    const apart = await attestations([attestation({ matched: false, distance: 9 })], REGISTERED ^ 0xffn);
    expect(apart).toContain("8 of 64 bits apart");
    expect(apart).toContain("text-failed");
  });

  it("keeps the honest empty state, and says what a re-check is", async () => {
    const markup = await attestations([]);
    expect(markup).toContain(en.passport.attestations.empty);
    expect(markup).toContain(en.passport.attestations.whatIsRecheck);
    expect(markup).not.toContain("grid-cols-8");
  });

  it("says all of it in the reader's own language", async () => {
    const markup = await attestations([attestation()], REGISTERED, "ta");
    expect(markup).toContain(ta.passport.attestations.registeredGrid);
    expect(markup).toContain("64-இல் 0 பிட்கள் வேறுபாடு");
  });

  it("reads a fingerprint highest bit first, so the grid fills left to right", () => {
    const bits = bitsOf(0x8000000000000001n);
    expect(bits).toHaveLength(64);
    expect(bits[0]).toBe(true);
    expect(bits[63]).toBe(true);
    expect(bits.filter(Boolean)).toHaveLength(2);
  });
});

describe("the footer's line about the index", () => {
  it("says how far behind the chain it is, in blocks", async () => {
    status.current = { state: "live", block: 105_255_863, behind: 3 };
    locale.current = "en";
    const markup = renderToStaticMarkup(await SystemStatus());
    expect(markup).toContain("indexed to block 105,255,863, 3 blocks behind the chain");
  });

  it("says it is in step rather than printing a gap of zero", async () => {
    status.current = { state: "live", block: 105_255_866, behind: 0 };
    const markup = renderToStaticMarkup(await SystemStatus());
    expect(markup).toContain("indexed to block 105,255,866, in step with the chain");
    expect(markup).not.toContain("0 blocks behind");
  });

  it("names the block and no gap when the chain head could not be read", async () => {
    status.current = { state: "live", block: 105_255_866, behind: null };
    const markup = renderToStaticMarkup(await SystemStatus());
    expect(markup).toContain("block 105,255,866");
    expect(markup).not.toContain("behind the chain");
  });

  it("still carries the block when the index has fallen far behind", async () => {
    status.current = { state: "behind", block: 105_000_000, blocks: 901 };
    const markup = renderToStaticMarkup(await SystemStatus());
    expect(markup).toContain("behind by 901 blocks");
    expect(markup).toContain("indexed to block 105,000,000, 901 blocks behind the chain");
  });

  it("keeps the unreachable state, with no block and no gap", async () => {
    status.current = { state: "unreachable" };
    const markup = renderToStaticMarkup(await SystemStatus());
    expect(markup).toContain("unreachable");
    expect(markup).not.toContain("indexed to block");
  });

  it("says the gap in the reader's own language", async () => {
    status.current = { state: "live", block: 105_255_866, behind: 0 };
    locale.current = "ta";
    const markup = renderToStaticMarkup(await SystemStatus());
    expect(markup).toContain("செயினுடன் சேர்ந்தே");
    locale.current = "en";
  });
});

describe("every language carries the new lines", () => {
  const LOCALES = ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"] as const;
  const KEYS = [
    "passport.attestations.distanceLabel",
    "passport.attestations.registeredGrid",
    "passport.attestations.recomputedGrid",
    "passport.attestations.verdict",
    "passport.attestations.gridNote",
    "passport.attestations.whatIsRecheck",
    "footer.status.gap",
    "footer.status.inStep",
    "studio.identity.passkeySigned",
    "studio.receipt.confirmedIn",
    "studio.receipt.msUnit",
    "studio.receipt.confirmedDetail",
    "studio.receipt.sealedAfter",
    "studio.receipt.sealedUnderSecond",
    "studio.receipt.billedSponsored",
    "studio.receipt.billedOwn",
    "studio.receipt.billedExact",
    "studio.receipt.wouldHaveCost",
  ];

  it("in all ten files, with the placeholders the screens hand them", () => {
    for (const language of LOCALES) {
      const messages = JSON.parse(
        readFileSync(fileURLToPath(new URL(`../messages/${language}.json`, import.meta.url)), "utf8"),
      ) as Record<string, unknown>;

      for (const key of KEYS) {
        const line = key.split(".").reduce<unknown>((held, part) => (held as Record<string, unknown>)?.[part], messages);
        expect(typeof line, `${language} is missing ${key}`).toBe("string");
        expect((line as string).length).toBeGreaterThan(0);
      }

      const at = (key: string) =>
        key.split(".").reduce<unknown>((held, part) => (held as Record<string, unknown>)?.[part], messages) as string;
      expect(at("passport.attestations.verdict")).toContain("{bits}");
      expect(at("passport.attestations.verdict")).toContain("<apart>");
      expect(at("footer.status.gap")).toContain("{blocks, number}");
      expect(at("footer.status.inStep")).toContain("{block, number}");
      expect(at("studio.receipt.billedSponsored")).toContain("{gas, number}");
      expect(at("studio.receipt.wouldHaveCost")).toContain("{fee}");
    }
  });
});
