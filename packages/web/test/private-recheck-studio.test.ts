import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SealSwitch } from "@/components/sealed/SealSwitch";
import { initialRegisterState, registerReducer, type RegisterState } from "@/lib/studio/flow";
import { describeFailure } from "@/lib/studio/problems";
import { VerifierError } from "@/lib/verifier/client";
import { said } from "./sealed-keys.mjs";

/**
 * Opt-in B in the studio: the choice to let Chainlink re-check a sealed picture
 * from one small private copy.
 *
 * Three promises are held here. The choice only exists while the picture is
 * sealed. It is off whenever a form opens. And each of the service's four
 * refusals gets its own sentence rather than the catch-all.
 */

const picture = new File(["x"], "picture.jpg", { type: "image/jpeg" });

function sealedWithPrivateCopy(): RegisterState {
  let state = registerReducer(initialRegisterState, { type: "sealed", on: true });
  state = registerReducer(state, { type: "sealed", on: true, privateRecheck: true });
  return state;
}

describe("what the register screen remembers about the private re-check", () => {
  it("opens off", () => {
    expect(initialRegisterState.sealed.privateRecheck).toBe(false);
  });

  it("stays off when sealed is turned on, until it is asked for", () => {
    const sealed = registerReducer(initialRegisterState, { type: "sealed", on: true });
    expect(sealed.sealed.privateRecheck).toBe(false);
    expect(sealedWithPrivateCopy().sealed.privateRecheck).toBe(true);
  });

  it("is turned off by turning sealed off, and stays off when sealed comes back", () => {
    const off = registerReducer(sealedWithPrivateCopy(), { type: "sealed", on: false });
    expect(off.sealed.privateRecheck).toBe(false);
    expect(registerReducer(off, { type: "sealed", on: true }).sealed.privateRecheck).toBe(false);
  });

  it("can never be on while sealed is off, whatever the action asks", () => {
    const state = registerReducer(initialRegisterState, { type: "sealed", on: false, privateRecheck: true });
    expect(state.sealed.privateRecheck).toBe(false);
  });

  it("keeps its answer when only the other switches move", () => {
    let state = registerReducer(sealedWithPrivateCopy(), { type: "includePrompt", include: true });
    state = registerReducer(state, { type: "title", title: "A morning" });
    expect(state.sealed.privateRecheck).toBe(true);
    // Sealed pressed again as it stands says nothing about the private copy.
    expect(registerReducer(state, { type: "sealed", on: true }).sealed.privateRecheck).toBe(true);
  });

  it("stays on across another picture in the same form, where it is still on screen", () => {
    expect(registerReducer(sealedWithPrivateCopy(), { type: "choose", file: picture }).sealed.privateRecheck).toBe(true);
  });

  it("opens off after Make another and on the other path, while sealed keeps its answer", () => {
    for (const action of [{ type: "reset" }, { type: "mode", mode: "generate" }] as const) {
      const after = registerReducer(sealedWithPrivateCopy(), action);
      expect(after.sealed.on, action.type).toBe(true);
      expect(after.sealed.privateRecheck, action.type).toBe(false);
    }
  });
});

describe("the four refusals a private re-check has of its own", () => {
  const cases = [
    [400, "private-recheck-needs-sealed", "privateRecheckNeedsSealed", undefined],
    [409, "private-copy-not-private", "privateCopyNotPrivate", undefined],
    [503, "chain-unreachable", "privateChainUnreachable", "again"],
    [422, "thumbnail-too-large", "privateThumbnailTooLarge", undefined],
  ] as const;

  it.each(cases)("turns a %i %s into its own sentence", (status, word, key, next) => {
    // The client names the family from the status, and keeps the service's own word beside it.
    const code = status === 400 ? "bad-request" : "bad-response";
    const failure = describeFailure(
      new VerifierError(code, status, "the service's English", undefined, { serviceCode: word, named: true }),
      "prepare",
    );
    expect(failure.key).toBe(key);
    expect(failure.next).toBe(next);
    // The English underneath would only repeat what the sentence already says.
    expect(failure.reason).toBeUndefined();
  });

  it("leaves every other refusal where it was", () => {
    const duplicate = describeFailure(
      new VerifierError("already-registered", 409, "already-registered", undefined, {
        serviceCode: "already-registered",
        named: true,
      }),
      "prepare",
    );
    expect(duplicate.key).toBe("alreadyRegistered");
  });
});

const SWITCH_WORDS = {
  label: "Keep this picture sealed",
  note: "Moolam publishes the passport, not the picture.",
  panelHeading: "What becomes public",
  panelLine: "Everything below goes out the moment you sign.",
  sketchCaption: "The only picture the public sees",
  inFile: "In the file",
  onChain: "On Monad",
  leftOut: "Left out",
  promptLabel: "Include the prompt",
  promptNote: "The prompt stays private unless you include it.",
  privateLabel: "Let Chainlink re-check this privately",
  privateNote: "Moolam keeps one small copy, 512 pixels on its longest side, on private storage.",
  privateWho: "Nobody can open it from the web. Moolam's operator and the storage provider can.",
};

