import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CosignWait } from "@/components/result/cosign-wait";
import { connectLink, cosignLink, passportLink } from "@/components/result/moolam-links";
import { MoveFlowView } from "@/components/result/move-flow";
import { openBlank, sendWindow, type WindowLike } from "@/components/result/window-flow";

const SITE = "https://moolam.vercel.app";
const COSIGN = `${SITE}/cosign#0123456789abcdef0123456789abcdef`;
const noop = () => {};

function fakeWindow(): WindowLike & { closedCalls: number } {
  return {
    closed: false,
    location: { href: "about:blank" },
    closedCalls: 0,
    close() {
      this.closedCalls += 1;
      this.closed = true;
    },
  };
}

describe("the window opened in the click", () => {
  it("is opened blank, so the request can follow without a popup blocker stopping it", () => {
    const calls: string[] = [];
    const opened = fakeWindow();
    const target = openBlank((url, name) => {
      calls.push(`${url} ${name}`);
      return opened;
    });
    expect(target).toBe(opened);
    expect(calls).toEqual(["about:blank _blank"]);
  });

  it("is sent to the link once it is known", () => {
    const target = fakeWindow();
    expect(sendWindow(target, COSIGN)).toBe("sent");
    expect(target.location.href).toBe(COSIGN);
  });

  it("counts as blocked when the browser gave none, threw, or it was closed", () => {
    expect(openBlank(() => null)).toBeNull();
    expect(
      openBlank(() => {
        throw new Error("blocked");
      }),
    ).toBeNull();
    expect(sendWindow(null, COSIGN)).toBe("blocked");
    const closed = fakeWindow();
    closed.closed = true;
    expect(sendWindow(closed, COSIGN)).toBe("blocked");
  });
});

describe("the blocked-window fallback", () => {
  it("shows the co-sign link as a button that keeps the opener, so Moolam can still answer", () => {
    const markup = renderToStaticMarkup(
      createElement(CosignWait, { signed: false, link: COSIGN, blocked: true, checkedAt: null, title: "A fox" }),
    );
    expect(markup).toContain("Your browser stopped the new tab from opening.");
    expect(markup).toContain(`href="${COSIGN}"`);
    expect(markup).toContain('rel="opener"');
    expect(markup.replace(/<[^>]+>/g, "")).toContain("Open Moolam&#x27;s co-sign page");
    expect(markup).toContain("Waiting for you to sign on Moolam");
  });

  it("keeps the link one press away even when the window did open", () => {
    const markup = renderToStaticMarkup(
      createElement(CosignWait, { signed: true, link: COSIGN, blocked: false, checkedAt: null, title: undefined }),
    );
    expect(markup).not.toContain("Your browser stopped");
    expect(markup).toContain(`href="${COSIGN}"`);
  });

  it("shows the connect link when the move's window was blocked", () => {
    const link = connectLink(SITE, "https://dreamloom.example");
    const markup = renderToStaticMarkup(
      createElement(MoveFlowView, {
        state: { kind: "waiting", link, blocked: true },
        onStart: noop,
        onConfirm: noop,
        onCancel: noop,
      }),
    );
    expect(markup).toContain("Your browser stopped the new tab from opening.");
    expect(markup).toContain(`href="${link.replace(/&/g, "&amp;")}"`);
    expect(markup).toContain('rel="opener"');
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
