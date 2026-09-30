import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { Consent, ConsentEntry } from "@/lib/chain/consent";
import type { Passport } from "@/lib/chain/registry";
import type { ExplorePlate } from "@/components/explore/sort";
import { loadPlatforms, onboardingTypedData, type PlatformList, type PlatformRecord } from "@/lib/platforms/platforms";

/**
 * The platform kit's words on the website (WO-245a): who registered a passport
 * and who holds it, whose terms are in force, and a platform's name only where
 * Moolam's signed list gives it. Since WO-257 the person who imagined a
 * platform picture is the one credited, and the platform is only where it was
 * drawn.
 *
 * The lists here are real: every entry is signed by viem local accounts over
 * the onboarding message and loaded through the same loadPlatforms the site
 * uses, so a label in these tests is a label the site would draw.
 *
 * Not covered: the live index and chain (every read is a fixture), a real
 * browser's local storage (a map stands in for it), and how the lines sit at
 * 375 px, which is checked by eye on the dev server.
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

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

const { Facts } = await import("@/components/passport/Facts");
const { ConsentSection } = await import("@/components/consent/ConsentSection");
const { Plate } = await import("@/components/explore/Plate");
const { HeldGrid } = await import("@/components/mine/HeldPictures");
const { ClaimedPictures } = await import("@/components/mine/ClaimedPictures");
const { readHidden, splitClaimed, splitHeld, writeHidden, hiddenKey } = await import("@/components/mine/held");
const { creditFrom, heldPlatformList, labelFrom, listedAgentOwner, plateMark } = await import("@/lib/data/platform-label");
const { fileTermsOf, termsDiffer } = await import("@/lib/data/file-terms");
const { shortHex } = await import("@/lib/chain/client");
const { topFacts } = await import("@/components/passport/top-facts");
const { Filters } = await import("@/components/explore/Filters");

const agentOwner = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const creatorKey = privateKeyToAccount(`0x${"b2".repeat(32)}`);
const HOLDER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
/** A person who co-signed with their own key: not a listed wallet. */
const PERSON = privateKeyToAccount(`0x${"d4".repeat(32)}`).address;

const PLATFORM = "Acme Studio";
const CARD_NAME = "Totally Real Corp";
const AGENT_ID = 4242n;
const VALID_FROM = 1_790_000_000n;

async function signedEntry(overrides: { validTo?: number } = {}): Promise<PlatformRecord> {
  const message = {
    name: PLATFORM,
    agentId: AGENT_ID,
    agentOwner: agentOwner.address,
    creatorWallet: creatorKey.address,
    keyHash: `0x${"c3".repeat(32)}` as Hex,
    origins: ["https://acme.example"],
    validFrom: VALID_FROM,
  };
  const typed = onboardingTypedData(message);
  return {
    name: PLATFORM,
    agentId: AGENT_ID.toString(),
    ownerAtOnboarding: agentOwner.address,
    creatorWallet: creatorKey.address,
    keyHash: message.keyHash,
    origins: message.origins,
    validFrom: Number(VALID_FROM),
    ...(overrides.validTo === undefined ? {} : { validTo: overrides.validTo }),
    acceptedAt: Number(VALID_FROM) + 60,
    ownerSignature: (await agentOwner.signTypedData(typed)).toLowerCase(),
    creatorSignature: (await creatorKey.signTypedData(typed)).toLowerCase(),
  };
}

async function signedList(): Promise<PlatformList> {
  const list = await loadPlatforms([await signedEntry()]);
  expect(list.ok, list.ok ? "" : list.reason).toBe(true);
  return list;
}

const ID = `0x${"7c".repeat(32)}` as Hex;
const MANIFEST = `0x${"22".repeat(32)}` as Hex;
const ZERO = `0x${"00".repeat(32)}` as Hex;

function passportOf(overrides: Partial<Passport>): Passport {
  return {
    id: ID,
    exactHash: ID,
    parentId: ZERO,
    creator: creatorKey.address,
    generatorAgentId: AGENT_ID,
    phash: 0x6ccf137087789a25n,
    blockhash256: `0x${"11".repeat(32)}` as Hex,
    manifestHash: MANIFEST,
    kind: 0,
    fingerprintVersion: 1,
    registeredAt: VALID_FROM + 3_600n,
    disputed: false,
    metadataURI: "ipfs://bafkreimetadata",
    ...overrides,
  };
}

