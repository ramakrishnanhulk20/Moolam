import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { beatTable, wordsCover } from "@/components/story/beats";
import { FILM_STYLE } from "@/components/story/room";

/**
 * The film's remaining walk items (WO-298): the field steps out from behind
 * the words, the Try panel offers the showcase set by title, the German
 * stated heading clears the tilted print, and the Tamil yourself heading fits
 * a phone.
 */

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

describe("row 16: the field steps out from behind the words", () => {
  const table = beatTable(["opening", "imagined", "sealed", "stated", "asked", "shared", "verified", "checked", "yourself", "offer", "close"]);

  it("names the side the words are on while a caption is up, and how far up it is", () => {
    const stated = table.beat.stated;
    const mid = stated.start + (stated.captionEnd - stated.start) * 0.5;
    expect(wordsCover(table, mid, false)).toEqual({ side: "end", cover: 1 });
    const checked = table.beat.checked;
    expect(wordsCover(table, checked.start + (checked.captionEnd - checked.start) * 0.5, false).side).toBe("end");
    const imagined = table.beat.imagined;
    expect(wordsCover(table, imagined.start + (imagined.captionEnd - imagined.start) * 0.5, false).side).toBe("start");
  });

  it("fades the clearing with the caption, so a print comes back as the words leave", () => {
    const sealed = table.beat.sealed;
    const leaving = sealed.captionEnd - table.fade * 0.5;
    const half = wordsCover(table, leaving, false);
    expect(half.side).toBe("start");
    expect(half.cover).toBeGreaterThan(0.3);
    expect(half.cover).toBeLessThan(0.7);
  });

  it("clears nothing on the opening wall, in the offer, on the close, or on a phone", () => {
    expect(wordsCover(table, 0.01, false)).toEqual({ side: null, cover: 0 });
    const offer = table.beat.offer;
    expect(wordsCover(table, offer.start + (offer.end - offer.start) * 0.5, false)).toEqual({ side: null, cover: 0 });
    expect(wordsCover(table, 0.95, false)).toEqual({ side: null, cover: 0 });
    const stated = table.beat.stated;
    expect(wordsCover(table, stated.start + (stated.captionEnd - stated.start) * 0.5, true)).toEqual({ side: null, cover: 0 });
  });

  it("is read by every field plate and every copy left on the wall, never by the traveller", () => {
    const field = source("components/story/scene/field.tsx");
    expect(field).toContain("fadeRef.current * clear");
    expect(field).toContain("clear = clearing(clearRef.current, node, camera);");
    expect(field).toContain("* (1 - away) * clear);");
    const copy = field.slice(field.indexOf("if (!spec.returns) {"), field.indexOf("// Home, its crushed pixels"));
    expect(copy.slice(copy.indexOf("} else {"))).not.toContain("clearing(");
    expect(source("components/story/LandingStory.tsx")).toContain("wordsCover(table, t, framing < 1)");
  });
});

describe("row 17: the Try panel offers the showcase set by title", () => {
  it("reads the three picks with the story and hands them to the one rule both panels use", () => {
    const data = source("components/story/data.ts");
    expect(data).toContain('from "@/lib/data/showcase"');
    expect(data).toContain("picked?: PickedPlate[]");
    expect(data).toContain("SHOWCASE.map((pick) =>");
    expect(source("components/story/LandingStory.tsx")).toContain("pickSamples(data.plates, {}, 3, data.picked ?? [])");
  });
});

describe("rows 20 and 21: the headings fit", () => {
  it("holds the stated beat's column to the right of the tilted print on a laptop", () => {
    expect(source("components/story/words.tsx")).toContain('"sm:-translate-y-[9vh] sm:ms-auto sm:max-w-[38vw]"');
  });

  it("sets Tamil smaller on a phone and lets a word wider than the column break", () => {
    const ta = FILM_STYLE.slice(FILM_STYLE.indexOf('html:lang(ta) .film-lower [data-story-line="title"]'));
    expect(ta).toContain("overflow-wrap: anywhere;");
    // The whole column, not the Latin headings' 17ch, which shrinks with the font and broke Tamil words.
    expect(ta).toMatch(/html:lang\(ta\) \.film-lower \[data-story-line="title"\] \{\s*max-width: none;\s*font-size: 1\.3rem;/);
    expect(ta).toMatch(/html:lang\(ta\) \.film-lower \[data-story-line="body"\] \{\s*font-size: 0\.85rem;/);
    expect(FILM_STYLE.indexOf("@media (max-width: 639px)")).toBeLessThan(FILM_STYLE.indexOf('html:lang(ta) .film-lower'));
  });
});
