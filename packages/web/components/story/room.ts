/**
 * Every rule the film hangs on, in the film's own files.
 *
 * The film used to be dark whatever the theme said, and the rules for it in
 * globals.css were written that way: `.story` forced the dark tokens. The site
 * follows the visitor's system theme now and the film follows it with the
 * page, so the film carries its own rules under its own names ([data-film],
 * .film-lower) and none of the old ones match it any more.
 *
 * Light is the page's own Linen: the film adds no tokens for it. Dark is the
 * film as it shipped: the tokens below are .story's, set under the dark class
 * and, as globals.css does for the page, on a dark device when the page has no
 * theme class at all, which is the page a visitor without JavaScript gets. A
 * light class keeps the device out of it.
 */

/** The one name the style is hoisted under, so every part of the film can carry it and it is written once. */
export const FILM_STYLE_HREF = "moolam-film-room";

/**
 * How far a thumb travels per screen of story on a phone, as a share of the
 * window. The shot used to be drawn into the top 45 percent of the window and
 * the scroll was matched to it, so a beat is still exactly the drag it was.
 */
export const PHONE_TRAVEL = 0.45;

/** The same, on a phone under SHORT_SCREEN tall, where the shot used to take 36 percent. */
export const SHORT_PHONE_TRAVEL = 0.36;

/** Under this many pixels of window height, a phone is a short one. */
export const SHORT_SCREEN = 700;

/**
 * The film's own tokens in the dark room, written once and set under two
 * selectors below: the dark class, and a page with no theme class on a dark
 * device, which is what a browser running no script gets. A light class keeps
 * the device out of it, as it does for the page's own tokens in globals.css.
 */
const DARK_ROOM = `
  --bg: #0b0b0c;
  --bg-raised: #121214;
  --bg-sunken: #08080a;
  --line: rgb(255 255 255 / 0.12);
  --line-strong: rgb(255 255 255 / 0.26);
  --text: #f5f3ef;
  --text-muted: rgb(245 243 239 / 0.6);
  --text-faint: rgb(245 243 239 / 0.52);
  --accent: #ffb7c5;
  --accent-ink: #0b0b0c;
  --accent-soft: rgb(255 183 197 / 0.12);
  --status-verified: #3fbfa8;
  --status-failed: #ff5f4d;
  --status-pending: #5b8def;
  --status-disputed: #b06fd8;
  --scrim-from: rgb(11 11 12 / 0.92);
  --scrim-to: rgb(11 11 12 / 0);
  --grain-opacity: 0.055;
  --grain-blend: overlay;
  color-scheme: dark;`;

