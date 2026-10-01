/**
 * Every rule the film hangs on, in the film's own files.
 *
 * The film used to be dark whatever the theme said, and the rules for it in
 * globals.css were written that way: `.story` forced the dark tokens, and the
 * header rules over it applied to any page that was not light, which also
 * means a page with no theme class at all, the page a visitor without
 * JavaScript gets. Light
 * is the default now and the film is light with it, so the film carries its own
 * rules under its own names ([data-film], .film-lower) and none of the old ones
 * match it any more.
 *
 * Light is the page's own Linen: the film adds no tokens for it, so with no
 * script and no theme class the film's box is Linen like the page round it.
 * Dark is the film as it shipped: the tokens below are .story's, under the dark
 * class only.
 */

/** The one name the style is hoisted under, so every part of the film can carry it and it is written once. */
export const FILM_STYLE_HREF = "moolam-film-room";

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
  background: var(--bg);
  color: var(--text);
}

@media (max-width: 767px) {
  [data-film-room] {
    --film-foot: calc(56px + max(env(safe-area-inset-bottom), var(--bar-safe, 0px)));
    --film-words-foot: var(--bar-room);
  }
}

html.dark [data-film-room] {
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
  color-scheme: dark;
}

/* In dark the bar floats bare on the shot while the shot is behind it, as it
   always did. In light, and with no theme class, it keeps its own ground. */
html.dark body[data-story-here]:has([data-film="film"]) .app-header {
  background: transparent;
  border-color: transparent;
  backdrop-filter: none;
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

/* The card the film ends on stands on the page's own ground in light, so the
   film ends on the Linen it started on and no print sits behind the counts.
   In dark it floats on the settling field, as it always did. */
html:not(.dark) .film-close {
  background: var(--bg);
}

/* The top of the shot on a phone, faded to the room's ground so the header reads over it. */
.film-seam {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg) 86%, transparent) 0,
    transparent calc(var(--film-top) + 9%)
  );
}

[data-film="film"],
[data-story-scroller] {
  overscroll-behavior-y: contain;
}

body[data-story-end] [data-film="film"],
body[data-story-end] [data-story-scroller],
body[data-story-start] [data-film="film"],
body[data-story-start] [data-story-scroller],
body[data-story-past] [data-film="film"] {
  overscroll-behavior-y: auto;
}

body[data-story-past] [data-story-scroller] {
  pointer-events: none;
}

[data-story-scroller]:focus-visible {
  outline-offset: -3px;
}

/* While the film is pinned the document ends at the film's foot, so the first
   wheel turn moves the story and not the page under it. The footer comes back
   the moment the last beat has been read. */
body:has([data-film="film"]):not([data-story-end]) footer {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  [data-film-room] .grain::after {
    display: none;
  }
}
`;