const art: Art = { title: "Kites at dusk", missing: false };

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

function words(key: string, values?: Record<string, string | number>): string {
  return asRendered(createTranslator({ locale: "en", messages: en, namespace: "passport" })(key as never, values as never));
}

async function drawFacts(
  passport: Passport,
  list: PlatformList,
  extra: { owner?: Hex; agentName?: string | null; agentOwnerNow?: string | null } = {},
) {
  const owner = extra.owner ?? passport.creator;
  return render(
    await Facts({
      passport,
      art,
      owner,
      hasPasskey: true,
      standing: "unverified",
      txHash: null,
      platform: labelFrom(list, passport),
      // The same rule the page reads, handed in so the fixture list is the one asked.
      credit: creditFrom(list, { ...passport, holder: owner, agentOwnerNow: extra.agentOwnerNow ?? null }),
      agentName: extra.agentName ?? null,
    }),
  );
}

describe("P16: one predicate issues the label", () => {
  it("reads a listed wallet's Captured passport as registered outside the kit", async () => {
    const list = await signedList();
    const captured = passportOf({ kind: 1, generatorAgentId: 0n, manifestHash: ZERO });

    expect(labelFrom(list, captured)?.status).toBe("outsideKit");
    const markup = await drawFacts(captured, list);
    expect(markup).toContain('data-platform="outsideKit"');
    expect(markup).toContain(words("platform.outsideKit", { platform: PLATFORM }));
    expect(markup).not.toContain(words("platform.held", { platform: PLATFORM }));
    expect(markup).not.toContain("data-credit-line");
    // The base words stand on their own beside it.
    expect(markup).toContain(words("passkeyBound"));
    // A plate never wears the name for it.
    expect(plateMark(list, captured, null)).toBeNull();
  });

  it("gives a valid platform passport the unclaimed credit and its note, on the page and on a plate", async () => {
    const list = await signedList();
    const made = passportOf({});

    expect(labelFrom(list, made)?.status).toBe("kit");
    const markup = await drawFacts(made, list);
    expect(markup).toContain('data-platform="unclaimed"');
    expect(markup).toContain(words("platform.held", { platform: PLATFORM }));
    expect(markup).toContain(words("platform.heldNote", { platform: PLATFORM }));
    expect(markup).toContain(words("passkeyBound"));

    const mark = plateMark(list, made, null);
    expect(mark).toBe(PLATFORM);
    const plate: ExplorePlate = {
      id: ID,
      kind: 0,
      registeredAt: Number(made.registeredAt),
      title: "Kites at dusk",
      thumbnailUrl: null,
      manifest: true,
      rechecked: false,
      chainlink: false,
      disputed: false,
      agentId: AGENT_ID.toString(),
      consent: null,
      platform: mark,
    };
    expect(render(createElement(Plate, { plate }))).toContain(`Drawn on ${PLATFORM}`);
    expect(render(createElement(Plate, { plate: { ...plate, platform: null } }))).not.toContain("data-plate-platform");
  });

  it("drops the label for a passport registered before the entry's window opened", async () => {
    const list = await signedList();
    expect(labelFrom(list, passportOf({ registeredAt: VALID_FROM - 1n }))?.status).toBe("outsideKit");
  });
});

describe("WO-245b item 2: the credit sentence is said once", () => {
  it("draws the credit sentence beside the creator only, and the listed line in the agent part", async () => {
    const list = await signedList();
    const markup = await drawFacts(passportOf({}), list, { agentName: CARD_NAME });
    const held = words("platform.held", { platform: PLATFORM });
    expect(markup.split(held)).toHaveLength(2);
    expect(markup).toContain(words("agentListed", { platform: PLATFORM }));
  });
});

