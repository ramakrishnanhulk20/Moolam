import { describe, expect, it } from "vitest";
import { OPENING_PICTURES, fieldPictures, fieldPlates, plateSpots } from "@/components/story/scene/order";

/**
 * The order the field asks for its pictures in.
 *
 * On a phone the film's own code takes seconds to arrive, and every picture the
 * page had not asked for by then was a whole round trip behind it. The document
 * now preloads the first few, and the field has to hand those same few to the
 * plates that stand largest in the opening frame, or the preloaded pictures
 * would land on a plate nobody can see.
 */

const PICTURES = Array.from({ length: 14 }, (_, at) => `ipfs://picture-${at}`);

describe("the order the plates ask for their pictures", () => {
  it("hands them out nearest and largest first", () => {
    const spots = plateSpots(40);

    expect(spots).toHaveLength(40);
    for (let at = 1; at < spots.length; at += 1) {
      expect(spots[at - 1].apparent).toBeGreaterThanOrEqual(spots[at].apparent);
    }
    // Not a distinction without a difference: the first plate stands several
    // times taller in the opening frame than the last one.
    expect(spots[0].apparent).toBeGreaterThan(spots[spots.length - 1].apparent * 3);
  });

  it("gives the pictures the document preloaded to the first plates of all", () => {
    const plates = fieldPlates(40, PICTURES);

    expect(plates.slice(0, OPENING_PICTURES).map((plate) => plate.url)).toEqual(
      PICTURES.slice(0, OPENING_PICTURES),
    );
  });

  it("leaves the field itself where it was: every spot still hangs a picture", () => {
    const plates = fieldPlates(40, PICTURES);

    expect(new Set(plates.map((plate) => plate.url)).size).toBe(PICTURES.length);
    expect(plates.every((plate) => plate.height >= 0.5 && plate.height <= 1.25)).toBe(true);
    // The corridor the camera flies down stays clear.
    expect(
      plates.some(
        (plate) => plate.position[2] > -7 && Math.abs(plate.position[0]) < 2.6 && Math.abs(plate.position[1]) < 2,
      ),
    ).toBe(false);
  });

  it("is the same field on every load", () => {
    expect(fieldPlates(28, PICTURES)).toEqual(fieldPlates(28, PICTURES));
  });

  it("asks for one address once, in the order the plates take them", () => {
    const plates = [
      { picture: "ipfs://one" },
      { picture: "ipfs://two" },
      { picture: "ipfs://one" },
      { picture: "ipfs://three" },
    ];

    expect(fieldPictures(plates)).toEqual(["ipfs://one", "ipfs://two", "ipfs://three"]);
  });

  it("hangs a shorter list around the whole field rather than leaving plates dark", () => {
    const plates = fieldPlates(40, ["ipfs://only-one"]);

    expect(plates.every((plate) => plate.url === "ipfs://only-one")).toBe(true);
    expect(fieldPlates(40, [])).toEqual([]);
  });
});