function drawn(props: Partial<Parameters<typeof SealSwitch>[0]>): string {
  return renderToStaticMarkup(
    createElement(SealSwitch, {
      on: true,
      onChange: () => undefined,
      bits: null,
      words: SWITCH_WORDS,
      onPrivateRecheck: () => undefined,
      ...props,
    }),
  );
}

/** The two switches in the order they are drawn, as a reader hears them. */
function switches(html: string): { label: string; checked: string }[] {
  return [...html.matchAll(/role="switch" aria-checked="(true|false)"[^>]*>.*?<span[^>]*>([^<]+)<\/span><\/button>/g)].map(
    (hit) => ({ checked: hit[1], label: hit[2] }),
  );
}

describe("the choice on screen", () => {
  it("is not drawn at all while the picture is not sealed", () => {
    const html = drawn({ on: false, privateRecheck: true });
    expect(html).not.toContain("Let Chainlink re-check this privately");
    expect(html).not.toContain("storage provider");
    expect(html).not.toContain("data-private-recheck");
  });

  it("is drawn off under the sealed switch once sealed is on, with the line saying who can open the copy", () => {
    const html = drawn({ on: true });
    expect(switches(html)).toEqual([
      { label: "Keep this picture sealed", checked: "true" },
      { label: "Let Chainlink re-check this privately", checked: "false" },
    ]);
    expect(html).toContain("Moolam&#x27;s operator and the storage provider can.");
    // It sits above the list it adds to, so pressing it never moves it.
    expect(html.indexOf("data-private-recheck")).toBeLessThan(html.indexOf("What becomes public"));
  });

  it("adds the one public row only while it is on", () => {
    const off = drawn({ on: true, privateRecheck: false });
    expect(off).not.toContain("That you asked for a private re-check");
    expect(off).not.toContain(">privateRecheck<");

    const on = drawn({ on: true, privateRecheck: true });
    expect(switches(on)[1]).toEqual({ label: "Let Chainlink re-check this privately", checked: "true" });
    expect(on).toContain("That you asked for a private re-check");
    expect(on).toContain("The copy&#x27;s address is never in it.");
    expect(on).toContain(">privateRecheck<");
  });

  it("is not offered by a screen that passes no handler or no words for it", () => {
    expect(drawn({ onPrivateRecheck: undefined })).not.toContain("data-private-recheck");
    const unsaid = { ...SWITCH_WORDS, privateLabel: undefined };
    expect(drawn({ words: unsaid, privateRecheck: true })).not.toContain("data-private-recheck");
    expect(drawn({ words: unsaid, privateRecheck: true })).not.toContain("That you asked for a private re-check");
  });

  it("keeps the prompt control on a drawing, below the list", () => {
    const html = drawn({ generated: true, includePrompt: false, onIncludePrompt: () => undefined });
    expect(switches(html).map((row) => row.label)).toEqual([
      "Keep this picture sealed",
      "Let Chainlink re-check this privately",
      "Include the prompt",
    ]);
  });
});

/** Every string this order added, counted in every language file the way the sealed copy is. */
const PRIVATE_RECHECK_KEYS = [
  "studio.sealed.switch.privateLabel",
  "studio.sealed.switch.privateNote",
  "studio.sealed.switch.privateWho",
  "studio.sealed.fields.privateRecheck.label",
  "studio.sealed.fields.privateRecheck.line",
  "studio.sealed.receipt.privateLabel",
  "studio.sealed.receipt.privateDetail",
  "studio.failure.privateRecheckNeedsSealed",
  "studio.failure.privateCopyNotPrivate",
  "studio.failure.privateChainUnreachable",
  "studio.failure.privateThumbnailTooLarge",
];

describe("the private re-check copy, counted", () => {
  const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));
  const locales = readdirSync(MESSAGES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(".json", ""));
  const LONG_DASH = String.fromCharCode(0x2014);

  function at(locale: string, path: string): unknown {
    const tree: unknown = JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8"));
    return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree);
  }

  it("says every one of its keys in all ten languages", () => {
    expect(locales).toHaveLength(10);
    const short = PRIVATE_RECHECK_KEYS.map((path) => ({
      path,
      count: locales.filter((locale) => said(locale, path)).length,
    })).filter((row) => row.count !== 10);
    expect(short.map((row) => `${row.path} (${row.count})`)).toEqual([]);
  });

  it("names who can open the copy, rather than saying nobody", () => {
    const who = String(at("en", "studio.sealed.switch.privateWho"));
    expect(who).toContain("Moolam's operator and the storage provider can.");
    expect(who).toContain("not a real enclave");
    // Every language keeps the simulator sentence, which is the one a loose translation drops.
    for (const locale of locales) {
      expect(String(at(locale, "studio.sealed.switch.privateWho")), locale).toContain("Chainlink");
    }
  });

  it("writes no long dash and no placeholder in any of them", () => {
    for (const locale of locales) {
      for (const path of PRIVATE_RECHECK_KEYS) {
        const line = String(at(locale, path));
        expect(line, `${locale} ${path}`).not.toContain(LONG_DASH);
        expect(line, `${locale} ${path}`).not.toMatch(/[{}]/);
      }
    }
  });

  it("says something different in each language, rather than the English twice", () => {
    for (const path of PRIVATE_RECHECK_KEYS) {
      expect(new Set(locales.map((locale) => String(at(locale, path)))).size, path).toBe(10);
    }
  });
});
