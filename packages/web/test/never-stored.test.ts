import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two pages the host keeps for a minute, and the one thing neither is allowed
 * to keep: a read that failed.
 *
 * A page rebuilt a minute at a time is handed to everyone who asks inside that
 * minute. So a passport page whose chain read failed once, or a verify page
 * with nothing to press because the story could not be read, would be the page
 * sixty seconds of visitors get. Asking for the connection takes that render
 * out of the store, exactly as components/explore/Sheet.tsx does: a build
 * leaves the page to be drawn on the request, and a refresh keeps the last good
 * page it has and tries again on the next one.
 *
 * What these do not cover: whether Next honours connection() inside a page that
 * declares revalidate. That is the framework's own contract and the Explore
 * sheet has relied on it since it shipped.
 */

const holds = vi.hoisted(() => ({
  connection: vi.fn(),
  record: vi.fn(),
  samples: vi.fn(),
}));

vi.mock("next/server", async (real) => ({
  ...(await real<typeof import("next/server")>()),
  connection: holds.connection,
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({ dateTime: () => "a day" }),
  setRequestLocale: () => undefined,
}));

vi.mock("@/lib/chain/registry", () => ({
  DisputeStatus: { Open: 0 },
  ZERO_ID: `0x${"0".repeat(64)}`,
  heldPassportRecord: holds.record,
}));

vi.mock("@/lib/chain/client", () => ({
  reason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@/lib/chain/consent", () => ({
  heldConsent: vi.fn(),
  heldConsentHistory: vi.fn(),
  heldMinInterval: vi.fn(),
  heldStandard: vi.fn(),
}));

vi.mock("@/lib/chain/time", () => ({ headTimestamp: vi.fn() }));
vi.mock("@/lib/data/source", () => ({ activeSource: () => "envio" }));
vi.mock("@/lib/data/lineage", () => ({ inheritedDisputed: vi.fn() }));
vi.mock("@/lib/data/passports", () => ({ heldRegistration: vi.fn() }));
vi.mock("@/lib/data/prerender", () => ({ realPictureIds: async () => [] }));
vi.mock("@/lib/data/offeredSamples", () => ({ offeredSamples: holds.samples }));

// The real reader always answers with a document, even when it is empty: the
// page reads fields off it, so a mock that answers nothing is not this reader.
vi.mock("@/components/passport/art", () => ({ readArt: vi.fn(async () => ({ missing: true })) }));
vi.mock("@/components/passport/Attestations", () => ({ Attestations: () => null }));
vi.mock("@/components/passport/CheckCopy", () => ({ CheckCopy: () => null }));
vi.mock("@/components/passport/DisputeNote", () => ({ DisputeNote: () => null }));
vi.mock("@/components/passport/DisputePanel", () => ({ DisputePanel: () => null }));
vi.mock("@/components/passport/EditPanel", () => ({ EditPanel: () => null }));
vi.mock("@/components/passport/Facts", () => ({ Facts: () => null }));
vi.mock("@/components/passport/indexed", () => ({ heldIndexedAttestations: vi.fn() }));
vi.mock("@/components/passport/labels", () => ({ standingOf: () => "clear" }));
vi.mock("@/components/passport/Lineage", () => ({ Lineage: () => null }));
vi.mock("@/components/passport/Poster", () => ({ Poster: () => null }));
vi.mock("@/components/consent/ConsentSection", () => ({ ConsentSection: () => null }));
vi.mock("@/components/consent/share", () => ({ shareDescription: () => "" }));
vi.mock("@/components/providers/WalletProvider", () => ({ WalletProvider: () => null }));
vi.mock("@/components/verify/VerifyScreen", () => ({ VerifyScreen: () => null }));
vi.mock("@/app/[locale]/passport/[id]/opengraph-image", () => ({ passportShareMetadata: () => ({}) }));

const { default: PassportPage } = await import("@/app/[locale]/passport/[id]/page");
const { default: VerifyPage } = await import("@/app/[locale]/verify/page");

const ID = `0x${"ab".repeat(32)}`;

beforeEach(() => {
  holds.connection.mockReset().mockResolvedValue(undefined);
  holds.record.mockReset();
  holds.samples.mockReset();
});

describe("a passport page whose chain read failed", () => {
  it("is never left in the page the host keeps, and still says what went wrong", async () => {
    holds.record.mockRejectedValue(new Error("the endpoint answered 503"));

    const page = await PassportPage({ params: Promise.resolve({ locale: "en", id: ID }) });

    expect(holds.connection).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(page)).toContain("error");
  });

  it("keeps a page whose read came back", async () => {
    holds.record.mockResolvedValue({
      passport: {
        id: ID,
        metadataURI: "ipfs://one",
        parentId: `0x${"0".repeat(64)}`,
        disputed: false,
        registeredAt: 1n,
      },
      attestations: [],
      edits: [],
      owner: `0x${"1".repeat(40)}`,
      dispute: null,
      hasPasskey: false,
    });

    await PassportPage({ params: Promise.resolve({ locale: "en", id: ID }) });

    expect(holds.connection).not.toHaveBeenCalled();
  });
});

describe("a verify page with nothing to press", () => {
  it("is never kept when the row is empty because the story could not be read", async () => {
    holds.samples.mockResolvedValue({ samples: [], error: "the Envio endpoint answered 502" });

    await VerifyPage({ params: Promise.resolve({ locale: "en" }) });

    expect(holds.connection).toHaveBeenCalledTimes(1);
  });

  it("is kept when the registry genuinely holds no pictures, which is a true page", async () => {
    holds.samples.mockResolvedValue({ samples: [], error: null });

    await VerifyPage({ params: Promise.resolve({ locale: "en" }) });

    expect(holds.connection).not.toHaveBeenCalled();
  });

  it("is kept when there are pictures to press", async () => {
    holds.samples.mockResolvedValue({ samples: [{ id: ID, url: "ipfs://one" }], error: null });

    await VerifyPage({ params: Promise.resolve({ locale: "en" }) });

    expect(holds.connection).not.toHaveBeenCalled();
  });
});
