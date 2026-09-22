// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { IndexRetry } from "@/components/IndexRetry";
import { PRESS_QUIET_SECONDS, RETRY_LIMIT } from "@/components/retryPlan";

/**
 * The button on the page that met an index which would not answer.
 *
 * The schedule stops after three tries. The button does not, because a reader
 * who waited out a busy minute deserves a way back, and on 2026-09-21 that way
 * back was a press with nothing behind it: every press was a request, as fast
 * as a finger could go, at the endpoint that had just asked for room. A tab
 * left in the background kept a timer awake every second to decide it had
 * nothing to do.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let shown: "visible" | "hidden" = "visible";

function render(node: ReactElement): { host: HTMLElement; root: Root } {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
  });
  return { host, root };
}

/** Seconds of the reader's own time, with React given its turn after each one. */
function pass(seconds: number) {
  for (let at = 0; at < seconds; at += 1) {
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
  }
}

function press(host: HTMLElement) {
  act(() => {
    host.querySelector("button")?.click();
  });
}

function button(host: HTMLElement): HTMLButtonElement {
  const node = host.querySelector("button");
  if (node === null) {
    throw new Error("the way back has no button");
  }
  return node;
}

beforeEach(() => {
  shown = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => shown });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The tab goes away and comes back, the way a browser tells a page about it. */
function look(at: "visible" | "hidden") {
  shown = at;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("the way back after the index would not answer", () => {
  it("asks three times on its own schedule and then leaves it alone", () => {
    const asked = vi.fn();
    const { host, root } = render(createElement(IndexRetry, { said: "the endpoint answered 503", again: asked }));

    pass(5);
    expect(asked).toHaveBeenCalledTimes(1);
    pass(10);
    expect(asked).toHaveBeenCalledTimes(2);
    pass(20);
    expect(asked).toHaveBeenCalledTimes(RETRY_LIMIT);

    pass(120);
    expect(asked).toHaveBeenCalledTimes(RETRY_LIMIT);
    expect(host.textContent).toContain(en.retry.stopped);

    act(() => root.unmount());
  });

  it("answers a press once the schedule has stopped, and only once", () => {
    const asked = vi.fn();
    const { host, root } = render(createElement(IndexRetry, { said: "the endpoint answered 503", again: asked }));

    pass(35);
    expect(asked).toHaveBeenCalledTimes(RETRY_LIMIT);

    press(host);
    expect(asked).toHaveBeenCalledTimes(RETRY_LIMIT + 1);
    expect(button(host).disabled).toBe(true);

    // A finger held on the button is still one request.
    for (let again = 0; again < 8; again += 1) {
      press(host);
    }
    expect(asked).toHaveBeenCalledTimes(RETRY_LIMIT + 1);

    pass(PRESS_QUIET_SECONDS - 1);
    expect(button(host).disabled).toBe(true);
    press(host);
    expect(asked).toHaveBeenCalledTimes(RETRY_LIMIT + 1);

    pass(1);
    expect(button(host).disabled).toBe(false);
    press(host);
    expect(asked).toHaveBeenCalledTimes(RETRY_LIMIT + 2);

    act(() => root.unmount());
  });

  it("keeps no timer awake in a tab nobody is looking at, and picks up where it stopped", () => {
    const asked = vi.fn();
    const { host, root } = render(createElement(IndexRetry, { said: "the endpoint answered 503", again: asked }));

    pass(2);
    // The countdown is the reader's own sentence, with the second it stands on.
    expect(host.textContent).toContain("3 seconds");

    look("hidden");
    expect(vi.getTimerCount()).toBe(0);

    pass(300);
    expect(asked).not.toHaveBeenCalled();
    expect(host.textContent).toContain("3 seconds");

    look("visible");
    expect(vi.getTimerCount()).toBe(1);
    pass(3);
    expect(asked).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("takes longer over a 429, which is the index asking for room", () => {
    const asked = vi.fn();
    const { root } = render(createElement(IndexRetry, { said: "the Envio endpoint answered 429", again: asked }));

    pass(9);
    expect(asked).not.toHaveBeenCalled();
    pass(1);
    expect(asked).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("leaves no timer behind when the page that met the failure goes", () => {
    const asked = vi.fn();
    const { root } = render(createElement(IndexRetry, { said: "the endpoint answered 503", again: asked }));

    pass(2);
    act(() => root.unmount());

    expect(vi.getTimerCount()).toBe(0);
    pass(60);
    expect(asked).not.toHaveBeenCalled();
  });
});
