import { describe, expect, it } from "vitest";
import { cardTitle, passportShareMetadata, registeredLine } from "@/app/[locale]/passport/[id]/opengraph-image";

/**
 * The words on the share card and in the passport page's head. The picture
 * itself is drawn by the renderer and checked on the running server; what is
 * worth pinning down here is that a record with no pinned name, no index answer
 * or no description still produces a card and a head that say something true.
 */

const ID = "0x75bf8bf1fb8b63ddffd92a7457d2fc2a236ce189468db9a4d45544012419c1a0";
const APP_LINE = "A passport for every AI generated image.";

describe("the title on the card", () => {
  it("is the name that was pinned", () => {
    expect(cardTitle("Mikasa", ID)).toBe("Mikasa");
  });

  it("falls back to the short id when nothing was pinned", () => {
    expect(cardTitle(undefined, ID)).toBe("Passport 0x75bf8b…c1a0");
  });

  it("treats a blank name as no name", () => {
    expect(cardTitle("   ", ID)).toBe("Passport 0x75bf8b…c1a0");
  });

  it("cuts a name too long to read at thumbnail size", () => {
    const long = "A very long pinned title that would run off the side of the card";
    expect(cardTitle(long, ID).length).toBeLessThanOrEqual(44);
    expect(cardTitle(long, ID).endsWith("...")).toBe(true);
  });
});

describe("the line under the title", () => {
  it("carries the block the index holds", () => {
    expect(registeredLine(103_595_929n, 1_789_038_756n)).toBe("Registered on Monad, block 103,595,929");
  });

  it("falls back to the chain's own registration time when the index has not caught up", () => {
    expect(registeredLine(null, 1_789_038_756n)).toBe("Registered on Monad, 10 Sept 2026");
  });

  it("says only what it knows when neither answered", () => {
    expect(registeredLine(null, null)).toBe("Registered on Monad");
  });
});

describe("the passport page's head", () => {
  const metadata = passportShareMetadata({
    locale: "en",
    id: ID,
    title: "Mikasa",
    description: "A photograph registered with Moolam.",
    fallbackDescription: APP_LINE,
  });

  it("names the record and the product", () => {
    expect(metadata.title).toBe("Mikasa on Moolam");
    expect(metadata.openGraph?.title).toBe("Mikasa on Moolam");
  });

  it("describes it in the words that were pinned", () => {
    expect(metadata.description).toBe("A photograph registered with Moolam.");
  });

  it("points the card at this passport's own image route, in this locale", () => {
    const images = metadata.openGraph?.images as { url: string; width: number; height: number }[];
    expect(images[0].url).toBe(`/en/passport/${ID}/opengraph-image`);
    expect(images[0].width).toBe(1200);
    expect(images[0].height).toBe(630);
  });

  it("asks X for the large card and hands it the twitter route", () => {
    const twitter = metadata.twitter as { card: string; images: string[] };
    expect(twitter.card).toBe("summary_large_image");
    expect(twitter.images[0]).toBe(`/en/passport/${ID}/twitter-image`);
  });

  it("keeps the locale of the page it belongs to", () => {
    const ja = passportShareMetadata({ locale: "ja", id: ID, fallbackDescription: APP_LINE });
    const images = ja.openGraph?.images as { url: string }[];
    expect(images[0].url).toBe(`/ja/passport/${ID}/opengraph-image`);
  });

  it("falls back to the product's own sentence when nothing was pinned", () => {
    const bare = passportShareMetadata({ locale: "en", id: ID, fallbackDescription: APP_LINE });
    expect(bare.title).toBe(`Passport 0x75bf8b…c1a0 on Moolam`);
    expect(bare.description).toBe(APP_LINE);
  });

  it("ignores a description that is only whitespace", () => {
    const blank = passportShareMetadata({ locale: "en", id: ID, description: "  ", fallbackDescription: APP_LINE });
    expect(blank.description).toBe(APP_LINE);
  });
});