export const FILM_STYLE = `
@property --film-top {
  syntax: "<length>";
  inherits: true;
  initial-value: 0px;
}

@property --film-foot {
  syntax: "<length>";
  inherits: true;
  initial-value: 0px;
}

[data-film-room] {
  --film-top: var(--header-h);
  --film-foot: 0px;
  --film-words-foot: 0px;
  --film-travel: 1;
  background: var(--bg);
  color: var(--text);
}

@media (max-width: 767px) {
  [data-film-room] {
    --film-foot: calc(56px + max(env(safe-area-inset-bottom), var(--bar-safe, 0px)));
    --film-words-foot: var(--bar-room);
    --film-travel: ${PHONE_TRAVEL};
  }
}

@media (max-width: 639px) and (max-height: ${SHORT_SCREEN - 1}px) {
  [data-film-room] {
    --film-travel: ${SHORT_PHONE_TRAVEL};
  }
}

html.dark [data-film-room] {${DARK_ROOM}
}

@media (prefers-color-scheme: dark) {
  html:not(.light) [data-film-room] {${DARK_ROOM}
  }
}

/* In dark the bar floats bare on the shot while the shot is behind it, as it
   always did. In light it keeps its own ground. */
html.dark body[data-story-here]:has([data-film="film"]) .app-header {
  background: transparent;
  border-color: transparent;
  backdrop-filter: none;
}

@media (prefers-color-scheme: dark) {
  html:not(.light) body[data-story-here]:has([data-film="film"]) .app-header {
    background: transparent;
    border-color: transparent;
    backdrop-filter: none;
  }
}

.film-lower {
  position: absolute;
  inset-inline: 0;
  top: var(--film-top);
  bottom: var(--film-words-foot);
  display: flex;
  align-items: flex-end;
  padding-top: 1.25rem;
  padding-bottom: 1.5rem;
}

@media (max-width: 639px) {
  .film-lower > :last-child {
    position: relative;
    isolation: isolate;
  }

  /* The words' own ground on a phone: the room's ground rising from the bar to
     a little above the first line, so the shot stays clear wherever no words
     are. Paper in light, black in dark. */
  .film-lower > :last-child::before {
    content: "";
    position: absolute;
    z-index: -1;
    inset-inline: -1.25rem;
    top: -7rem;
    bottom: -12rem;
    pointer-events: none;
    background: linear-gradient(
      0deg,
      var(--bg) 0%,
      var(--bg) 45%,
      color-mix(in srgb, var(--bg) 72%, transparent) calc(100% - 7rem),
      transparent 100%
    );
  }

  .film-lower[data-beat="opening"] {
    padding-bottom: 3.25rem;
  }

  .film-close {
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
  }
}

@media (max-width: 639px) and (max-height: 699px) {
  .film-lower {
    padding-top: 0.6rem;
    padding-bottom: 1rem;
  }

  .film-lower [data-story-line="kicker"] {
    font-size: 10px;
    letter-spacing: 0.18em;
  }

  .film-lower [data-story-line="title"] {
    margin-top: 0.6rem;
    font-size: 1.45rem;
    line-height: 1.04;
  }

  .film-lower [data-story-line="body"] {
    margin-top: 0.55rem;
    font-size: 0.8125rem;
    line-height: 1.45;
  }

  .film-lower [data-story-line="readout"] {
    margin-top: 0.6rem;
    font-size: 10px;
    line-height: 1.4;
  }
}

@media (min-width: 640px) {
  .film-lower {
    inset: 0;
    align-items: center;
    padding-top: var(--film-top);
    padding-bottom: var(--film-words-foot);
  }
}

.film-cue {
  bottom: calc(var(--film-words-foot) + 1.75rem);
}

@media (max-width: 639px) {
  .film-cue {
    bottom: calc(var(--film-words-foot) + 1.4rem);
  }
}

/* Tamil runs long: its sign-it-yourself heading was five lines at 375 px with
   the last word wider than the column, cut at the edge, and the block climbed
   up over the moon print. On a phone a Tamil heading takes the whole column
   rather than the 17ch the Latin headings are held to (a ch is the Latin
   face's zero, and seventeen of them are a third of a Tamil word short), at a
   smaller display and body size, so every word stays whole and the block
   stays under the shot. A word still wider than the column breaks rather
   than leaves it. */
@media (max-width: 639px) {
  html:lang(ta) .film-lower [data-story-line="title"] {
    max-width: none;
    font-size: 1.3rem;
    line-height: 1.22;
    overflow-wrap: anywhere;
  }

  html:lang(ta) .film-lower [data-story-line="body"] {
    font-size: 0.85rem;
    line-height: 1.45;
  }
}

@media (max-width: 639px) and (max-height: 699px) {
  html:lang(ta) .film-lower [data-story-line="title"] {
    font-size: 1.15rem;
  }

  html:lang(ta) .film-lower [data-story-line="body"] {
    font-size: 0.78rem;
  }
}

/* The close in the light room is composed as the dark close is: the focal print
   whole with its frame and its stamp, the counts and the title in ink straight
   on the paper, the wall of prints round the words, and no panel anywhere. The
   small lines carry a halo of the room's paper round each glyph instead,
   edgeless and invisible over plain paper, so a label that crosses a print
   still reads. A phone keeps the ground every caption rises from
   (.film-lower above). */
@media (min-width: 640px) {
  html:not(.dark)
    .film-close
    :is([data-close-half="text"] > p, [data-close-half="figures"] > p, [data-close-error] p, dt) {
    text-shadow:
      0 0 1px var(--bg),
      0 0 2px var(--bg),
      0 0 4px var(--bg),
      0 0 8px var(--bg),
      0 0 14px var(--bg);
  }
}

/* The top of the shot on a phone, faded to the room's ground so the header reads over it. */
.film-seam {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg) 86%, transparent) 0,
    transparent calc(var(--film-top) + 9%)
  );
}

/* The film is a section as many screens tall as the cut is long: its pages
   (--film-pages, the travel plus the one screen the stage stays pinned on,
   written by whoever draws the section) times a screen of travel
   (--film-travel, above), with the stage pinned inside it one screen high. The
   page scrolls through it and nothing else takes the wheel, so the footer is
   simply what follows. A phone's screen is the dynamic one, so the stage
   follows the address bar folding away rather than leaving a strip of page
   under it.

   The box that stands in while the film's code is on its way takes the very
   same rule and the very same stage, so the page below it does not move when
   the film arrives. */
[data-film="film"],
[data-film="loading"] {
  height: calc(var(--film-pages, 1) * var(--film-travel, 1) * 100svh);
}

:is([data-film="film"], [data-film="loading"]) [data-film-stage] {
  height: 100svh;
}

@media (max-width: 767px) {
  [data-film="film"],
  [data-film="loading"] {
    height: calc(var(--film-pages, 1) * var(--film-travel, 1) * 100dvh);
  }

  :is([data-film="film"], [data-film="loading"]) [data-film-stage] {
    height: 100dvh;
  }
}

/* With no script nothing ever replaces the box, so it stays the one screen it
   always was instead of holding a whole film's worth of empty page. */
@media (scripting: none) {
  [data-film="loading"] {
    --film-pages: 1;
    --film-travel: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-film-room] .grain::after {
    display: none;
  }
}
`;