describe("WO-245b item 3: the facts strip keeps the two names apart", () => {
  const say = {
    kind: (kind: number) => en.kind[String(kind) as "0" | "1" | "2"],
    agentNumber: (id: string) => words("agentNumber", { id }),
    cardNamed: (agent: string) => words("facts.cardNamed", { agent }),
    statement: (statement: string) => en.passport.consent.summary[statement as "closed"],
    bits: (count: number) => `${count} of 64 bits`,
    privateRecheck: en.passport.attestations.private.badge,
    sealed: en.passport.sealed.label,
    date: () => "Sep 27, 2026",
    heldBy: (platform: string) => words("facts.heldBy", { platform }),
    via: (platform: string) => words("facts.via", { platform }),
    words: en.passport.facts,
  };
  const input = {
    creator: creatorKey.address,
    agentId: AGENT_ID,
    agentName: CARD_NAME,
    kind: 0,
    consent: null,
    attestations: [],
    phash: 0x6ccf137087789a25n,
    sealed: false,
    privateRecheck: false,
  };

  it("marks a card's name as the card's own word under Drawn by", () => {
    const [, drawn] = topFacts(input, say);
    expect(drawn.value).toBe(CARD_NAME);
    expect(drawn.detail).toBe(`Agent ${AGENT_ID}, named by its own card`);
  });

  it("says Not claimed yet on an unclaimed platform passport, with the platform only as its holder", async () => {
    const list = await signedList();
    const credit = creditFrom(list, { ...passportOf({}), holder: creatorKey.address, agentOwnerNow: null });
    expect(credit?.case).toBe("unclaimed");
    const [made] = topFacts({ ...input, credit }, say);
    expect(made.value).toBe("Not claimed yet");
    expect(made.detail).toBe(`${PLATFORM} holds it`);
    expect(made.mono).toBeUndefined();
  });

  it("names the holder on a claimed platform passport, via the platform", async () => {
    const list = await signedList();
    const credit = creditFrom(list, { ...passportOf({}), holder: HOLDER.toLowerCase(), agentOwnerNow: null });
    expect(credit?.case).toBe("claimed");
    const [made] = topFacts({ ...input, credit }, say);
    expect(made.value).toBe(shortHex(HOLDER));
    expect(made.detail).toBe(`via ${PLATFORM}`);
    expect(made.mono).toBe(true);
  });

  it("leaves Made by as the creator's address on a co-signed passport and on every other one", async () => {
    const list = await signedList();
    const cosigned = creditFrom(list, { ...passportOf({ creator: PERSON }), holder: PERSON, agentOwnerNow: agentOwner.address });
    expect(cosigned?.case).toBe("cosigned");
    const [person] = topFacts({ ...input, creator: PERSON, credit: cosigned }, say);
    expect(person.value).toBe(shortHex(PERSON));
    expect(person.detail).toBeUndefined();
    expect(person.mono).toBe(true);

    for (const credit of [null, undefined]) {
      const [made] = topFacts({ ...input, credit }, say);
      expect(made.value).toBe(shortHex(creatorKey.address));
      expect(made.detail).toBeUndefined();
      expect(made.mono).toBe(true);
    }
  });
});

describe("P14: the listed name and the card's own name are two facts", () => {
  it("draws them in two separate lines and never joins them", async () => {
    const list = await signedList();
    const markup = await drawFacts(passportOf({}), list, { agentName: CARD_NAME });

    const listed = /<p data-agent-listed[^>]*>(.*?)<\/p>/.exec(markup)?.[1] ?? "";
    const declared = /<p data-agent-self-declared[^>]*>(.*?)<\/p>/.exec(markup)?.[1] ?? "";
    expect(listed).toContain(words("agentListed", { platform: PLATFORM }));
    expect(listed).not.toContain(CARD_NAME);
    expect(declared).toBe(words("agentSelfDeclared", { name: CARD_NAME }));
    expect(declared).not.toContain(PLATFORM);
  });

  it("keeps the card's name, labelled self-declared, when there is no list at all", async () => {
    const refused: PlatformList = { ok: false, platforms: [], reason: "fixture" };
    const markup = await drawFacts(passportOf({}), refused, { agentName: CARD_NAME });
    expect(markup).not.toContain("data-agent-listed");
    expect(markup).toContain(words("agentSelfDeclared", { name: CARD_NAME }));
  });
});

describe("P23: holder and creator are two facts", () => {
  it("says registered by one wallet and held by another when they differ", async () => {
    const list = await signedList();
    // Captured by the listed wallet: no credit case, so the plain differs line is the one that tells it.
    const captured = passportOf({ kind: 1, generatorAgentId: 0n, manifestHash: ZERO });
    const markup = await drawFacts(captured, list, { owner: HOLDER });
    expect(markup).toContain(
      words("holder.differs", { creator: shortHex(creatorKey.address), holder: shortHex(HOLDER) }),
    );
  });

  it("never repeats a claimed passport's handover as the differs line", async () => {
    const list = await signedList();
    const markup = await drawFacts(passportOf({}), list, { owner: HOLDER });
    expect(markup).toContain('data-platform="claimed"');
    expect(markup).not.toContain("data-holder-differs");
  });

  it("says nothing extra when the creator still holds it, whatever the address case", async () => {
    const list = await signedList();
    const markup = await drawFacts(passportOf({}), list, { owner: creatorKey.address.toLowerCase() as Hex });
    expect(markup).not.toContain("data-holder-differs");
  });
});

