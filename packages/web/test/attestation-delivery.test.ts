import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import type { Attestation } from "@/lib/chain/registry";
import type { ReportDelivery } from "@/lib/chain/reports";

/**
 * The line under each verdict that says how the report arrived.
 *
 * Every re-check on chain today was written by one machine running the
 * workflow, so the card has to say that where a judge reads the verdict. The
 * label is never configured: it comes from the report transaction, and a row
 * whose transaction the index does not carry says nothing.
 */

const locale = { current: "en" as "en" | "ta" };
const delivery = { current: "simulation" as ReportDelivery };

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

const reads = vi.hoisted(() => ({ delivery: vi.fn() }));

vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: reads.delivery }));

const { Attestations } = await import("@/components/passport/Attestations");

const RECEIVER = "0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04" as Hex;
const REPORT_TX = "0x59e6a8d54cdf131dff73b539d74ba44ff665e4d02f95563fa9effeb1b9ee80fa" as Hex;
const REGISTERED = 0x6ccf137087789a25n;
const RECOMPUTED = `0x${"0".repeat(48)}6ccf137087789a25` as Hex;

const row: Attestation = {
  receiver: RECEIVER,
  matched: true,
  distance: 0,
  recomputed: RECOMPUTED,
  at: 1_789_368_639n,
};

async function card(indexed: { txHash: Hex; receiver: string; at: bigint; distance: number }[], language: "en" | "ta" = "en") {
  locale.current = language;
  return renderToStaticMarkup(
    await Attestations({ attestations: [row], indexed: indexed as never, phash: REGISTERED, locale: language }),
  );
}

const indexedRow = [{ txHash: REPORT_TX, receiver: RECEIVER, at: row.at, distance: 0 }];

/** React escapes an apostrophe in the rendered markup, the message file does not. */
function asRendered(line: string): string {
  return line.replace(/'/g, "&#x27;");
}

beforeEach(() => {
  reads.delivery.mockReset();
  reads.delivery.mockImplementation(async () => delivery.current);
});

describe("the delivery line under a verdict", () => {
  it("says a simulation run when the report came through the simulation forwarder", async () => {
    delivery.current = "simulation";
    const markup = await card(indexedRow);

    expect(markup).toContain(asRendered(en.passport.attestations.delivery.simulation));
    expect(markup).not.toContain(asRendered(en.passport.attestations.delivery.network));
    expect(reads.delivery).toHaveBeenCalledWith(REPORT_TX);
  });

  it("says a quorum reached consensus when the live network forwarder delivered it", async () => {
    delivery.current = "network";
    const markup = await card(indexedRow);

    expect(markup).toContain(asRendered(en.passport.attestations.delivery.network));
    expect(markup).not.toContain(asRendered(en.passport.attestations.delivery.simulation));
  });

  it("says nothing when the address is not one of the two forwarders", async () => {
    delivery.current = "unknown";
    const markup = await card(indexedRow);

    expect(markup).not.toContain(asRendered(en.passport.attestations.delivery.simulation));
    expect(markup).not.toContain(asRendered(en.passport.attestations.delivery.network));
  });

  it("asks the chain nothing for a row whose transaction the index does not carry", async () => {
    delivery.current = "simulation";
    const markup = await card([]);

    expect(reads.delivery).not.toHaveBeenCalled();
    expect(markup).not.toContain(asRendered(en.passport.attestations.delivery.simulation));
  });

  it("carries the same line in the reader's own language", async () => {
    delivery.current = "simulation";
    expect(await card(indexedRow, "ta")).toContain(asRendered(ta.passport.attestations.delivery.simulation));
  });

  it("names the workflow rather than claiming an independent network", async () => {
    delivery.current = "simulation";
    const markup = await card(indexedRow);

    expect(markup).toContain(en.passport.attestations.byChainlink);
    expect(markup).not.toContain("Verified independently");
    expect(markup).not.toContain("An independent network");
  });
});

describe("every language carries the two delivery lines", () => {
  const locales = readdirSync("messages")
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(".json", ""));

  it("is ten languages", () => {
    expect(locales.length).toBe(10);
  });

  for (const locale of locales) {
    it(`${locale} says how the report arrived, in its own words`, () => {
      const messages = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as {
        passport: { attestations: { delivery?: { simulation?: string; network?: string } } };
      };
      const delivery = messages.passport.attestations.delivery;
      expect(delivery?.simulation, `${locale}.delivery.simulation`).toBeTypeOf("string");
      expect(delivery?.network, `${locale}.delivery.network`).toBeTypeOf("string");
      expect(delivery!.simulation!.trim().length).toBeGreaterThan(0);
      expect(delivery!.network!.trim().length).toBeGreaterThan(0);
      // The word every one of these ten lines exists to keep honest.
      expect(delivery!.simulation).toContain("CRE");
    });
  }
});
