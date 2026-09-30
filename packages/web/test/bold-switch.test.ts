// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type FunctionComponent, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { CompactSwitch, PathChoice } from "@/components/studio/PathChoice";
import { stepChoice } from "@/components/studio/useRadioGroup";
import type { Mode } from "@/lib/studio/flow";

/**
 * The studio's two ways in, drawn as the bold switch Ram picked from the lab
 * (02B): a radio group a keyboard and a screen reader can use, one pink block
 * on the chosen half, the chosen path's sentence under it, and no pill.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children?: ReactNode;
}>;

const NOOP = () => undefined;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function draw(node: ReactNode, locale = "en", messages: unknown = en): string {
  return renderToStaticMarkup(createElement(Provider, { locale, messages, timeZone: "UTC" }, node));
}

/** The switch mounted as the studio holds it: the choice lives above, and every change the switch asks for is recorded. */
function mount(start: Mode, busy = false): { box: HTMLElement; asked: Mode[] } {
  const asked: Mode[] = [];
  function Held() {
    const [mode, setMode] = useState<Mode>(start);
    return createElement(PathChoice, {
      mode,
      busy,
      onMode: (next: Mode) => {
        asked.push(next);
        setMode(next);
      },
    });
  }
  document.body.innerHTML = "<main></main>";
  const box = document.querySelector("main") as HTMLElement;
  root = createRoot(box);
  act(() => {
    root?.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(Held)));
  });
  return { box, asked };
}

const radios = (box: HTMLElement) => [...box.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const shownNote = (box: HTMLElement) => box.querySelector('[data-switch-note][aria-hidden="false"]')?.textContent;

describe("the bold switch's radio group", () => {
  it("is one radiogroup named by its kicker, with a radio for each path in reading order", () => {
    const { box } = mount("upload");
    const group = box.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group).not.toBeNull();
    const name = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
    expect(name?.textContent).toBe(en.studio.choice.kicker);
    expect(radios(box).map((radio) => radio.textContent)).toEqual([
      `01${en.studio.choice.upload.label}`,
      `02${en.studio.choice.generate.label}`,
    ]);
  });

  it("marks the chosen path checked and makes it the group's one tab stop", () => {
    const { box } = mount("generate");
    const [upload, generate] = radios(box);
    expect(generate.getAttribute("aria-checked")).toBe("true");
    expect(upload.getAttribute("aria-checked")).toBe("false");
    expect(generate.tabIndex).toBe(0);
    expect(upload.tabIndex).toBe(-1);
  });

  it("moves the choice with the arrow keys, and focus with it, wrapping at both ends", () => {
    const { box, asked } = mount("upload");
    const group = box.querySelector('[role="radiogroup"]') as HTMLElement;
    act(() => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(asked).toEqual(["generate"]);
    expect(document.activeElement).toBe(radios(box)[1]);
    expect(radios(box)[1].getAttribute("aria-checked")).toBe("true");
    act(() => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(asked).toEqual(["generate", "upload"]);
    expect(document.activeElement).toBe(radios(box)[0]);
  });

  it("hands a click to onMode exactly as the old tabs did", () => {
    const { box, asked } = mount("upload");
    act(() => radios(box)[1].click());
    expect(asked).toEqual(["generate"]);
  });

  it("lets nothing change the path while a run is under way", () => {
    const { box, asked } = mount("upload", true);
    expect(radios(box).every((radio) => radio.disabled)).toBe(true);
    const group = box.querySelector('[role="radiogroup"]') as HTMLElement;
    act(() => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      radios(box)[1].click();
    });
    expect(asked).toEqual([]);
  });

  it("steps through the choices the way a radio group does", () => {
    expect(stepChoice(0, 2, "ArrowRight")).toBe(1);
    expect(stepChoice(1, 2, "ArrowDown")).toBe(0);
    expect(stepChoice(0, 2, "ArrowLeft")).toBe(1);
    expect(stepChoice(1, 2, "ArrowUp")).toBe(0);
    expect(stepChoice(1, 2, "Home")).toBe(0);
    expect(stepChoice(0, 2, "End")).toBe(1);
    expect(stepChoice(0, 2, "Enter")).toBeNull();
  });
});

describe("the chosen state and its sentence", () => {
  it("draws the pink block once, inside the chosen half", () => {
    for (const mode of ["upload", "generate"] as const) {
      const { box } = mount(mode);
      const blocks = box.querySelectorAll("[data-switch-block]");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].closest('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
      expect(blocks[0].className).toContain("bg-accent");
      act(() => root?.unmount());
      root = null;
    }
  });

  it("shows the chosen path's sentence and follows the choice when it changes", () => {
    const { box } = mount("upload");
    expect(shownNote(box)).toBe(en.studio.choice.upload.note);
    act(() => radios(box)[1].click());
    expect(shownNote(box)).toBe(en.studio.choice.generate.note);
    expect(box.querySelectorAll("[data-switch-block]")).toHaveLength(1);
  });

  it("describes each half by its own sentence, in 16 px body type", () => {
    const { box } = mount("upload");
    for (const radio of radios(box)) {
      const note = document.getElementById(radio.getAttribute("aria-describedby") ?? "");
      expect(note?.hasAttribute("data-switch-note")).toBe(true);
      expect(note?.className).toContain("text-base");
    }
  });

  it("gives the ring on the pink block the ink colour, so it can be seen", () => {
    const { box } = mount("upload");
    const [chosen, other] = radios(box);
    expect(chosen.className).toContain("focus-visible:outline-accent-ink!");
    expect(other.className).not.toContain("focus-visible:outline-accent-ink!");
    for (const radio of radios(box)) {
      expect(radio.className).toContain("focus-visible:-outline-offset-4!");
    }
  });

  it("has a hover for the half that is not chosen", () => {
    const { box } = mount("generate");
    expect(radios(box)[0].className).toContain("enabled:hover:bg-accent-soft");
  });
});

describe("the switch's shape", () => {
  it("is never a pill: the frame at 8 px, the halves and block at 6 px inside it", () => {
    for (const markup of [
      draw(createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP })),
      draw(createElement(CompactSwitch, { mode: "generate", busy: false, onMode: NOOP })),
    ]) {
      expect(markup).not.toMatch(/rounded-full|rounded-3xl|rounded-2xl|9999px/);
      expect(markup).toContain('role="radiogroup"');
      expect(markup).toMatch(/role="radiogroup"[^>]*class="[^"]*rounded-\[8px\]/);
      expect(markup).toContain("rounded-[6px]");
    }
  });

  it("stacks the halves on a phone and lays them side by side from sm, and always side by side in the laptop's slot", () => {
    const column = draw(createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP }));
    expect(column).toMatch(/role="radiogroup"[^>]*class="[^"]*auto-rows-fr sm:grid-cols-2/);
    const slot = draw(createElement(CompactSwitch, { mode: "upload", busy: false, onMode: NOOP }));
    expect(slot).toMatch(/role="radiogroup"[^>]*class="[^"]*grid-cols-2/);
  });

  it("gives Tamil names the looser leading its marks need", () => {
    const markup = draw(createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP }), "ta", ta);
    expect(markup).toContain("leading-[1.2]");
    expect(markup).not.toContain("leading-[0.95]");
  });
});