describe("P24: the chain's terms are in force, and a file that differs is shown", () => {
  const CLOSED: Consent = {
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "notAllowed",
    dataMining: "notAllowed",
  };

  function consentOf(writer: Hex, consent: Consent): { entry: ConsentEntry; record: Parameters<typeof ConsentSection>[0]["record"] } {
    const entry: ConsentEntry = { at: VALID_FROM + 3_700n, writer, consent, constraintInfo: "" };
    return {
      entry,
      record: {
        reading: { stated: true, entry },
        history: [entry],
        standard: "cawg.training-mining/1.1",
        minInterval: 600,
        now: Number(VALID_FROM) + 7_200,
      },
    };
  }

  it("draws the file's terms as stated at generation, the differs line, and the chain's statement in force", () => {
    const file = fileTermsOf({ aiTraining: "allowed", aiGenerativeTraining: "allowed", aiInference: "allowed", dataMining: "allowed", standard: "cawg.training-mining/1.1" });
    expect(file).not.toBeNull();
    const { entry, record } = consentOf(creatorKey.address, CLOSED);
    expect(termsDiffer(file!, entry)).toBe(true);

    const markup = render(
      createElement(ConsentSection, {
        id: ID,
        owner: creatorKey.address,
        registeredAt: Number(VALID_FROM),
        record,
        platform: { name: PLATFORM, wallet: creatorKey.address },
        fileTerms: file,
      }),
    );
    const consent = createTranslator({ locale: "en", messages: en, namespace: "passport.consent" });
    expect(markup).toContain("data-file-terms");
    expect(markup).toContain(consent("atGeneration"));
    expect(markup).toContain(asRendered(consent("differs")));
    // The headline under "In force today" is the chain's closed statement, not the file's open one.
    const headline = /<p data-consent-headline[^>]*>(.*?)<\/p>/.exec(markup)?.[1];
    expect(headline).toBe(consent("summary.closed"));
    expect(markup).toContain(consent("inForceToday"));
    // The platform wrote the statement that stands, so the holder is told whose words these are,
    // with no claim about when they were written (WO-245b item 1).
    const standing = consent("platformStanding", { platform: PLATFORM });
    expect(standing).toBe(`${PLATFORM} stated these terms. They stand until whoever holds the passport states new ones.`);
    expect(markup).toContain(asRendered(standing));
  });

  it("shows no second set of terms when the file and the chain agree, and no platform line for the holder's own statement", () => {
    const file = fileTermsOf(CLOSED);
    const { entry, record } = consentOf(HOLDER, CLOSED);
    expect(termsDiffer(file!, entry)).toBe(false);

    const markup = render(
      createElement(ConsentSection, {
        id: ID,
        owner: HOLDER,
        registeredAt: Number(VALID_FROM),
        record,
        platform: { name: PLATFORM, wallet: creatorKey.address },
        fileTerms: file,
      }),
    );
    expect(markup).not.toContain("data-file-terms");
    expect(markup).not.toContain("data-platform-standing");
  });

  it("reads a file statement in a word outside the standard as no statement rather than half of one", () => {
    expect(fileTermsOf({ aiTraining: "maybe" })).toBeNull();
    expect(fileTermsOf(undefined)).toBeNull();
    expect(fileTermsOf({})).toBeNull();
  });
});

