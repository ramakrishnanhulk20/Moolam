import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import en from "@/messages/en.json";
import { Pictures } from "@/components/lab/studio/Pictures";
import { StateDial } from "@/components/lab/studio/StateDial";
import { StatusBand } from "@/components/lab/studio/StatusBand";
import { TurnCard } from "@/components/lab/studio/TurnCard";
import { BENCH_STATES, fixtureState, type BenchState, type Path } from "@/components/lab/studio/fixtures";
import { bringIntoView, type Bench } from "@/components/lab/studio/bench";
import { scrollTarget } from "@/components/studio/press";

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The link is the one thing these drawings use from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

const web = fileURLToPath(new URL("..", import.meta.url));

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node),
  );
}

/** The bench held at one pose, which is all a drawing ever reads. */
function held(path: Path, state: BenchState): Bench {
  return {
    path,
    state,
    running: false,
    since: 0,
    choose: () => undefined,
    show: () => undefined,
    press: () => undefined,
  };
}

const NOOP = () => undefined;

describe("the state picker", () => {
  it("offers all ten states and both paths", () => {
    const markup = render(
      createElement(StateDial, {
        path: "upload",
        state: "idle",
        running: false,
        onPath: NOOP,
        onState: NOOP,
        onPlay: NOOP,
      }),
    );

    for (const state of BENCH_STATES) {
      expect(markup, state).toContain(`data-state-button="${state}"`);
    }
    expect(markup).toContain('data-path-button="upload"');
    expect(markup).toContain('data-path-button="generate"');
    expect(BENCH_STATES).toHaveLength(10);
  });
});

describe("both drawings, at every state", () => {
  const drawings = [
    { name: "turn", component: TurnCard },
    { name: "band", component: StatusBand },
  ] as const;

  for (const drawing of drawings) {
    for (const path of ["upload", "generate"] as const) {
      it.each(BENCH_STATES)(`${drawing.name} renders ${path} at %s`, (state) => {
        const markup = render(createElement(drawing.component, { bench: held(path, state) }));
        expect(markup.length).toBeGreaterThan(0);
        expect(markup).toContain(`data-drawing="${drawing.name}"`);
      });
    }
  }

  it("shows the form until the press, and never the receipt under it", () => {
    for (const drawing of drawings) {
      const markup = render(createElement(drawing.component, { bench: held("upload", "idle") }));
      expect(markup).toContain(en.studio.register.submit);
      expect(markup).not.toContain(en.studio.register.doneHeading);
    }
  });

  it("puts the studio's own step labels in the run, with nothing invented", () => {
    const turn = render(createElement(TurnCard, { bench: held("upload", "signing") }));
    expect(turn).toContain(en.studio.register.steps.sign.running);
    expect(turn).toContain(en.studio.register.steps.prepare.done);

    const band = render(createElement(StatusBand, { bench: held("upload", "signing") }));
    expect(band).toContain(en.studio.register.steps.sign.running);

    const drawing = render(createElement(TurnCard, { bench: held("generate", "preparing") }));
    expect(drawing).toContain(en.studio.generate.steps.draw.running);
  });

  it("reads a wait that ran out as pending and never as a failure", () => {
    for (const drawing of drawings) {
      const markup = render(createElement(drawing.component, { bench: held("upload", "unconfirmed") }));
      expect(markup).toContain(en.studio.register.steps.send.pending);
      expect(markup).not.toContain(en.studio.register.steps.send.failed);
      expect(markup).toContain(en.studio.consent.receipt.recheck);
    }
  });

  it("ends both drawings on the same receipt: two confirmations and two buttons", () => {
    for (const drawing of drawings) {
      const markup = render(createElement(drawing.component, { bench: held("upload", "donePublic") }));
      expect(markup).toContain(en.studio.receipt.written);
      expect(markup).toContain(en.studio.consent.receipt.label);
      expect(markup).toContain(en.passport.consent.summary.closed);
      expect(markup).toContain(en.studio.register.openPassport);
      expect(markup).toContain("Make another");
    }
  });

  it("says sealed in words on a kept picture, and hands the file back", () => {
    for (const drawing of drawings) {
      const markup = render(createElement(drawing.component, { bench: held("upload", "doneSealed") }));
      expect(markup).toContain(en.studio.sealed.done.label);
      expect(markup).toContain(en.studio.sealed.handback.save);
      expect(markup).not.toContain("/hero/frame-social-chain.jpg");
    }
  });

  it("keeps a failed statement off the passport that is already on chain", () => {
    for (const drawing of drawings) {
      const markup = render(createElement(drawing.component, { bench: held("upload", "statementFailed") }));
      expect(markup).toContain(en.studio.consent.receipt.failed);
      expect(markup).toContain(en.studio.consent.receipt.later);
      expect(markup).toContain(en.studio.register.doneHeading);
    }
  });
});

