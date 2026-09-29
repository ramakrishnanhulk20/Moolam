import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

/**
 * The studio's panels after a press, and the sign-in window before one.
 *
 * Held here: Privy is handed the accent and the ground of the theme in use and
 * a logo file that carries its own size; a failure's note sits straight under
 * the band on a phone and a press check's line straight under its button; the
 * done screen's ways on come before the receipt; the band keeps the title and
 * lets its step line give way with an ellipsis, and is a polite live region.
 *
 * Node renders markup, not a screen, so what is checked is the order and the
 * classes a phone reads. Where things land on a real phone is measured on the
 * dev server, not here.
 */

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const privy = vi.hoisted(() => ({
  theme: undefined as string | undefined,
  config: null as null | { appearance?: Record<string, unknown> },
}));

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: privy.theme }) }));

vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: (props: { config: { appearance?: Record<string, unknown> }; children?: ReactNode }) => {
    privy.config = props.config;
    return props.children;
  },
  usePrivy: () => ({ logout: async () => undefined }),
}));

vi.mock("@privy-io/wagmi", () => ({
  createConfig: () => ({}),
  WagmiProvider: (props: { children?: ReactNode }) => props.children,
}));

// The failure note and the done screen's actions arrive through next/dynamic.
// Every loader is started and awaited once, so the panels render them whole.
const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", async () => {
  const { createElement: make } = await import("react");
  return {
    default: (load: () => Promise<FunctionComponent<never>>) => {
      let Loaded: FunctionComponent<never> | null = null;
      chunks.pending.push(
        load().then((component) => {
          Loaded = component;
        }),
      );
      return (props: never) => (Loaded === null ? null : make(Loaded, props));
    },
  };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";

const { PrivyProvider, signInAppearance } = await import("@/components/providers/PrivyProvider");
const { RegisterPanel } = await import("@/components/studio/RegisterPanel");
const { GeneratePanel } = await import("@/components/studio/GeneratePanel");
const { StatusBand } = await import("@/components/studio/StatusBand");
const { CompactSwitch } = await import("@/components/studio/PathChoice");
const { WideLayout } = await import("@/components/studio/layout");
const { BAND_HEADING, FORM_CONTROL, foldFocusTarget } = await import("@/components/studio/press");
const { fixtureState } = await import("./studio-fixtures");

for (let seen = -1; seen !== chunks.pending.length; ) {
  seen = chunks.pending.length;
  await Promise.all(chunks.pending);
}

const NOOP = () => undefined;

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

/** The real studio always lays itself out wide, and a phone reads that markup below lg. */
function wide(node: ReactElement): ReactElement {
  return createElement(WideLayout, null, node);
}

type State = ReturnType<typeof fixtureState>;

function upload(state: State, receipt?: ReactNode) {
  return createElement(RegisterPanel, {
    state,
    receipt,
    onChoose: NOOP,
    onTitle: NOOP,
    onConsent: NOOP,
    onSealed: NOOP,
    onSaved: NOOP,
    onRegister: NOOP,
    onReset: NOOP,
    onUnsponsored: NOOP,
    onBind: NOOP,
  });
}

function generate(state: State, receipt?: ReactNode) {
  return createElement(GeneratePanel, {
    state,
    receipt,
    onPrompt: NOOP,
    onTitle: NOOP,
    onConsent: NOOP,
    onSealed: NOOP,
    onIncludePrompt: NOOP,
    onSaved: NOOP,
    onGenerate: NOOP,
    onReset: NOOP,
    onUnsponsored: NOOP,
    onBind: NOOP,
  });
}

/** The opening tag of the element that carries this mark. */
function tagOf(markup: string, mark: string): string {
  const at = markup.indexOf(mark);
  expect(at, mark).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
}

function classOf(markup: string, mark: string): string {
  return /class="([^"]*)"/.exec(tagOf(markup, mark))?.[1] ?? "";
}

