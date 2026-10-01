"use client";

import dynamic from "next/dynamic";
import { FilmLoading } from "@/components/story/FilmLoading";
import { OPENING_PICTURES, PLATE_WIDTH, fieldPictures } from "@/components/story/scene/order";
import type { StoryData } from "@/components/story/data";
import type { StoryVariant } from "@/components/story/beats";
import type { RoomPalette } from "@/components/story/palette";
import type { FilmScroll } from "@/components/story/scroll";
import { isOptimizable, optimizedUrl } from "@/lib/images";

/**
 * The story is browser only.
 *
 * It asks the browser for a WebGL context before it decides what to render, so
 * there is nothing sensible for a server render to produce and nothing for
 * React to hydrate against. Loading it this way means the two answers never
 * disagree.
 */
let LandingStory = freshStory();

/**
 * A film whose code has not been asked for yet.
 *
 * A failed import is remembered by the component it was made for, and that
 * component throws the same failure on every mount after it without asking
 * again. So the moment one fails, the next mount is handed a new one, and the
 * Try again on the film's box is a real second request for the code.
 */
function freshStory() {
  return dynamic(
    () =>
      import("@/components/story/LandingStory")
        .then((module) => module.LandingStory)
        .catch((error: unknown) => {
          LandingStory = freshStory();
          throw error;
        }),
    {
      ssr: false,
      /**
       * The film's own box, held open before the film arrives: the film's
       * height and ground with the chapter title on it (FilmLoading.tsx), so
       * the film replaces a box of exactly its own size.
       */
      loading: () => <FilmLoading />,
    },
  );
}

export function StoryStage({
  data,
  variant,
  light,
  scroll,
}: {
  data: StoryData;
  variant: StoryVariant;
  /** The light room to play instead of the home page's, for a lab route trying the next one. */
  light?: RoomPalette;
  /** What drives the film, for a lab route trying the page's own scroll; the home page passes nothing (scroll.ts). */
  scroll?: FilmScroll;
}) {
  // The first pictures of the field, asked for by the document rather than by
  // the scene. The film's code is two thirds of a megabyte of React, three.js
  // and the scene itself; on a phone the plates used to wait for all of it and
  // only then start a round trip of their own. These go out with the document
  // instead, at the same address and the same width the texture loader will
  // ask for, so the picture is already in the browser when the scene arrives
  // and is never fetched twice.
  //
  // A picture the optimizer will not serve is left out: the loader reads that
  // one straight from the gateway as a cross origin request, which is a
  // different request from this one and would be fetched twice.
  const opening = fieldPictures(data.plates)
    .filter((picture) => isOptimizable(picture))
    .slice(0, OPENING_PICTURES);

  return (
    <div data-film-room className="relative">
      {opening.map((picture) => (
        // crossOrigin has to be here: the texture loader asks for the picture
        // with it, and a preload that does not match it is downloaded a second
        // time. Measured, on the phone profile: 13 picture requests and 201 kB
        // with it, 14 and 237 kB without, and 0.8 s later to the first plate.
        <link
          key={picture}
          rel="preload"
          as="image"
          href={optimizedUrl(picture, PLATE_WIDTH)}
          crossOrigin="anonymous"
        />
      ))}
      <LandingStory data={data} variant={variant} light={light} scroll={scroll} />
    </div>
  );
}