describe("where the page goes after a press", () => {
  // A laptop: the bar over every page plus the bench's own dial strip.
  const STICKY = 198;
  const TALL = 900;

  it("leaves the page alone when the panel is already under the strip", () => {
    expect(scrollTarget(STICKY, STICKY, TALL)).toBeNull();
    expect(scrollTarget(260, STICKY, TALL)).toBeNull();
    expect(scrollTarget(TALL / 3, STICKY, TALL)).toBeNull();
  });

  it("lifts a panel whose top is below the fold to sixteen px under the strip", () => {
    expect(scrollTarget(820, STICKY, TALL)).toBe(820 - STICKY - 16);
    expect(scrollTarget(TALL / 3 + 1, STICKY, TALL)).toBe(TALL / 3 + 1 - STICKY - 16);
  });

  it("brings a panel that has gone above the strip back down", () => {
    expect(scrollTarget(-420, STICKY, TALL)).toBe(-420 - STICKY - 16);
    expect(scrollTarget(STICKY - 1, STICKY, TALL)).toBe(-17);
  });

  it("scrolls at once for a reader who asked for less motion, and smoothly for everyone else", () => {
    const moves: { top: number; behavior: string }[] = [];
    const panel = { getBoundingClientRect: () => ({ top: 900 }) } as unknown as HTMLElement;

    vi.stubGlobal("window", {
      scrollY: 200,
      innerHeight: TALL,
      scrollTo: (to: { top: number; behavior: string }) => moves.push(to),
    });
    vi.stubGlobal("document", {
      querySelectorAll: () => [{ getBoundingClientRect: () => ({ height: STICKY }) }],
    });
    vi.stubGlobal("getComputedStyle", () => ({ position: "sticky", getPropertyValue: () => "" }));

    bringIntoView(panel, true);
    bringIntoView(panel, false);
    bringIntoView(null, false);

    expect(moves).toEqual([
      { top: 200 + 900 - STICKY - 16, behavior: "instant" },
      { top: 200 + 900 - STICKY - 16, behavior: "smooth" },
    ]);

    vi.unstubAllGlobals();
  });
});

describe("the fixture states", () => {
  it("names one honest pose per picker stop", () => {
    expect(fixtureState("upload", "idle").steps.prepare).toBe("waiting");
    expect(fixtureState("upload", "preparing").steps.prepare).toBe("running");
    expect(fixtureState("generate", "preparing").steps.draw).toBe("running");
    expect(fixtureState("generate", "signing").steps.agentSign).toBe("done");
    expect(fixtureState("upload", "sending").confirming).toBe(true);
    expect(fixtureState("upload", "unconfirmed").steps.send).toBe("unconfirmed");
    expect(fixtureState("upload", "donePublic").prepared?.sealed ?? false).toBe(false);
    expect(fixtureState("upload", "doneSealed").prepared?.sealed).toBe(true);
    expect(fixtureState("upload", "doneSealed").sealed.file).not.toBeNull();
    expect(fixtureState("upload", "failed").failure?.key).toBe("serviceOffline");
    expect(fixtureState("upload", "statementFailed").statement.state).toBe("failed");
  });
});

describe("the strip under the panel", () => {
  it("is headed Your pictures and lights the newest only once something is made", () => {
    const before = render(createElement(Pictures, { state: "idle" }));
    expect(before).toContain("Your pictures");
    expect(before).not.toContain("Just made");

    const after = render(createElement(Pictures, { state: "donePublic" }));
    expect(after).toContain("Just made");
    expect(after.indexOf("Harbour at first light")).toBeLessThan(after.indexOf("Quarry road"));
  });
});

/**
 * The same walk test/wallet-routes.test.ts makes, pointed at the bench.
 *
 * It lives here rather than in that file's list because the bench is a hidden
 * route, and because the rule it proves is the same one: a screen that signs
 * nothing must not ship the wallet SDK to read a drawing.
 */
describe("what the bench route carries", () => {
  const WALLET = ["@privy-io/react-auth", "@privy-io/wagmi", "wagmi", "@tanstack/react-query"];

  it("ships no wallet SDK", () => {
    expect([...browserPackages("@/app/[locale]/lab/studio/page.tsx")].filter((name) => WALLET.includes(name))).toEqual(
      [],
    );
  });

  it("finds the wallet when it is there, so the walk itself is not the pass", () => {
    expect(browserPackages("@/components/providers/PrivyProvider.tsx")).toContain("@privy-io/react-auth");
  });
});

const IMPORT = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

function fileFor(specifier: string, from: string): string | null {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
    return null;
  }

  const base = specifier.startsWith("@/") ? join(web, specifier.slice(2)) : resolve(dirname(from), specifier);
  const tries = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  const found = tries.find((path) => existsSync(path) && /\.tsx?$/.test(path));
  return found ?? null;
}

function browserPackages(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();

  const walk = (file: string, client: boolean) => {
    const key = `${file}::${String(client)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const source = readFileSync(file, "utf8");
    const shipped = client || /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);

    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1];
      const next = fileFor(specifier, file);
      if (next === null) {
        if (shipped && !specifier.startsWith("@/") && !specifier.startsWith(".") && !specifier.startsWith("node:")) {
          packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
        }
        continue;
      }
      walk(next, shipped);
    }
  };

  const start = fileFor(entry, join(web, "x.ts"));
  expect(start, `${entry} should exist`).not.toBeNull();
  walk(start as string, false);
  return packages;
}