describe("the sign-in window", () => {
  const LOOKS = [
    { theme: "light", accent: "#a92a48", ground: "#fbf9f5", other: "#ffb7c5" },
    { theme: "dark", accent: "#ffb7c5", ground: "#101014", other: "#a92a48" },
  ] as const;

  for (const look of LOOKS) {
    it(`hands Privy the ${look.theme} theme's accent, ground and a sized logo`, () => {
      privy.theme = look.theme;
      privy.config = null;
      renderToStaticMarkup(createElement(PrivyProvider, null, createElement("p", null, "page")));

      const appearance = privy.config?.appearance ?? {};
      expect(appearance.accentColor).toBe(look.accent);
      expect(appearance.accentColor).not.toBe(look.other);
      expect(appearance.theme).toBe(look.ground);
      expect(appearance.landingHeader).toBe("Moolam");

      const logo = String(appearance.logo);
      expect(logo).toMatch(new RegExp(`^/brand/.+-${look.theme}\\.svg$`));
      const svg = readFileSync(join(web, "public", logo), "utf8");
      const open = /<svg[^>]*>/.exec(svg)?.[0] ?? "";
      expect(open).toMatch(/\swidth="\d+"/);
      expect(open).toMatch(/\sheight="\d+"/);
      expect(open).toContain('viewBox="0 0 100 100"');
    });
  }

  it("falls back to the dark look before the theme is known", () => {
    expect(signInAppearance(undefined).accentColor).toBe("#ffb7c5");
    expect(signInAppearance("system").theme).toBe("#101014");
  });
});

describe("a failure on a phone", () => {
  it("lifts a failed upload run's note to sit straight under the band", () => {
    const markup = render(wide(upload(fixtureState("upload", "failed"))));
    expect(classOf(markup, "data-run-failure")).toContain("max-lg:order-first");
    // The run card is a column below lg, so the lifted note is its first line,
    // and the card itself is the next thing after the band.
    expect(markup).toMatch(/<section class="[^"]*max-lg:flex max-lg:flex-col"/);
    const band = markup.indexOf("data-studio-band");
    const card = markup.indexOf("<section", band);
    expect(band).toBeGreaterThan(-1);
    expect(markup.slice(card + 1, markup.indexOf("data-run-failure"))).not.toContain("<section");
  });

  it("lifts a failed agent run's note over the plate, the steps and the seals", () => {
    const markup = render(wide(generate(fixtureState("generate", "failed"))));
    const note = classOf(markup, "data-run-failure");
    expect(note).toContain("max-lg:order-first");
    expect(note).toContain("max-lg:mt-0");
    expect(markup).toMatch(/class="[^"]*max-lg:flex max-lg:flex-col"/);
  });

  it("keeps a laptop's order: the note after the steps from lg", () => {
    const markup = render(wide(generate(fixtureState("generate", "failed"))));
    expect(markup.indexOf('data-step="send"')).toBeLessThan(markup.indexOf("data-run-failure"));
    expect(classOf(markup, "data-run-failure")).not.toMatch(/(^|\s)lg:/);
  });

  it("puts a check made at the press straight under the button that was pressed", () => {
    // An empty title is answered on its own field now, so the press check held
    // here is the passkey that has not been read yet.
    const unread = { ...fixtureState("upload", "idle"), failure: { key: "passkeyNotReady", next: "again" as const } };
    for (const markup of [render(wide(upload(unread))), render(upload(unread))]) {
      const press = markup.indexOf("data-press");
      const note = markup.indexOf("data-press-failure");
      expect(note).toBeGreaterThan(press);
      expect(note).toBeLessThan(markup.indexOf('data-step="prepare"'));
      // Nothing but the button's own closing sits between the two.
      expect(markup.slice(markup.indexOf("</button>", press), note)).not.toMatch(/<(ol|li|section)/);
    }

    const agent = { ...fixtureState("generate", "idle"), failure: { key: "passkeyNotReady", next: "again" as const } };
    const markup = render(wide(generate(agent)));
    const note = markup.indexOf("data-press-failure");
    expect(note).toBeGreaterThan(markup.indexOf("data-press"));
    expect(note).toBeLessThan(markup.indexOf(`>${en.studio.generate.signatures.heading}</p>`));
    expect(note).toBeLessThan(markup.indexOf('data-step="draw"'));
  });
});

