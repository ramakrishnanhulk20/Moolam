// What this file does not cover: real layout and the browser's own request log. The screenshot run
// for this work order measures the phone header in pixels and counts /api/auth/session requests on a
// live page. Here: the shared read makes one request however many parts ask, the corner keeps one
// phone height in every state, each new line shows only in its own case, and /privacy renders.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountView } from "@/components/account/account-api";
import { AccountCorner, CORNER_ROW } from "@/components/account/account-chip";
import { LOADING, createAccountStore, type AccountRead } from "@/components/account/use-account";
import { Footer } from "@/components/footer";
import { HoldHint } from "@/components/result/choose-panel";
import { MoveFlowView } from "@/components/result/move-flow";
import { PassportPanel } from "@/components/result/passport-panel";
import type { PictureView } from "@/components/result/picture-api";
import PrivacyPage from "@/app/privacy/page";

const MASKED = "r****@gmail.com";
const PASSPORT = `0x${"a1".repeat(32)}`;
const TX = `0x${"b2".repeat(32)}`;
const HOLDER = "0x1234567890AbcdEF1234567890aBcdef12345678";
const EM_DASH = String.fromCharCode(0x2014);
const noop = () => {};

const SIGNED_IN: AccountView = { available: true, signedIn: true, email: MASKED };
const SIGNED_OUT: AccountView = { available: true, signedIn: false };
const NOT_OFFERED: AccountView = { available: false };

const HOLD_SIGNED_IN = `Dreamloom registers it now, and it waits for you at Moolam under ${MASKED}. Claim it there with this Google account.`;
const HOLD_SIGNED_OUT = "Dreamloom registers it now and holds it until you claim it into your own Moolam account.";
const HOLDER_WAITING = "Dreamloom registered it and holds it for you until you claim it at Moolam.";
const HOLDER_HELD = "Dreamloom registered it and holds it for you. Claim it below to take it into your own Moolam account.";
const MOVE_WAITING = "Or take it into your account now";
const MOVE_DEFAULT = "Want it in your own account?";

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

function gated(body: unknown) {
  const calls: string[] = [];
  let release: () => void = noop;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    await gate;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, send, release };
}

describe("one session read per page", () => {
  it("makes one request however many parts start it, and hands every part the same answer", async () => {
    const server = gated({ available: true, signedIn: true, email: MASKED });
    const store = createAccountStore(server.send);
    const seen: AccountRead[] = [];
    store.subscribe(() => seen.push(store.get()));
    store.subscribe(() => seen.push(store.get()));

    // The header corner and the choose panel each start the read, once on mount and again on a re-render.
    store.start();
    store.start();
    store.start();
    expect(store.get()).toBe(LOADING);
    server.release();
    await expect.poll(() => store.get().kind).toBe("done");

    expect(server.calls).toEqual(["/api/auth/session"]);
    expect(store.get()).toEqual({ kind: "done", view: SIGNED_IN });
    expect(seen).toEqual([store.get(), store.get()]);
    store.start();
    expect(server.calls).toHaveLength(1);
  });

  it("keeps a sign-out that answered before the read, and moves every part with it", async () => {
    const late = gated({ available: true, signedIn: true, email: MASKED });
    const store = createAccountStore(late.send);
    store.start();
    store.set(SIGNED_OUT);
    late.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.get()).toEqual({ kind: "done", view: SIGNED_OUT });
  });

  it("is the only way any part of the page reads the session", () => {
    const root = path.resolve(__dirname, "../components");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(root);
    const readers = files.filter((file) => /readAccountView\(|SESSION_PATH|\/api\/auth\/session/.test(readFileSync(file, "utf8")));
    expect(readers.map((file) => path.relative(root, file).replace(/\\/g, "/")).sort()).toEqual(["account/account-api.ts", "account/use-account.ts"]);
    for (const part of ["account/account-chip.tsx", "result/choose-panel.tsx"]) {
      expect(readFileSync(path.join(root, part), "utf8")).toContain("useAccount()");
    }
  });
});

describe("the phone header does not jump", () => {
  function corner(read: AccountRead): string {
    return renderToStaticMarkup(
      createElement(AccountCorner, { read, href: "/api/auth/signin/google?from=%2F", leaving: false, outcome: null, onSignOut: noop, onCloseOutcome: noop }),
    );
  }

  function rowClass(markup: string): string[] {
    const match = /^<div[^>]*class="([^"]+)"/.exec(markup);
    if (match === null) throw new Error("the corner drew no row");
    return match[1]!.split(" ");
  }

  it("holds the same fixed phone height while loading and after a signed-in or signed-out answer", () => {
    const loading = rowClass(corner(LOADING));
    const signedIn = rowClass(corner({ kind: "done", view: SIGNED_IN }));
    const signedOut = rowClass(corner({ kind: "done", view: SIGNED_OUT }));
    const phoneHeight = (classes: string[]) => classes.filter((c) => /^(min-|max-)?h-/.test(c));
    expect(phoneHeight(loading)).toEqual(["h-11"]);
    expect(phoneHeight(signedIn)).toEqual(["h-11"]);
    expect(phoneHeight(signedOut)).toEqual(["h-11"]);
    // On phones all three are the same row: the held one differs only in hiding from sm up.
    expect(signedIn).toEqual(CORNER_ROW.split(" "));
    expect(signedOut).toEqual(CORNER_ROW.split(" "));
    expect(loading).toEqual([...CORNER_ROW.split(" "), "sm:hidden"]);
    expect(corner(LOADING)).toContain('aria-hidden="true"');
  });

  it("the chips inside fill that height and no more", () => {
    // 44 px: min-h-11 on the signed-in pill; 40 px plus a 2 px ring each side on the signed-out link.
    expect(corner({ kind: "done", view: SIGNED_IN })).toContain("min-h-11");
    const out = corner({ kind: "done", view: SIGNED_OUT });
    expect(out).toContain("p-[2px]");
    expect(out).toContain("min-h-10");
  });

  it("lets the room go when sign-in is not offered or the server does not answer", () => {
    expect(corner({ kind: "done", view: NOT_OFFERED })).toBe("");
    expect(corner({ kind: "done", view: null })).toBe("");
  });
});

