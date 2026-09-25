// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { WideLayout } from "@/components/studio/layout";
import { PathChoice } from "@/components/studio/PathChoice";

/**
 * Where the wide studio's compact path switch is drawn: into the slot the
 * opening keeps beside the page's name, a cell of the opening's own grid, so
 * its place comes from the layout's flow and not from an offset. A node render
 * cannot show this, because the slot is found in the document.
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

const NOOP = () => undefined;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mount(node: ReactNode, withSlot: boolean): { slot: HTMLElement | null; box: HTMLElement } {
  document.body.innerHTML = `${withSlot ? '<header data-opening="compact"><div data-studio-switch-slot></div></header>' : ""}<main></main>`;
  const box = document.querySelector("main") as HTMLElement;
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  root = createRoot(box);
  act(() => {
    root?.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
  });
  return { slot: document.querySelector("[data-studio-switch-slot]"), box };
}

describe("the compact path switch", () => {
  it("is drawn inside the opening's slot, and the full fork stays in the studio for a phone", () => {
    const { slot, box } = mount(createElement(WideLayout, null, createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP })), true);
    expect(slot?.querySelector("[data-path-compact]")).not.toBeNull();
    expect(box.querySelector("[data-path-compact]")).toBeNull();
    const phone = box.querySelector(":scope > div.lg\\:hidden");
    expect(phone?.textContent).toContain(en.studio.choice.upload.label);
  });

  it("carries no breakpoint or offset of its own: the slot decides when it shows and the grid where", () => {
    const { slot } = mount(createElement(WideLayout, null, createElement(PathChoice, { mode: "generate", busy: false, onMode: NOOP })), true);
    const switcher = slot?.querySelector("[data-path-compact]") as HTMLElement;
    expect(switcher.className).toBe("");
    expect(switcher.getAttribute("style") ?? "").not.toMatch(/bottom|absolute/);
  });

  it("stays in the slot, quiet, through a run, while the phone's fork steps aside", () => {
    const { slot, box } = mount(
      createElement(WideLayout, null, createElement(PathChoice, { mode: "upload", busy: true, running: true, onMode: NOOP })),
      true,
    );
    const buttons = [...(slot?.querySelectorAll("[data-path-compact] button") ?? [])] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(box.textContent).toBe("");
  });

  it("falls back to the full fork at every width on a page with no slot", () => {
    const { box } = mount(createElement(WideLayout, null, createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP })), false);
    expect(document.querySelector("[data-path-compact]")).toBeNull();
    expect(box.querySelector("div.lg\\:hidden")).toBeNull();
    expect(box.textContent).toContain(en.studio.choice.upload.label);
  });
});