describe("P25: a held passport is never shown as made, and can be hidden", () => {
  const row = {
    id: `0x${"9e".repeat(32)}` as Hex,
    kind: 0,
    registeredAt: VALID_FROM,
    registeredBlock: 1n,
    metadataURI: "ipfs://bafkreiheld",
    title: "A gift",
  };
  const other = { ...row, id: `0x${"8d".repeat(32)}` as Hex, title: "Another gift" };

  it("labels every held row as held and offers Hide on each", () => {
    const markup = render(
      createElement(HeldGrid, { rows: [row, other], hiddenCount: 0, onHide: () => undefined, onShowHidden: () => undefined }),
    );
    const held = createTranslator({ locale: "en", messages: en, namespace: "mine.held" });
    expect(markup.match(/data-held-label/g)).toHaveLength(2);
    expect(markup).toContain(asRendered(held("label")));
    expect(markup.match(/data-held-hide/g)).toHaveLength(2);
    expect(markup).not.toContain(en.mine.heading);
    expect(markup).not.toContain("data-held-show-hidden");
  });

  it("puts its own heading over the held grid, before any card (WO-245b item 4)", () => {
    const markup = render(
      createElement(HeldGrid, { rows: [row], hiddenCount: 0, onHide: () => undefined, onShowHidden: () => undefined }),
    );
    const heading = /<h2 id="mine-held-heading"[^>]*>(.*?)<\/h2>/.exec(markup)?.[1];
    expect(heading).toBe(en.mine.held.heading);
    expect(markup.indexOf("mine-held-heading")).toBeLessThan(markup.indexOf("data-held-label"));
    expect(markup).toContain('aria-labelledby="mine-held-heading"');
  });

  it("sets Hide in a column of its own beside the title, so the longest language never runs over it (WO-253)", async () => {
    const de = (await import("@/messages/de.json")).default;
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { locale: "de", messages: de, timeZone: "UTC" },
        createElement(HeldGrid, { rows: [row], hiddenCount: 0, onHide: () => undefined, onShowHidden: () => undefined }),
      ),
    );
    const classOf = (marker: string) => new RegExp(`<[a-z]+ [^>]*${marker}[^>]*class="([^"]*)"`).exec(markup)?.[1].split(" ") ?? [];
    const card = /<li data-held="[^"]*"[^>]*class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
    const link = /<a href="\/passport\/[^"]*" class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
    const text = classOf("data-held-text");
    const hide = classOf("data-held-hide");

    expect(markup).toContain(`>${de.mine.held.hide}</button>`);
    expect(card).toEqual(expect.arrayContaining(["grid", "grid-cols-[minmax(0,1fr)_auto]", "gap-x-4"]));
    // Both placed by line number: an auto-placed link would be pushed below the button's cell instead of lying under it.
    expect(link).toEqual(expect.arrayContaining(["col-[1/-1]", "row-[1/-1]", "grid-cols-subgrid", "grid-rows-subgrid"]));
    // The title's column may shrink to nothing; the button's column is its own width and never shrinks.
    expect(text).toContain("min-w-0");
    expect(text.some((name) => /^(pe|pr)-/.test(name))).toBe(false);
    expect(hide).toEqual(expect.arrayContaining(["col-start-2", "row-start-2", "shrink-0", "whitespace-nowrap"]));
    expect(hide.some((name) => /^(absolute|fixed|end-|bottom-)/.test(name))).toBe(false);
  });

  it("keeps a hidden row out of view per wallet, counts it, and brings it back", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };

    writeHidden(storage, HOLDER, new Set([row.id]));
    expect(store.has(hiddenKey(HOLDER.toLowerCase()))).toBe(true);
    const hidden = readHidden(storage, HOLDER);
    const { shown, hiddenCount } = splitHeld([row, other], hidden);
    expect(shown.map((one) => one.id)).toEqual([other.id]);
    expect(hiddenCount).toBe(1);
    // Another wallet in the same browser keeps its own list.
    expect(readHidden(storage, creatorKey.address).size).toBe(0);

    const markup = render(
      createElement(HeldGrid, { rows: shown, hiddenCount, onHide: () => undefined, onShowHidden: () => undefined }),
    );
    expect(markup).toContain("Show 1 hidden picture");

    writeHidden(storage, HOLDER, new Set());
    expect(splitHeld([row, other], readHidden(storage, HOLDER)).hiddenCount).toBe(0);
  });

  it("reads a damaged store as nothing hidden", () => {
    const storage = { getItem: () => "{not json" };
    expect(readHidden(storage, HOLDER).size).toBe(0);
    expect(readHidden({ getItem: () => JSON.stringify(["not an id", 3]) }, HOLDER).size).toBe(0);
  });
});

