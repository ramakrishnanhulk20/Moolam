import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckoutCardView } from "@/components/result/checkout-card";
import { CosignWait } from "@/components/result/cosign-wait";
import { connectLink, cosignLink, moolamOrigin, passportLink } from "@/components/result/moolam-links";
import { MoveFlowView } from "@/components/result/move-flow";
import {
  CHECKOUT_NAME,
  checkoutFeatures,
  createCheckout,
  sendWindow,
  takeAnswer,
  type WindowLike,
} from "@/components/result/window-flow";

const SITE = "https://moolam.site";
const ORIGIN = moolamOrigin(SITE);
const COSIGN = `${SITE}/cosign#0123456789abcdef0123456789abcdef`;
const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const PASSPORT = `0x${"a".repeat(64)}`;
const SCREEN = { screenX: 100, screenY: 50, outerWidth: 1440, outerHeight: 900 };
const noop = () => {};

type FakeWindow = WindowLike & { closeCalls: number; focusCalls: number };

function fakeWindow(): FakeWindow {
  return {
    closed: false,
    location: { href: "about:blank" },
    closeCalls: 0,
    focusCalls: 0,
    close() {
      this.closeCalls += 1;
      this.closed = true;
    },
    focus() {
      this.focusCalls += 1;
    },
  };
}

/** A browser stand-in that records every window.open and hands out fresh windows. */
function browser(refuse = false) {
  const calls: { url: string; name: string; features: string }[] = [];
  const windows: FakeWindow[] = [];
  const open = (url: string, name: string, features: string) => {
    calls.push({ url, name, features });
    if (refuse) return null;
    const opened = fakeWindow();
    windows.push(opened);
    return opened;
  };
  return { calls, windows, checkout: createCheckout(open, () => SCREEN) };
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
}

describe("the Moolam window", () => {
  it("opens as a named popup of about 480 by 760, centred over the browser window, with its opener kept", () => {
    expect(checkoutFeatures(SCREEN)).toBe("popup=yes,width=480,height=760,left=580,top=120");
    expect(checkoutFeatures({ screenX: 0, screenY: 0, outerWidth: 400, outerHeight: 600 })).toBe(
      "popup=yes,width=480,height=760,left=0,top=0",
    );
    const b = browser();
    b.checkout.open();
    expect(b.calls).toEqual([{ url: "", name: CHECKOUT_NAME, features: checkoutFeatures(SCREEN) }]);
    expect(b.calls[0]!.features).not.toMatch(/noopener|noreferrer/);
  });

  it("opens once and is reused: a second press focuses the same window instead of opening another", () => {
    const b = browser();
    const first = b.checkout.open();
    const second = b.checkout.open();
    expect(second).toBe(first);
    expect(b.calls).toHaveLength(1);
    expect(b.windows[0]!.focusCalls).toBe(1);
  });

  it("reopen focuses an open window without moving it, and opens a fresh one on the link once it was closed", () => {
    const b = browser();
    const first = b.checkout.open()!;
    expect(sendWindow(first, COSIGN)).toBe("sent");
    expect(b.checkout.reopen(COSIGN)).toBe("focused");
    expect(first.location.href).toBe(COSIGN);
    expect(b.calls).toHaveLength(1);

    first.close();
    expect(b.checkout.reopen(COSIGN)).toBe("sent");
    expect(b.calls).toHaveLength(2);
    expect(b.windows[1]!.location.href).toBe(COSIGN);
  });

  it("counts as blocked when the browser gave none, threw, or the window was closed", () => {
    const refused = browser(true);
    expect(refused.checkout.open()).toBeNull();
    expect(refused.checkout.reopen(COSIGN)).toBe("blocked");
    const throwing = createCheckout(() => {
      throw new Error("blocked");
    }, () => SCREEN);
    expect(throwing.open()).toBeNull();
    expect(sendWindow(null, COSIGN)).toBe("blocked");
    const closed = fakeWindow();
    closed.closed = true;
    expect(sendWindow(closed, COSIGN)).toBe("blocked");
  });

  it("close shuts the window it opened, and the next press opens a new one", () => {
    const b = browser();
    b.checkout.open();
    b.checkout.close();
    expect(b.windows[0]!.closeCalls).toBe(1);
    b.checkout.open();
    expect(b.calls).toHaveLength(2);
  });
});

