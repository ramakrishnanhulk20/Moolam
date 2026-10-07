// What this file does not cover: the browser itself (layout, motion, the popup), which the
// screenshots at 1440 and 375 check by eye. It proves the words and links each state draws, and
// that the page only ever has the masked address.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountChipView } from "@/components/account/account-chip";
import { SIGNIN_WORDS, postSignOut, readAccountView, signInHref, signInOutcome } from "@/components/account/account-api";
import { deliveryWords } from "@/components/result/delivery-ticket";
import { PassportPanel } from "@/components/result/passport-panel";
import type { PictureView } from "@/components/result/picture-api";
import { maskEmail } from "@/lib/email-mask";

const PASSPORT = `0x${"a1".repeat(32)}`;
const TX = `0x${"b2".repeat(32)}`;
const HOLDER = "0x1234567890AbcdEF1234567890aBcdef12345678";
const noop = () => {};

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

function panel(picture: Partial<PictureView>, moolamSite = "https://moolam.site"): string {
  const full: PictureView = { state: "registered", prompt: "a fox reading by lamplight", createdAt: new Date(0).toISOString(), ...picture };
  return renderToStaticMarkup(createElement(PassportPanel, { picture: full, moolamSite }));
}

describe("the mask", () => {
  it("keeps the first letter, a fixed run of stars and the domain", () => {
    expect(maskEmail("rosalind@gmail.com")).toBe("r****@gmail.com");
    expect(maskEmail("ab@example.org")).toBe("a****@example.org");
    expect(maskEmail("x@mail.co.uk")).toBe("x****@mail.co.uk");
    expect(maskEmail("  rosalind@gmail.com ")).toBe("r****@gmail.com");
  });

  it("does not give away the name's length", () => {
    expect(maskEmail("a@gmail.com")).toBe("a****@gmail.com");
    expect(maskEmail("abcdefghijklmnop@gmail.com")).toBe("a****@gmail.com");
  });

  it("keeps a first letter outside ASCII whole", () => {
    expect(maskEmail("élodie@exemple.fr")).toBe("é****@exemple.fr");
    expect(maskEmail("😀smile@example.com")).toBe("😀****@example.com");
  });

  it("shows only stars for something that is not an address", () => {
    expect(maskEmail("no-at-sign")).toBe("****");
    expect(maskEmail("@example.com")).toBe("****");
    expect(maskEmail("name@")).toBe("****");
  });
});

describe("the waiting line", () => {
  it("says the passport waits at Moolam, with the masked address and Moolam's My pictures page", () => {
    const markup = panel({ mode: "platform", passportId: PASSPORT, registerTx: TX, delivery: { kind: "waiting", to: "r****@gmail.com" } });
    expect(text(markup)).toContain("Your passport is waiting at Moolam.Claim it with r****@gmail.com at moolam.site/en/mine");
    expect(markup).toContain('href="https://moolam.site/en/mine"');
  });

  it("names the Moolam site it was set up with", () => {
    const words = deliveryWords({ kind: "waiting", to: "r****@gmail.com" }, "http://localhost:3000");
    expect(words.href).toBe("http://localhost:3000/en/mine");
    expect(words.label).toBe("localhost:3000/en/mine");
  });

  it("says the passport went straight to the person's Moolam account when it did", () => {
    const markup = panel({ state: "moved", mode: "platform", passportId: PASSPORT, registerTx: TX, moveTx: TX, movedTo: HOLDER, delivery: { kind: "straight", to: "r****@gmail.com" } });
    expect(text(markup)).toContain("Your passport went straight to your Moolam account.");
    expect(text(markup)).not.toContain("You claimed it");
    expect(text(markup)).not.toContain("waiting at Moolam");
  });

  it("does not show for a picture held with no ticket, as today", () => {
    const markup = panel({ mode: "platform", passportId: PASSPORT, registerTx: TX });
    expect(text(markup)).not.toContain("waiting at Moolam");
    expect(text(markup)).toContain("Dreamloom registered it and holds it for you.");
  });
});

describe("the header", () => {
  it("offers Sign in with Google, going by Dreamloom back to this page", () => {
    const markup = renderToStaticMarkup(
      createElement(AccountChipView, { account: { available: true, signedIn: false }, href: signInHref("/p/0123456789abcdef0123456789abcdef"), leaving: false, onSignOut: noop }),
    );
    expect(text(markup)).toContain("Sign in with Google");
    expect(markup).toContain('href="/api/auth/signin/google?from=%2Fp%2F0123456789abcdef0123456789abcdef"');
  });

  it("signed in, shows the masked address and Sign out", () => {
    const markup = renderToStaticMarkup(
      createElement(AccountChipView, { account: { available: true, signedIn: true, email: "r****@gmail.com" }, href: "/", leaving: false, onSignOut: noop }),
    );
    expect(text(markup)).toContain("Signed in as r****@gmail.com");
    expect(text(markup)).toContain("Sign out");
    expect(text(markup)).not.toContain("Sign in with Google");
  });

  it("sends a sign-in from any other page back to the home page", () => {
    expect(signInHref("/somewhere")).toBe("/api/auth/signin/google?from=%2F");
    expect(signInHref("/")).toBe("/api/auth/signin/google?from=%2F");
  });

  it("reads the session answer, and shows nothing when the server says sign-in is not offered or does not answer", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await readAccountView(answer(200, { available: true, signedIn: true, email: "r****@gmail.com" }))).toEqual({ available: true, signedIn: true, email: "r****@gmail.com" });
    expect(await readAccountView(answer(200, { available: false, signedIn: false }))).toEqual({ available: false });
    expect(await readAccountView(answer(503, { error: "busy" }))).toBeNull();
    expect(await readAccountView((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBeNull();
    expect(await postSignOut(answer(200, { available: true, signedIn: false }))).toEqual({ available: true, signedIn: false });
  });

  it("turns the sign-in word in the address bar into words with a next step, and ignores anything else", () => {
    expect(signInOutcome("?signin=failed")).toBe("failed");
    expect(signInOutcome("?signin=unverified")).toBe("unverified");
    expect(signInOutcome("?signin=toString")).toBeNull();
    expect(signInOutcome("")).toBeNull();
    expect(SIGNIN_WORDS.unverified).toMatch(/Try another Google account\.$/);
  });
});