describe("P15: without the list the base words stand and no label shows", () => {
  it("refuses a tampered list whole, and a refused list labels nothing", async () => {
    const entry = await signedEntry();
    const tampered = await loadPlatforms([{ ...entry, name: "Acme Studios" }]);
    expect(tampered.ok).toBe(false);

    const made = passportOf({});
    expect(labelFrom(tampered, made)).toBeNull();
    expect(plateMark(tampered, made, null)).toBeNull();
    expect(creditFrom(tampered, { ...made, holder: HOLDER, agentOwnerNow: agentOwner.address })).toBeNull();

    const markup = await drawFacts(made, tampered);
    expect(markup).not.toContain("data-platform");
    expect(markup).toContain(words("passkeyBound"));
    // The base words never claim a device, a person or two parties.
    expect(words("passkeyBound")).not.toMatch(/device|phone|biometric|human|person|two parties/i);
  });

  it("loads the shipped list once and answers from it", async () => {
    const first = heldPlatformList();
    expect(heldPlatformList()).toBe(first);
    const list = await first;
    expect(list.ok).toBe(true);
    // The shipped list is empty until the first platform is onboarded.
    expect(labelFrom(list, passportOf({}))).toBeNull();
  });
});

describe("WO-245b item 5: the legend names the platform mark", () => {
  it("says what the platform line means, with the plate's own small mark, after the other lines", () => {
    const markup = render(createElement(Filters, { search: { view: "pictures" as const, search: "", agent: null, ai: null } }));
    const line = /<span data-legend-platform[^>]*>(.*?)<\/span><\/p>/.exec(markup)?.[1] ?? "";
    expect(line).toContain("motif");
    expect(line).toContain(en.explore.legend.platform);
    expect(markup.indexOf(en.explore.legend.consent)).toBeLessThan(markup.indexOf(en.explore.legend.platform));
  });

  it("says the platform is where a picture was drawn (WO-257)", () => {
    expect(en.explore.legend.platform).toBe("Drawn on a platform Moolam lists");
  });
});