describe("the done screen's ways on", () => {
  const stub = createElement("p", { "data-stub": true }, "nine stamps");

  for (const [name, markup] of [
    ["upload, wide", () => render(wide(upload(fixtureState("upload", "donePublic"), stub)))],
    ["upload, one column", () => render(upload(fixtureState("upload", "donePublic"), stub))],
    ["agent, wide", () => render(wide(generate(fixtureState("generate", "donePublic"), stub)))],
    ["agent, one column", () => render(generate(fixtureState("generate", "donePublic"), stub))],
  ] as const) {
    it(`come before the receipt (${name})`, () => {
      const page = markup();
      const actions = page.indexOf("data-done-actions");
      expect(actions).toBeGreaterThan(-1);
      expect(actions).toBeLessThan(page.indexOf("data-stub"));
      expect(page.indexOf(en.studio.register.passportId)).toBeLessThan(actions);
    });
  }

  it("keep their laptop places in the grid whatever the markup order", () => {
    const page = render(wide(upload(fixtureState("upload", "donePublic"), stub)));
    expect(page).toMatch(/class="lg:col-start-2 lg:row-start-2"><div class="mt-8" data-done-actions/);
    expect(page).toMatch(/class="lg:col-span-2 lg:col-start-1 lg:row-start-3"><p data-stub/);
  });
});

describe("the band", () => {
  const sending = fixtureState("upload", "sending");

  it("lets the step line give way with an ellipsis and keeps a floor under the title", () => {
    const markup = render(createElement(StatusBand, { state: sending }));
    const step = classOf(markup, "data-band-step");
    expect(step).toContain("truncate");
    expect(step).toContain("min-w-0");
    expect(step).toContain("sm:flex-initial");
    expect(step).not.toContain("flex-none");
    expect(tagOf(markup, "data-band-step")).toContain(`title="${en.studio.register.steps.send.watching}"`);

    const title = /<p class="([^"]*)"><span[^>]*>Harbour at first light/.exec(markup)?.[1] ?? "";
    expect(title).toContain("sm:min-w-[8rem]");
    expect(title).toContain("flex-1");
  });

  it("is a polite live region with a heading that can take focus", () => {
    const markup = render(createElement(StatusBand, { state: sending }));
    expect(tagOf(markup, "data-studio-band")).toContain('aria-live="polite"');
    const heading = tagOf(markup, "data-band-heading");
    expect(heading).toContain('role="heading"');
    expect(heading).toContain('aria-level="2"');
    expect(heading).toContain('tabindex="-1"');
  });
});

describe("focus when the face changes", () => {
  it("goes to the band's heading after the fold and a form control after Register another", () => {
    expect(foldFocusTarget(true)).toBe(BAND_HEADING);
    expect(foldFocusTarget(false)).toBe(FORM_CONTROL);
    expect(render(wide(upload(fixtureState("upload", "preparing"))))).toContain("data-band-heading");
    for (const control of ["input", "textarea", "button:not([disabled])"]) {
      expect(FORM_CONTROL).toContain(control);
    }
  });

  it("draws the compact switch's ring inside each segment, which the frame would clip", () => {
    const markup = render(createElement(CompactSwitch, { mode: "upload", busy: false, onMode: NOOP }));
    const buttons = markup.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain("focus-visible:-outline-offset-2!");
    }
    expect(buttons[0]).toContain("rounded-s-[7px]");
    expect(buttons[1]).toContain("rounded-e-[7px]");
  });
});
