// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { timeFormats } from "@/lib/i18n/timeFormats";
import { initialRegisterState, registerReducer, type RegisterState } from "@/lib/studio/flow";
import { TITLE_POINTS, needsGoAhead, plainTitle, seenOnline, webCheckApplies } from "@/lib/studio/warning";
import { SEALED_PUBLIC_FIELDS, sealedFieldsFor } from "@/components/sealed/fields";
import { fixtureState } from "./studio-fixtures";
import {
  EARLIER_ID,
  EARLIER_TITLE,
  FINDINGS,
  PAGES,
  PAGE_COUNT,
  pauses,
  preparedWith,
  signingState,
  type Finding,
} from "./studio-signing-fixtures";

/**
 * WO-284b: what the studio and the co-sign page show before anyone signs. The
 * look-alike warning in each of its states (L19, L20), the web check's notice
 * and its list (L22, L23), the sworn line beside every sign button, and the two
 * new public fields of a sealed document. Every pose is a fixture: nothing here
 * reaches the verify service, Google or Monad.
 */

const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", async () => {
  const { createElement: make } = await import("react");
  return {
    default: (load: () => Promise<FunctionComponent<never>>, options?: { loading?: FunctionComponent }) => {
      let Loaded: FunctionComponent<never> | null = null;
      chunks.pending.push(
        load().then((component) => {
          Loaded = component;
        }),
      );
      return (props: never) =>
        Loaded === null ? (options?.loading === undefined ? null : make(options.loading)) : make(Loaded, props);
    },
  };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));

const { RegisterPanel } = await import("@/components/studio/RegisterPanel");
const { GeneratePanel } = await import("@/components/studio/GeneratePanel");
const { BeforeSigning } = await import("@/components/studio/BeforeSigning");
const { StatusBand } = await import("@/components/studio/StatusBand");
const { CosignSheet } = await import("@/components/cosign/CosignSheet");
const flow = await import("@/lib/cosign/flow");
type CosignRecord = import("@/lib/cosign/record").CosignRecord;
type CosignAction = import("@/lib/cosign/flow").CosignAction;

for (let seen = -1; seen !== chunks.pending.length; ) {
  seen = chunks.pending.length;
  await Promise.all(chunks.pending);
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  formats?: unknown;
  children?: unknown;
}>;

function wrap(node: ReactElement): ReactElement {
  return createElement(Provider, { locale: "en", messages: en, timeZone: "UTC", formats: timeFormats }, node);
}

/** The markup as a reader sees the words: React's escaped apostrophes and quotes put back. */
function render(node: ReactElement): string {
  return renderToStaticMarkup(wrap(node)).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

/** The markup's words alone, so a sentence can be found across the tags around it. */
function words(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const NOOP = () => undefined;

const uploadHandlers = {
  onChoose: NOOP,
  onTitle: NOOP,
  onConsent: NOOP,
  onSealed: NOOP,
  onSaved: NOOP,
  onRegister: NOOP,
  onReset: NOOP,
  onUnsponsored: NOOP,
  onBind: NOOP,
};

const agentHandlers = {
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
};

const picture = new File(["x"], "harbour.jpg", { type: "image/jpeg" });

function warning(state: RegisterState): string {
  return render(createElement(BeforeSigning, { state, onSign: NOOP, onChooseAnother: NOOP }));
}

function run(state: RegisterState): string {
  return render(createElement(RegisterPanel, { state: { ...state, file: picture }, ...uploadHandlers }));
}

const lookalike = en.studio.lookalike;
const webCheck = en.studio.webCheck;

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:picture", revokeObjectURL: () => undefined }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("L19: the warning before signing is a read that succeeded, or it says it could not check", () => {
  it.each(FINDINGS)("%s says something in words, never nothing", (finding) => {
    const html = warning(signingState(finding));
    expect(html).toContain("data-before-signing");
    expect(html).toContain(lookalike.kicker);
    expect(words(html).length).toBeGreaterThan(lookalike.kicker.length + 20);
  });

  it("says 'could not check' for the service's own unchecked and for an answer the page could not read", () => {
    for (const finding of ["unchecked", "unread"] as const) {
      const html = warning(signingState(finding));
      expect(html, finding).toContain('data-lookalike="unchecked"');
      expect(html, finding).toContain(lookalike.unchecked);
      // An unread answer is never drawn as a search that found nothing.
      expect(words(html), finding).not.toContain("found no earlier passport");
    }
  });

  it("says 'none' only with the time the index was current to", () => {
    const html = warning(signingState("none"));
    expect(html).toContain('data-lookalike="none"');
    expect(words(html)).toContain("Moolam's search found no earlier passport like this one, as of Sep 25, 2026, 5:00 AM UTC.");
  });

  it("names the earlier passport when someone else registered one, and the edit when it is the creator's own", () => {
    const found = words(warning(signingState("found")));
    expect(found).toContain(lookalike.found.heading);
    expect(found).toContain(`${EARLIER_TITLE} was registered by someone else on Sep 22, 2026.`);
    expect(found).toContain(lookalike.found.note);

    const yours = words(warning(signingState("yours")));
    expect(yours).toContain(lookalike.yours.heading);
    expect(yours).toContain(lookalike.yours.line);
  });

  it("lands first in the run card, where the button was pressed, ahead of the steps", () => {
    for (const finding of FINDINGS) {
      const html = run(signingState(finding));
      const at = html.indexOf("data-before-signing");
      expect(at, finding).toBeGreaterThan(-1);
      expect(at, finding).toBeLessThan(html.indexOf('data-step="prepare"', html.indexOf('data-face="run"')));
    }
  });

  it("is not drawn for a picture the agent drew, whose route never searches", () => {
    const drawn = fixtureState("generate", "signing");
    expect(warning(drawn)).toBe("");
  });
});

