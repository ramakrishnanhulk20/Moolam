import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Attestation } from "@/lib/chain/registry";
import type { RecheckControl } from "@/lib/recheck/useRecheck";

/**
 * Who wrote a re-check, as every screen says it (R11).
 *
 * Four receivers carry a name: the two deployed on 2026-09-26, bound to the CRE
 * wallet, and the two they replaced, whose verdicts stay on chain under their
 * own address. Anything else the registry accepted is an unknown writer: its row
 * is shown with its numbers, it is never called Chainlink, and it is never
 * counted as a Chainlink re-check.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en", id: `0x${"7c".repeat(32)}` }) }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: async () => "simulation" }));
vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: { kind: "none" },
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));

const INDEX_URL = "https://index.example/v1/graphql";

type Receivers = typeof import("@/lib/chain/receivers");
let receivers: Receivers;
let Attestations: typeof import("@/components/passport/Attestations").Attestations;
let topFacts: typeof import("@/components/passport/top-facts").topFacts;
let chainlinkRecheck: typeof import("@/components/home/finding").chainlinkRecheck;
let attestationSource: typeof import("@/components/passport/labels").attestationSource;
let data: typeof import("@/lib/data/passports");

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_ENVIO_GRAPHQL_URL", INDEX_URL);
  receivers = await import("@/lib/chain/receivers");
  ({ Attestations } = await import("@/components/passport/Attestations"));
  ({ topFacts } = await import("@/components/passport/top-facts"));
  ({ chainlinkRecheck } = await import("@/components/home/finding"));
  ({ attestationSource } = await import("@/components/passport/labels"));
  data = await import("@/lib/data/passports");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NEW_PUBLIC = "0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95" as Hex;
const NEW_SEALED = "0x52b8fE549B432920eeB061c26cAc5c2D527657f6" as Hex;
const OLD_PUBLIC = "0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04" as Hex;
const OLD_SEALED = "0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A" as Hex;
const STRANGER = "0x00000000000000000000000000000000DeaDBeef" as Hex;

const PHASH = 0x6ccf137087789a25n;
const TX = `0x${"91".repeat(32)}` as Hex;
const words = en.passport.attestations;

const row = (receiver: Hex, at = 1_790_400_000n): Attestation => ({
  receiver,
  matched: true,
  distance: 1,
  recomputed: `0x${"0".repeat(48)}6ccf137087789a24` as Hex,
  at,
});

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

/** The one re-check row the card draws for these attestations, without the section's own intro around it. */
async function drawnRow(rows: Attestation[]): Promise<string> {
  const markup = render(
    await Attestations({
      attestations: rows,
      indexed: rows.map((one) => ({ txHash: TX, receiver: one.receiver, at: one.at, distance: one.distance })) as never,
      phash: PHASH,
      locale: "en",
    }),
  );
  const start = markup.indexOf("<li");
  return markup.slice(start, markup.indexOf("</li>", start) + 5);
}