describe("WO-257: the person who imagined a platform picture is credited, never the platform", () => {
  it("credits the holder a platform handed the passport to, with the note on what the credit rests on", async () => {
    const list = await signedList();
    const markup = await drawFacts(passportOf({}), list, { owner: HOLDER, agentName: CARD_NAME });
    const line = /<p data-credit-line[^>]*>(.*?)<\/p>/.exec(markup)?.[1] ?? "";
    expect(line).toContain(`Imagined by ${shortHex(HOLDER)}. Drawn on ${PLATFORM}, which handed the passport to them.`);
    expect(markup).toContain(words("platform.claimedNote", { platform: PLATFORM }));
    expect(markup).toContain(words("agentListed", { platform: PLATFORM }));
  });

  it("credits the person who co-signed with their own key, and names the platform's agent as the one that drew it", async () => {
    const list = await signedList();
    const cosigned = passportOf({ creator: PERSON });
    expect(labelFrom(list, cosigned)).toBeNull();

    const markup = await drawFacts(cosigned, list, { agentOwnerNow: agentOwner.address, agentName: CARD_NAME });
    expect(markup).toContain('data-platform="cosigned"');
    const line = /<p data-credit-line[^>]*>(.*?)<\/p>/.exec(markup)?.[1] ?? "";
    expect(line).toContain(asRendered(`Imagined by ${shortHex(PERSON)}. Drawn by ${PLATFORM}'s agent.`));
    expect(markup).toContain(words("platform.cosignedNote"));
    expect(markup).toContain(words("agentListed", { platform: PLATFORM }));
    // The card's own name stays a separate, self-declared fact below it (P14).
    expect(markup.indexOf("data-agent-listed")).toBeLessThan(markup.indexOf("data-agent-self-declared"));
  });

  it("says nothing about a co-signed picture whose agent changed owner since onboarding, nor lists the agent", async () => {
    const list = await signedList();
    const cosigned = passportOf({ creator: PERSON });
    for (const agentOwnerNow of [HOLDER, null]) {
      const markup = await drawFacts(cosigned, list, { agentOwnerNow, agentName: CARD_NAME });
      expect(markup).not.toContain("data-credit-line");
      expect(markup).not.toContain("data-platform");
      expect(markup).not.toContain("data-agent-listed");
      expect(markup).toContain(words("agentSelfDeclared", { name: CARD_NAME }));
    }
  });

  it("gives a claimed passport a credit only when its holder was read", async () => {
    const list = await signedList();
    expect(creditFrom(list, { ...passportOf({}), holder: null, agentOwnerNow: agentOwner.address })).toBeNull();
    // An agent the list does not name is never read for its owner.
    expect(await listedAgentOwner(list, 7n)).toBeNull();
    expect(await listedAgentOwner(list, 0n)).toBeNull();
  });

  it("marks a plate Drawn on the platform for every credit case, and for no other passport", async () => {
    const list = await signedList();
    const cosigned = passportOf({ creator: PERSON });
    expect(plateMark(list, passportOf({}), null)).toBe(PLATFORM);
    expect(plateMark(list, cosigned, agentOwner.address)).toBe(PLATFORM);
    expect(plateMark(list, cosigned, HOLDER)).toBeNull();
    expect(plateMark(list, cosigned, null)).toBeNull();
    expect(plateMark(list, passportOf({ creator: PERSON, generatorAgentId: 7n }), agentOwner.address)).toBeNull();

    const plate: ExplorePlate = {
      id: ID,
      kind: 0,
      registeredAt: Number(cosigned.registeredAt),
      title: "Kites at dusk",
      thumbnailUrl: null,
      manifest: true,
      rechecked: false,
      chainlink: false,
      disputed: false,
      agentId: AGENT_ID.toString(),
      consent: null,
      platform: PLATFORM,
    };
    const mark = /<span data-plate-platform[^>]*>([\s\S]*?)<\/span><\/span>/.exec(render(createElement(Plate, { plate })))?.[1] ?? "";
    expect(mark).toContain(`Drawn on ${PLATFORM}`);
    expect(mark).not.toMatch(/registered|made by/i);
  });

  it("reads no kit or kitNote key anywhere, in any language", async () => {
    for (const lang of ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"]) {
      const messages = (await import(`@/messages/${lang}.json`)).default as typeof en;
      expect(Object.keys(messages.passport.platform), lang).not.toContain("kit");
      expect(Object.keys(messages.passport.platform), lang).not.toContain("kitNote");
    }
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    for (const path of ["components/passport/Facts.tsx", "components/passport/TopFacts.tsx", "components/passport/top-facts.ts"]) {
      const text = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
      expect(text, path).not.toMatch(/platform\.kit(Note)?["`]/);
    }
  });
});

describe("WO-257: a platform's handover sits with the person's own pictures on /mine", () => {
  const listing = {
    id: `0x${"9e".repeat(32)}` as Hex,
    kind: 0,
    registeredAt: VALID_FROM + 3_600n,
    registeredBlock: 1n,
    metadataURI: "ipfs://bafkreiheld",
    creator: creatorKey.address,
    generatorAgentId: AGENT_ID,
    manifestHash: MANIFEST,
  };
  const gift = { ...listing, id: `0x${"8d".repeat(32)}` as Hex, creator: PERSON };
  const captured = { ...listing, id: `0x${"6b".repeat(32)}` as Hex, kind: 1, generatorAgentId: 0n, manifestHash: ZERO };

  it("moves only the claimed handover out of the held rows, whatever the wallet's address case", async () => {
    const list = await signedList();
    const { claimed, held } = splitClaimed([listing, gift, captured], list, HOLDER.toLowerCase());
    expect(claimed.map((row) => [row.id, row.platform])).toEqual([[listing.id, PLATFORM]]);
    expect(held.map((row) => row.id)).toEqual([gift.id, captured.id]);

    const refused: PlatformList = { ok: false, platforms: [], reason: "fixture" };
    expect(splitClaimed([listing, gift], refused, HOLDER).claimed).toEqual([]);
  });

  it("draws the handover with the line that says where it was drawn, and keeps it out of the held grid", async () => {
    const list = await signedList();
    const { claimed, held } = splitClaimed([listing, gift], list, HOLDER);

    const mine = createTranslator({ locale: "en", messages: en, namespace: "mine" });
    const own = render(createElement(ClaimedPictures, { rows: claimed }));
    expect(own).toContain(`data-claimed="${listing.id}"`);
    expect(own).toContain(asRendered(mine("claimedLine", { platform: PLATFORM })));
    expect(mine("claimedLine", { platform: PLATFORM })).toBe(`Drawn on ${PLATFORM}, which handed the passport to you.`);
    expect(own).not.toContain("data-held-label");
    expect(own).not.toContain("data-held-hide");

    const others = render(createElement(HeldGrid, { rows: held, hiddenCount: 0, onHide: () => undefined, onShowHidden: () => undefined }));
    expect(others).not.toContain(`data-held="${listing.id}"`);
    expect(others).toContain(`data-held="${gift.id}"`);
    expect(render(createElement(ClaimedPictures, { rows: [] }))).not.toContain("data-mine-claimed");
  });
});