describe("L20: a stranger's text is text", () => {
  it("draws the earlier title as one printable line of at most 120 code points", () => {
    const hostile = `‮evil\u0000 title\nsecond line ${"ü".repeat(300)}`;
    const state: RegisterState = {
      ...signingState("found"),
      prepared: {
        ...preparedWith("found"),
        lookalike: { state: "found", passportId: EARLIER_ID, title: hostile, registeredAt: 1_790_050_200 },
      },
    };
    const html = render(createElement(BeforeSigning, { state, onSign: NOOP, onChooseAnother: NOOP }));
    expect(html).not.toContain("‮");
    expect(html).not.toContain("\u0000");
    expect(html).not.toContain("title\nsecond");
    const line = plainTitle(hostile);
    expect(Array.from(line).length).toBeLessThanOrEqual(TITLE_POINTS);
    expect(html).toContain(line);
    expect(line.startsWith("evil title second line")).toBe(true);
  });

  it("names an empty title as untitled rather than leaving a gap", () => {
    const state: RegisterState = {
      ...signingState("found"),
      prepared: { ...preparedWith("found"), lookalike: { state: "found", passportId: EARLIER_ID, title: "", registeredAt: 1_790_050_200 } },
    };
    expect(words(warning(state))).toContain(`${lookalike.untitled} was registered by someone else`);
  });

  it("links only to the passport page, by the passport id pattern, in a new tab", () => {
    const html = warning(signingState("found"));
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)];
    expect(links.map((match) => match[1])).toEqual([`/passport/${EARLIER_ID}`]);
    expect(links[0]?.[0]).toContain('target="_blank"');
  });

  it("draws no link at all for an id that is not a passport id", () => {
    for (const bad of ["javascript:alert(1)", `0x${"3c".repeat(31)}`, `https://evil.example/${EARLIER_ID}`]) {
      const state: RegisterState = {
        ...signingState("found"),
        prepared: {
          ...preparedWith("found"),
          lookalike: { state: "found", passportId: bad as Hex, title: EARLIER_TITLE, registeredAt: 1_790_050_200 },
        },
      };
      const html = warning(state);
      expect(html, bad).not.toContain("<a ");
      expect(html, bad).toContain(EARLIER_TITLE);
    }
  });
});

describe("L22: the person is told before upload that a public photo is checked against the web", () => {
  it("follows the verify service's one rule: a studio upload, not sealed", () => {
    expect(webCheckApplies({ mode: "upload", sealed: false })).toBe(true);
    expect(webCheckApplies({ mode: "upload", sealed: true })).toBe(false);
    expect(webCheckApplies({ mode: "generate", sealed: false })).toBe(false);
  });

  it("is on the upload form before the press for a public picture, and gone once it is sealed", () => {
    const open = render(createElement(RegisterPanel, { state: { ...initialRegisterState, file: picture, title: "A" }, ...uploadHandlers }));
    expect(open).toContain(webCheck.notice);
    expect(open.indexOf("data-web-check-notice")).toBeLessThan(open.indexOf("data-press"));

    const sealed = registerReducer({ ...initialRegisterState, file: picture }, { type: "sealed", on: true });
    expect(render(createElement(RegisterPanel, { state: sealed, ...uploadHandlers }))).not.toContain("data-web-check-notice");
  });

  it("never appears on the agent's path, which is never sent", () => {
    const html = render(createElement(GeneratePanel, { state: { ...initialRegisterState, mode: "generate" }, ...agentHandlers }));
    expect(html).not.toContain("data-web-check-notice");
  });
});