describe("each new line shows only in its own case", () => {
  function hold(account: AccountView | null): string {
    return text(renderToStaticMarkup(createElement(HoldHint, { account })));
  }

  function panel(picture: Partial<PictureView>): string {
    const full: PictureView = { state: "registered", prompt: "a fox reading by lamplight", createdAt: new Date(0).toISOString(), ...picture };
    return text(renderToStaticMarkup(createElement(PassportPanel, { picture: full, moolamSite: "https://moolam.vercel.app" })));
  }

  function move(waitsByEmail?: boolean): string {
    return text(
      renderToStaticMarkup(
        createElement(MoveFlowView, { state: { kind: "idle" }, waitsByEmail, onStart: noop, onReopen: noop, onConfirm: noop, onCancel: noop }),
      ),
    );
  }

  it("the hold hint names the masked address only for a signed-in visitor", () => {
    expect(hold(SIGNED_IN)).toBe(HOLD_SIGNED_IN);
    for (const account of [SIGNED_OUT, NOT_OFFERED, null]) {
      expect(hold(account)).toBe(HOLD_SIGNED_OUT);
      expect(hold(account)).not.toContain("****");
    }
  });

  it("the holder line says claim it at Moolam only while the passport waits under an email", () => {
    const waiting = panel({ mode: "platform", passportId: PASSPORT, registerTx: TX, delivery: { kind: "waiting", to: MASKED } });
    expect(waiting).toContain(HOLDER_WAITING);
    expect(waiting).not.toContain(HOLDER_HELD);

    const held = panel({ mode: "platform", passportId: PASSPORT, registerTx: TX });
    expect(held).toContain(HOLDER_HELD);
    expect(held).not.toContain(HOLDER_WAITING);

    const signed = panel({ mode: "cosign", passportId: PASSPORT, registerTx: TX });
    expect(signed).toContain("You signed it, so Moolam names you as its creator.");
    expect(signed).not.toContain(HOLDER_WAITING);

    const claimed = panel({ state: "moved", mode: "platform", passportId: PASSPORT, registerTx: TX, moveTx: TX, movedTo: HOLDER });
    expect(claimed).toContain("You claimed it");
    expect(claimed).not.toContain(HOLDER_WAITING);

    const straight = panel({ state: "moved", mode: "platform", passportId: PASSPORT, registerTx: TX, moveTx: TX, movedTo: HOLDER, delivery: { kind: "straight", to: MASKED } });
    expect(straight).not.toContain(HOLDER_WAITING);
  });

  it("the move heading offers the other way only while the passport waits under an email, and keeps its line", () => {
    const line = "Moolam asks you to share your address with Dreamloom, then Dreamloom moves the passport to it.";
    expect(move(true)).toContain(MOVE_WAITING);
    expect(move(true)).not.toContain(MOVE_DEFAULT);
    expect(move(true)).toContain(line);
    for (const flag of [false, undefined]) {
      expect(move(flag)).toContain(MOVE_DEFAULT);
      expect(move(flag)).not.toContain(MOVE_WAITING);
      expect(move(flag)).toContain(line);
    }
  });

  it("the result screen tells the move block when the passport waits under an email", () => {
    const source = readFileSync(path.resolve(__dirname, "../components/result/result-screen.tsx"), "utf8");
    expect(source).toContain('const waitsByEmail = picture.state === "registered" && picture.delivery?.kind === "waiting";');
    expect(source).toContain("waitsByEmail={waitsByEmail}");
  });
});

describe("the privacy page", () => {
  it("renders at /privacy with every part the work order names", () => {
    const markup = renderToStaticMarkup(createElement(PrivacyPage));
    const words = text(markup);
    for (const part of [
      "Dreamloom is a demo site built to show the Moolam platform kit.",
      "dl_session",
      "dl_signin",
      "10 minutes at most",
      "Used for 30 days from sign-in",
      "Only masked",
      "Dreamloom never asks for your name",
      "OpenAI",
      "Moolam keeps only a keyed hash of the address",
      "A blockchain cannot forget.",
      "Sign out",
      "Moolam's GitHub",
    ]) {
      expect(words).toContain(part);
    }
    expect(markup).toContain('href="https://github.com/ramakrishnanhulk20/Moolam/issues"');
    expect(markup).not.toContain(EM_DASH);
  });

  it("is linked from the footer", () => {
    const markup = renderToStaticMarkup(createElement(Footer));
    expect(markup).toMatch(/<a href="\/privacy"[^>]*>Privacy<\/a>/);
  });
});
