import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filmPlace } from "@/components/story/signals";

/**
 * Where the film's pinned stage stands against the window, and the one flag it
 * still writes: the dark header floats bare on the shot while the stage is
 * pinned. The keys, the wheel hand-over and the body flags that used to ride
 * with the film's own scroller are gone, and one-scroll.test.ts holds that.
 */

describe("the film under the home page's first screen", () => {
  it("is coming while the page above it shows, here once the stage is pinned, gone once it has scrolled away", () => {
    expect(filmPlace(973)).toBe("coming");
    expect(filmPlace(223)).toBe("coming");
    expect(filmPlace(0)).toBe("here");
    expect(filmPlace(1)).toBe("here");
    expect(filmPlace(-400)).toBe("gone");
  });

  it("counts a stage within a pixel of the window's top as pinned", () => {
    expect(filmPlace(0.5)).toBe("here");
    expect(filmPlace(-0.5)).toBe("here");
    expect(filmPlace(1.5)).toBe("coming");
    expect(filmPlace(-1.5)).toBe("gone");
  });
});

describe("the dark bar's flag", () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
  const css = read("components/story/room.ts");
  const story = read("components/story/LandingStory.tsx");

  it("is written from the film's own frame while the stage is pinned, and cleared when the film goes", () => {
    expect(story).toContain('document.body.setAttribute("data-story-here", "true")');
    expect(story).toContain('document.body.removeAttribute("data-story-here")');
    expect(story).toContain("const held = top <= 1 && top + box.offsetHeight >= pin.offsetHeight - 1;");
  });

  it("floats the bar on the shot only in the dark room, and leaves the light bar on its own ground", () => {
    expect(css).toMatch(
      /html\.dark body\[data-story-here\]:has\(\[data-film="film"\]\) \.app-header \{\s*background: transparent;/,
    );
    // Light keeps the bar's own ground. A page with no theme class follows the device, as the page's own tokens do.
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*html:not\(\.light\) body\[data-story-here\]:has\(\[data-film="film"\]\) \.app-header \{\s*background: transparent;/,
    );
  });
});