describe("L23: the web check's list is text to read, and its absence means nothing", () => {
  it("lists the exact pages the creator is about to sign, with the count and the pages counted but not listed", () => {
    const html = warning(signingState("web"));
    const listed = [...html.matchAll(/<span class="min-w-0 break-all">([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(listed).toEqual(PAGES);
    expect(words(html)).toContain(`Google found this picture on ${PAGE_COUNT} web pages when Moolam looked.`);
    expect(words(html)).toContain(`${PAGE_COUNT - PAGES.length} more pages counted, not listed.`);
  });

  it("never draws a page as a link", () => {
    const html = warning(signingState("foundAndWeb"));
    for (const page of PAGES) {
      expect(html).not.toContain(`href="${page}"`);
    }
    expect([...html.matchAll(/<a /g)]).toHaveLength(1);
  });

  it("shows nothing at all when the check was silent or unreadable, and never says 'not online'", () => {
    for (const finding of ["none", "unchecked", "unread", "found", "yours"] as Finding[]) {
      const html = warning(signingState(finding));
      expect(html, finding).not.toContain("data-seen-online");
      expect(html, finding).not.toContain(webCheck.found.heading);
      expect(words(html).toLowerCase(), finding).not.toMatch(/not (seen|found) (online|on the web)/);
    }
  });

  it("drops a page it would not draw whole, and keeps the count Google gave", () => {
    const long = `https://example.com/${"a".repeat(300)}`;
    const shown = seenOnline({
      mode: "upload",
      prepared: { ...preparedWith("web"), webCheck: { state: "found", count: 3, pages: [PAGES[0], long, PAGES[1]] } },
    });
    expect(shown).toEqual({ count: 3, pages: [PAGES[0], PAGES[1]], more: 1 });
    expect(seenOnline({ mode: "upload", prepared: { ...preparedWith("web"), webCheck: { state: "found", count: 2, pages: [] } } })).toBeNull();
  });
});

describe("the pause before signing", () => {
  it("stops for an earlier passport or pages on the web, and goes straight on for none and could not check", () => {
    for (const finding of FINDINGS) {
      expect(needsGoAhead({ mode: "upload", prepared: preparedWith(finding) }), finding).toBe(pauses(finding));
    }
  });

  it("offers the sign press and another picture under the findings, with the sworn line between", () => {
    const html = run(signingState("found"));
    const card = html.slice(html.indexOf("data-before-signing"));
    expect(card.indexOf("data-sworn")).toBeGreaterThan(card.indexOf(lookalike.found.heading));
    expect(card.indexOf("data-sworn")).toBeLessThan(card.indexOf("data-press-sign"));
    expect(card).toContain(en.studio.register.steps.sign.waiting);
    expect(card).toContain("data-choose-another");
  });

  it("keeps the 'none' and 'could not check' line on screen through the passkey and the send, without buttons", () => {
    for (const finding of ["none", "unchecked"] as const) {
      const sending: RegisterState = { ...signingState(finding), steps: { ...signingState(finding).steps, sign: "done", send: "running" } };
      const html = run(sending);
      expect(html, finding).toContain(`data-lookalike="${finding}"`);
      expect(html, finding).not.toContain("data-press-sign");
    }
  });

  it("signs on the sign press and leaves for another picture on the other, where the card is", async () => {
    const signed = vi.fn();
    const reset = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      createRoot(host).render(
        wrap(createElement(RegisterPanel, { state: { ...signingState("yours"), file: picture }, ...uploadHandlers, onRegister: signed, onReset: reset })),
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-press-sign]")?.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-choose-another]")?.click();
    });
    expect(signed).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("holds the pause in the reducer until a step starts, a failure ends it or the picture is left", () => {
    const paused = registerReducer(fixtureState("upload", "signing"), { type: "review" });
    expect(paused.review).toBe(true);
    expect(registerReducer(paused, { type: "start", step: "sign" }).review).toBe(false);
    expect(registerReducer(paused, { type: "failed", failure: { key: "unknown" } }).review).toBe(false);
    expect(registerReducer(paused, { type: "reset" }).review).toBe(false);
    expect(registerReducer(paused, { type: "choose", file: picture }).review).toBe(false);
    expect(initialRegisterState.review).toBe(false);
  });

  it("names the pause on the band rather than the first step's waiting line", () => {
    const html = render(createElement(StatusBand, { state: signingState("found") }));
    expect(html).toContain(`>${lookalike.kicker}</span>`);
    expect(html).not.toContain("animate-pulse");
  });
});

describe("the sworn line beside every sign button", () => {
  const sworn = en.sworn;

  it("is the verify service's sworn text, word for word", () => {
    const statements = readFileSync(path.join(repoRoot, "packages", "verifier", "src", "statements.ts"), "utf8");
    expect(statements).toContain(`export const SWORN_TEXT = "${sworn.line}";`);
  });

  it("sits straight above the upload press, with its note", () => {
    const html = render(createElement(RegisterPanel, { state: { ...initialRegisterState, file: picture, title: "A" }, ...uploadHandlers }));
    expect(html).toContain(sworn.label);
    expect(html).toContain(sworn.line);
    expect(html).toContain(sworn.note);
    expect(html.indexOf("data-sworn")).toBeLessThan(html.indexOf("data-press"));
  });

  it("sits straight above the agent's press, with its note", () => {
    const html = render(createElement(GeneratePanel, { state: { ...initialRegisterState, mode: "generate" }, ...agentHandlers }));
    expect(html).toContain(sworn.line);
    expect(html).toContain(sworn.note);
    expect(html.indexOf("data-sworn")).toBeLessThan(html.indexOf("data-press"));
  });

  const EXACT = `0x${"7a".repeat(32)}` as Hex;
  const WALLET = "0xc3714B31A5F300D7A79f72C7AEC61240D2f384E7" as Hex;
  const RECORD: CosignRecord = {
    state: "signed",
    agentId: "4242",
    platform: { name: "Acme Studio", agentId: "4242" },
    exactHash: EXACT,
    passport: {
      exactHash: EXACT,
      parentId: `0x${"00".repeat(32)}` as Hex,
      creator: WALLET,
      generatorAgentId: "4242",
      phash: "1",
      blockhash256: `0x${"ab".repeat(32)}` as Hex,
      manifestHash: `0x${"cd".repeat(32)}` as Hex,
      kind: 0,
      fingerprintVersion: 1,
      metadataURI: "ipfs://bafkreimetadata000000000000000",
      deadline: "1790001800",
    },
    files: {
      image: { cid: "i", uri: "ipfs://i", gatewayUrl: "https://g.example/ipfs/i", bytes: 10 },
      thumbnail: { cid: "t", uri: "ipfs://t", gatewayUrl: "https://g.example/ipfs/t", bytes: 10 },
      manifest: { cid: "m", uri: "ipfs://m", gatewayUrl: "https://g.example/ipfs/m", bytes: 10 },
      metadata: { cid: "d", uri: "ipfs://d", gatewayUrl: "https://g.example/ipfs/d", bytes: 10 },
    },
    openBy: 1_790_000_000,
    digest: `0x${"01".repeat(32)}` as Hex,
    agentSignature: `0x${"11".repeat(65)}` as Hex,
  };

  function cosign(extra: CosignAction[]) {
    let at = flow.initialCosign;
    for (const action of [
      { type: "handle", valid: true },
      { type: "auth", signedIn: true },
      { type: "answer", outcome: { kind: "record", record: RECORD } },
      { type: "binding", status: "bound" },
      { type: "gate", gate: { at: "passed", digest: RECORD.digest } },
      ...extra,
    ] as CosignAction[]) {
      at = flow.cosignReducer(at, action);
    }
    return at;
  }

  it("sits above the co-sign page's sign press, in the full page and the checkout window", () => {
    for (const checkout of [false, true]) {
      const html = render(createElement(CosignSheet, { model: cosign([]), agent: null, wallet: WALLET, onPress: NOOP, checkout }));
      expect(html, String(checkout)).toContain(sworn.line);
      expect(html, String(checkout)).toContain(sworn.note);
      expect(html.indexOf("data-sworn"), String(checkout)).toBeLessThan(html.indexOf('data-press="sign"'));
    }
  });

  it("leaves the co-sign page once the passport is registered, when nothing is left to sign", () => {
    const landed = cosign([{ type: "send", send: { at: "registered", passportId: EXACT, txHash: `0x${"5e".repeat(32)}` as Hex } }]);
    const html = render(createElement(CosignSheet, { model: landed, agent: null, wallet: WALLET, onPress: NOOP }));
    expect(html).not.toContain("data-sworn");
  });
});

describe("what the studio says becomes public: the two statements", () => {
  it("lists the sworn line on every sealed registration and the earlier passport on an upload only", () => {
    const upload = sealedFieldsFor({ generated: false }).map((field) => field.key);
    const drawn = sealedFieldsFor({ generated: true }).map((field) => field.key);
    expect(upload).toContain("sworn");
    expect(drawn).toContain("sworn");
    expect(upload).toContain("seenEarlier");
    expect(drawn).not.toContain("seenEarlier");
  });

  it("carries the words the words order wrote for them", () => {
    const fields = en.studio.sealed.fields as Record<string, { label: string; line: string }>;
    for (const key of ["sworn", "seenEarlier"]) {
      const field = SEALED_PUBLIC_FIELDS.find((one) => one.key === key);
      expect(field?.source, key).toBe("document");
      expect(field?.label, key).toBe(fields[key]?.label);
      expect(field?.line, key).toBe(fields[key]?.line);
    }
  });
});
