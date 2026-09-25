// @vitest-environment jsdom
import { act, Component, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import type { StoryData } from "@/components/story/data";

/**
 * The home page when the film's code does not arrive: a patchy connection, a
 * chunk a network refused. The first screen, the footer and the bar stay, and
 * the film's place says so in one line with a way to try again.
 *
 * next/dynamic here is the file the App Router hands a client component when
 * it asks for next/dynamic, not the pages router's own, because the two fail
 * differently and only one of them ships on this page. The film's module is
 * stood in for by one that throws on import while the stub says so, which is
 * what a refused chunk looks like from the component's side: the import()
 * rejects.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stub = vi.hoisted(() => ({ fail: true, imports: 0 }));

vi.mock("next/dynamic", async () => await import("next/dist/api/app-dynamic"));

vi.mock("@/components/story/LandingStory", () => {
  stub.imports += 1;
  if (stub.fail) {
    throw new Error("Loading chunk components_story_LandingStory failed.");
  }
  return { LandingStory: () => createElement("div", { "data-story": "film" }, "the film") };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("@/components/passport/Picture", () => ({ Picture: () => null }));

const { default: dynamic } = await import("next/dynamic");
const { Board } = await import("@/components/home/Board");
const { FilmGate } = await import("@/components/home/FilmGate");
const { StoryStage } = await import("@/components/story/StoryStage");

const DATA: StoryData = {
  source: "chain",
  plates: [],
  focal: null,
  attestation: null,
  agent: null,
  statement: null,
  statementError: null,
  passportCount: null,
  attestationCount: null,
  error: null,
};

let root: Root | null = null;
let host: HTMLElement;
let uncaught: unknown[] = [];
const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  stub.fail = true;
  stub.imports = 0;
  uncaught = [];
  class Watch {
    observe() {}
    disconnect() {}
  }
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: Watch });
  globalThis.IntersectionObserver = window.IntersectionObserver;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  quiet.mockClear();
});

/** Lets the rejected import settle and React draw whatever comes after it. */
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * The home page's order, as the layout and app/[locale]/page.tsx draw it: the
 * first screen and the film's gate inside main, then the footer. The root's
 * own onUncaughtError stands for the page's error screen: an error that gets
 * that far is the one that used to take the whole page down.
 */
async function home() {
  root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
  await act(async () => {
    root!.render(
      createElement(
        NextIntlClientProvider,
        { locale: "en", messages: en, timeZone: "UTC" },
        createElement(
          "main",
          null,
          createElement(Board, { finding: { failed: "down" }, copy: { failed: "down" }, samples: [], loose: null }),
          createElement(FilmGate, null, createElement(StoryStage, { data: DATA, variant: "stated" })),
        ),
        createElement("footer", { "data-the-footer": true }, "footer"),
      ),
    );
  });
  // The reader turns the wheel, which is what opens the gate on the real page.
  await act(async () => {
    window.dispatchEvent(new Event("wheel"));
  });
  await settle();
}

const box = () => host.querySelector("[data-film-failed]");

describe("which part of this Next catches a film that did not load", () => {
  it("never hands the failure to the import's own loading box, so a catch around the film is the one that can", async () => {
    const seen: unknown[] = [];
    const caught: unknown[] = [];
    class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error: unknown) {
        caught.push(error);
      }
      render() {
        return this.state.failed ? createElement("p", null, "caught") : this.props.children;
      }
    }
    const Film = dynamic(
      () => import("@/components/story/LandingStory").then((module) => module.LandingStory),
      {
        ssr: false,
        loading: ({ error }) => {
          seen.push(error);
          return null;
        },
      },
    );

    root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
    await act(async () => {
      root!.render(createElement(Catch, null, createElement(Film, { data: DATA })));
    });
    await settle();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((error) => error === null)).toBe(true);
    expect(caught).toHaveLength(1);
    // Vitest wraps a mock that threw in its own error and keeps ours as the cause.
    const error = caught[0] as Error;
    expect(`${error.message} ${String(error.cause)}`).toContain("Loading chunk");
    expect(uncaught).toHaveLength(0);
  });
});

describe("the home page when the film's import rejects", () => {
  it("keeps the first screen's headline and line, the footer, and puts the box where the film would be", async () => {
    await home();

    expect(uncaught).toHaveLength(0);
    expect(host.querySelector("h1[data-first-line]")?.textContent).toContain(en.home.first.headline);
    expect(host.querySelector("[data-first-why]")?.textContent).toBe(en.home.first.line);
    expect(host.querySelector("[data-the-footer]")).not.toBeNull();
    expect(box()).not.toBeNull();
    expect(box()?.textContent).toContain(en.story.failed.line);
  });

  it("leaves no [data-story] anywhere, so the header, footer and bar act as on any page without the film", async () => {
    await home();

    expect(box()).not.toBeNull();
    expect(host.querySelector("[data-story]")).toBeNull();
    expect(box()?.closest("[data-story]")).toBeNull();
  });

  it("is a short box, not the film's screen tall one", async () => {
    await home();

    expect(box()?.outerHTML).not.toContain("100svh");
    expect(host.querySelector("[data-film-gate]")).toBeNull();
  });
});

describe("Try again on the film's box", () => {
  const retry = () => host.querySelector<HTMLButtonElement>("[data-film-failed] button");

  it("shows the same box again after a second failure, and asks for the code again only when pressed", async () => {
    await home();
    const first = stub.imports;
    expect(retry()?.textContent).toBe(en.story.failed.retry);

    await settle();
    expect(stub.imports).toBe(first);

    await act(async () => {
      retry()!.click();
    });
    await settle();

    expect(stub.imports).toBe(first + 1);
    expect(box()).not.toBeNull();
    expect(host.querySelector("[data-story]")).toBeNull();

    await settle();
    expect(stub.imports).toBe(first + 1);
  });

  // Last in the file on purpose: once the film has loaded, the module keeps it.
  it("mounts the film on a fresh import once the code can be had", async () => {
    await home();
    const first = stub.imports;
    expect(box()).not.toBeNull();

    stub.fail = false;
    await act(async () => {
      retry()!.click();
    });
    await settle();

    expect(stub.imports).toBe(first + 1);
    expect(host.querySelector('[data-story="film"]')?.textContent).toBe("the film");
    expect(box()).toBeNull();
    expect(host.querySelector("[data-the-footer]")).not.toBeNull();
  });
});