const asRendered = (line: string): string => line.replace(/'/g, "&#x27;");

const say = {
  kind: () => "",
  agentNumber: (id: string) => `Agent ${id}`,
  cardNamed: (agent: string) => en.passport.facts.cardNamed.replace("{agent}", agent),
  statement: () => "",
  bits: (count: number) => `${count} of 64 bits`,
  privateRecheck: words.private.badge,
  testRun: en.mark.simulator.word,
  privateTestRun: words.private.testRun,
  sealed: en.passport.sealed.label,
  date: () => "Sep 26, 2026",
  words: en.passport.facts,
};

/** The strip's checked fact for one row, with the mark's reading of it handed in: the network's, or a run in the simulator. */
function recheckedFact(receiver: Hex, network = false): string {
  const facts = topFacts(
    {
      creator: STRANGER,
      agentId: 10249n,
      agentName: null,
      kind: 0,
      consent: null,
      attestations: [row(receiver)],
      verdicts: [{ at: 1_790_400_000, network }],
      phash: PHASH,
      sealed: false,
      privateRecheck: false,
    },
    say,
  );
  return facts[3].value;
}

describe("the two receivers deployed on 2026-09-26", () => {
  it("are on the chain client exactly as deployed", async () => {
    const { addresses } = await import("@/lib/chain/client");
    expect(addresses.simulationReceiver).toBe(NEW_PUBLIC);
    expect(addresses.sealedSimulationReceiver).toBe(NEW_SEALED);
  });

  it("name the public one as a Chainlink CRE re-check, in any letter case", async () => {
    for (const written of [NEW_PUBLIC, NEW_PUBLIC.toLowerCase(), `0x${NEW_PUBLIC.slice(2).toUpperCase()}`]) {
      expect(receivers.receiverRole(written)).toBe("public");
      expect(attestationSource(written)).toBe("chainlink");
    }
    const drawn = await drawnRow([row(NEW_PUBLIC)]);
    // Every report in this file comes through the simulator, so the row leads as a test run.
    expect(drawn).toContain(asRendered(words.byTestRun));
    expect(drawn).not.toContain(words.private.badge);
    expect(drawn).not.toContain(words.unknown.lead);
    expect(recheckedFact(NEW_PUBLIC)).toBe(`${en.mark.simulator.word}, Sep 26, 2026, 1 of 64 bits`);
    expect(recheckedFact(NEW_PUBLIC, true)).toBe("Chainlink, Sep 26, 2026, 1 of 64 bits");
  });

  it("name the sealed one as the private re-check", async () => {
    expect(receivers.receiverRole(NEW_SEALED.toLowerCase())).toBe("private");
    const drawn = await drawnRow([row(NEW_SEALED)]);
    expect(drawn).toContain(words.private.badge);
    expect(drawn).toContain(asRendered(words.private.leadEarlier));
    expect(drawn).not.toContain(words.unknown.lead);
    expect(recheckedFact(NEW_SEALED)).toBe(`${words.private.testRun}, Sep 26, 2026, 1 of 64 bits`);
    expect(recheckedFact(NEW_SEALED, true)).toBe(`${words.private.badge}, Sep 26, 2026, 1 of 64 bits`);
  });
});

describe("the two receivers taken off the policy on 2026-09-26", () => {
  it("keep their names for the verdicts they wrote", async () => {
    expect(receivers.receiverRole(OLD_PUBLIC)).toBe("public");
    expect(receivers.receiverRole(OLD_SEALED)).toBe("private");
    expect(await drawnRow([row(OLD_PUBLIC)])).toContain(asRendered(words.byTestRun));
    expect(await drawnRow([row(OLD_SEALED)])).toContain(words.private.badge);
    expect(recheckedFact(OLD_PUBLIC, true)).toBe("Chainlink, Sep 26, 2026, 1 of 64 bits");
  });
});

describe("a writer this app cannot name", () => {
  it("is shown, with its numbers and its address, as an unknown writer", async () => {
    expect(receivers.receiverRole(STRANGER)).toBe("unknown");
    expect(attestationSource(STRANGER)).toBe("other");

    const drawn = await drawnRow([row(STRANGER)]);
    expect(drawn).toContain(words.unknown.lead);
    expect(drawn).toContain(words.unknown.field);
    expect(drawn).toContain("1 of 64 bits");
    expect(drawn).toContain(`/address/${STRANGER}`);
    expect(drawn).toContain(`/tx/${TX}`);
  });

  it("is never given a Chainlink name, a Chainlink grid or a simulator line", async () => {
    const drawn = await drawnRow([row(STRANGER)]);
    expect(drawn).not.toContain("Chainlink");
    expect(drawn).not.toContain(words.byChainlink);
    expect(drawn).not.toContain(words.private.badge);
    expect(recheckedFact(STRANGER)).toBe(`${en.passport.facts.unknownWriter} 0x000000…Beef, Sep 26, 2026, 1 of 64 bits`);
  });

  it("keeps its row beside the named ones rather than being dropped", async () => {
    const markup = render(
      await Attestations({
        attestations: [row(NEW_PUBLIC, 1_790_400_000n), row(STRANGER, 1_790_400_100n)],
        indexed: [],
        phash: PHASH,
        locale: "en",
      }),
    );
    expect(markup.match(/<li/g)).toHaveLength(2);
    expect(markup).toContain(words.byChainlink);
    expect(markup).toContain(words.unknown.lead);
  });
});

describe("every count that means re-checked by Chainlink", () => {
  it("lists exactly the four named receivers", () => {
    expect(receivers.chainlinkReceivers().map(receivers.addressKey).sort()).toEqual(
      [NEW_PUBLIC, NEW_SEALED, OLD_PUBLIC, OLD_SEALED].map((one) => one.toLowerCase()).sort(),
    );
  });

  it("takes the first screen's re-check from any of the four, never from the unknown one", () => {
    for (const named of [NEW_PUBLIC, NEW_SEALED, OLD_PUBLIC, OLD_SEALED]) {
      const found = chainlinkRecheck([row(named.toLowerCase() as Hex, 1_790_400_000n)], receivers.chainlinkReceivers());
      expect(found, named).not.toBeNull();
    }
    expect(chainlinkRecheck([row(STRANGER)], receivers.chainlinkReceivers())).toBeNull();

    const newest = chainlinkRecheck(
      [row(OLD_PUBLIC, 1_790_000_000n), row(NEW_PUBLIC, 1_790_400_000n), row(STRANGER, 1_790_500_000n)],
      receivers.chainlinkReceivers(),
    );
    expect(newest?.at).toBe(1_790_400_000);
  });

  it("marks an Explore card as Chainlink for any of the four, and not for the unknown one", async () => {
    const card = (index: number, receiver: Hex) => ({
      id: `0x${index.toString(16).padStart(64, "0")}`,
      kind: 0,
      registeredAt: String(2_000 - index),
      registeredBlock: "42",
      metadataURI: `ipfs://picture-${index}`,
      manifestHash: `0x${"0".repeat(64)}`,
      disputed: false,
      attestationCount: 1,
      attestations: [{ receiver: receiver.toLowerCase() }],
      generator: null,
    });
    const rows = [card(1, NEW_PUBLIC), card(2, NEW_SEALED), card(3, OLD_PUBLIC), card(4, OLD_SEALED), card(5, STRANGER)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { Passport: rows } }) }) as unknown as Response),
    );

    const page = await data.explorePassports({ filter: {}, limit: 24 });
    expect(page.passports.map((one) => one.chainlink)).toEqual([true, true, true, true, false]);
    // The unknown writer's re-check still counts as a re-check, just not a Chainlink one.
    expect(page.passports[4].rechecked).toBe(true);
  });
});