describe("the answer from Moolam's window", () => {
  const registered = { type: "moolam:registered", passportId: PASSPORT, txHash: `0x${"b".repeat(64)}` };
  const shared = { type: "moolam:address", address: ADDRESS.toLowerCase() };

  it("closes the window when the passport landed or the address arrived", () => {
    const b = browser();
    b.checkout.open();
    expect(takeAnswer({ origin: SITE, data: registered }, ORIGIN, "sign", b.checkout)).toEqual({ kind: "registered" });
    expect(b.windows[0]!.closeCalls).toBe(1);

    b.checkout.open();
    expect(takeAnswer({ origin: SITE, data: shared }, ORIGIN, "share", b.checkout)).toEqual({ kind: "address", address: ADDRESS });
    expect(b.windows[1]!.closeCalls).toBe(1);
  });

  it("changes nothing for a wrong origin, a wrong type, a bad address or a bad passport id", () => {
    const b = browser();
    b.checkout.open();
    const ignored: [unknown, string, "sign" | "share"][] = [
      [registered, "https://evil.example", "sign"],
      [registered, "https://moolam.site.evil.example", "sign"],
      [shared, "https://evil.example", "share"],
      [shared, SITE, "sign"],
      [registered, SITE, "share"],
      [{ ...shared, address: "0x1234" }, SITE, "share"],
      [{ ...shared, address: "0x52908400098527886E0F7030069857D2E4169Ee7" }, SITE, "share"],
      [{ ...registered, passportId: "0x1234" }, SITE, "sign"],
      [{ type: "moolam:registered" }, SITE, "sign"],
      ["moolam:registered", SITE, "sign"],
    ];
    for (const [data, origin, place] of ignored) {
      expect(takeAnswer({ origin, data }, ORIGIN, place, b.checkout)).toBeNull();
    }
    expect(takeAnswer({ origin: SITE, data: shared }, null, "share", b.checkout)).toBeNull();
    expect(b.windows[0]!.closeCalls).toBe(0);
    expect(b.windows[0]!.closed).toBe(false);
  });
});

describe("the card over the dimmed page", () => {
  it("says to finish in the Moolam window, with Reopen and Cancel", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckoutCardView, { place: "sign", link: COSIGN, blocked: false, onReopen: noop, onCancel: noop }),
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(text(markup)).toContain("Finish in the Moolam window");
    expect(text(markup)).toContain("Reopen the window");
    expect(text(markup)).toContain("Cancel");
    expect(markup).not.toContain(`href="${COSIGN}"`);
  });

  it("falls back to the link as a button when the browser refused the window, keeping the opener", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckoutCardView, { place: "sign", link: COSIGN, blocked: true, onReopen: noop, onCancel: noop }),
    );
    expect(text(markup)).toContain("Your browser stopped the Moolam window from opening.");
    expect(markup).toContain(`href="${COSIGN}"`);
    expect(markup).toContain('rel="opener"');
    expect(markup).toContain(`target="${CHECKOUT_NAME}"`);
    expect(text(markup)).toContain("Open Moolam's co-sign page");
    expect(text(markup)).not.toContain("Reopen the window");
    expect(text(markup)).toContain("Cancel");

    const link = connectLink(SITE, "https://dreamloom.example");
    const connect = renderToStaticMarkup(
      createElement(CheckoutCardView, { place: "share", link, blocked: true, onReopen: noop, onCancel: noop }),
    );
    expect(connect).toContain(`href="${link.replace(/&/g, "&amp;")}"`);
    expect(text(connect)).toContain("Open Moolam's connect page");
  });

  it("keeps the window one press away on the page behind the card", () => {
    const wait = renderToStaticMarkup(
      createElement(CosignWait, { signed: true, canReopen: true, checkedAt: null, title: "A fox", onReopen: noop }),
    );
    expect(text(wait)).toContain("Reopen the Moolam window");
    expect(text(wait)).toContain("Waiting for you to sign on Moolam");
    const move = renderToStaticMarkup(
      createElement(MoveFlowView, {
        state: { kind: "waiting", link: connectLink(SITE, "https://dreamloom.example"), blocked: false },
        onStart: noop,
        onReopen: noop,
        onConfirm: noop,
        onCancel: noop,
      }),
    );
    expect(text(move)).toContain("Reopen the Moolam window");
    expect(text(move)).toContain("Not now");
  });
});

describe("the links this page builds", () => {
  it("opens a co-sign link only on Moolam's own site", () => {
    expect(cosignLink(COSIGN, SITE)).toBe(COSIGN);
    expect(cosignLink("https://evil.example/cosign#abc", SITE)).toBeNull();
    expect(cosignLink("javascript:alert(1)", SITE)).toBeNull();
    expect(cosignLink(undefined, SITE)).toBeNull();
  });

  it("names Dreamloom's own origin to the connect page", () => {
    expect(connectLink(`${SITE}/`, "https://dreamloom.example")).toBe(
      `${SITE}/en/connect?origin=https%3A%2F%2Fdreamloom.example`,
    );
  });

  it("links a passport only from a well-formed id", () => {
    expect(passportLink(SITE, `0x${"A".repeat(64)}`)).toBe(`${SITE}/en/passport/0x${"a".repeat(64)}`);
    expect(passportLink(SITE, "0x1234")).toBeNull();
  });
});
