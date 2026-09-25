import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The words a first-time visitor meets, said plainly, in all ten languages.
 *
 * The lab pages used to carry their words in English-only objects until roll-in.
 * Those words now live in the message files like every other screen's, and the
 * engineering phrases the passport, agent and tool pages printed have been
 * rewritten. This holds both: every key the change added is in every file, and
 * none of the old phrases has crept back into the English.
 */

const LANGS = ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"] as const;
const root = fileURLToPath(new URL("..", import.meta.url));

type Tree = { [key: string]: string | Tree };
const messages = Object.fromEntries(
  LANGS.map((lang) => [lang, JSON.parse(readFileSync(`${root}messages/${lang}.json`, "utf8")) as Tree]),
) as Record<(typeof LANGS)[number], Tree>;

function at(tree: Tree, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], tree);
}

function strings(tree: Tree): string[] {
  return Object.values(tree).flatMap((value) => (typeof value === "string" ? [value] : strings(value)));
}

const placeholders = (words: string) => (words.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

const NEW_KEYS = [
  "studio.showcaseCaption",
  "mine.showcaseCaption",
  "explore.marksToggle",
  "studio.wide.bench",
  "studio.wide.fixtureNote",
  "studio.wide.upload",
  "studio.wide.generate",
  "studio.wide.done",
  "studio.wide.live",
  "studio.wide.today",
  "passport.facts.madeBy",
  "passport.facts.drawnBy",
  "passport.facts.aiUse",
  "passport.facts.rechecked",
  "passport.facts.nothingStated",
  "passport.facts.notYet",
  "passport.facts.unread",
  "passport.facts.noAgent",
  "passport.facts.chainlink",
  "passport.consent.standardName",
  "agents.formulaPlain",
  "agent.index.formulaPlain",
];

/** Whole values that are gone. Short labels are matched whole so a longer sentence that happens to contain them is not caught. */
const OLD_VALUES = [
  "Written by",
  "Open the image",
  "Recomputed by the workflow",
  "pHash",
  "Blockhash",
  "Exact bytes",
  "Manifest hash",
  "Fingerprint v{version}",
  "Hashed with {algorithm}",
  "Policy",
  "Dark theme",
  "Light theme",
];

/** Phrases that are gone from anywhere in a value. */
const OLD_PHRASES = [
  "Delivered through the CRE simulation forwarder",
  "Delivered through the Chainlink network forwarder",
  "As the receiver wrote it",
  "Written by an allowed receiver",
  "The passport id is also its ERC-721 token id",
  "a Privy signer with a policy that allows only appendEdit",
  "The policy allows appendEdit",
  "fetched the image, hashed it again and wrote the answer back on Monad",
  "Re-checked by a Chainlink CRE workflow",
  "through the receiver contract",
  "It ran in Chainlink's simulator on one machine, which is not a real enclave.",
  "No C2PA manifest was embedded in this file.",
  "A fresh C2PA manifest is written into it before it is pinned.",
  "This creator's wallet has a passkey bound on chain.",
  "Image unavailable from IPFS right now",
  "signed by the app's key under the edit policy, gas sponsored",
  "Waiting for the resolver named by the policy.",
  "Monad mined this and it reverted, so nothing was written",
  "The register takes plain ASCII only.",
  "The index does not carry the transaction for this one.",
  "signs the EIP-712 Passport digest",
  "The contract recovers the address from that signature itself",
  "compared with ownerOf",
  "An agent id is worth exactly as much as the wallet that owns it",
  "canonical ERC-8004 reputation registry",
  "C2PA manifest pinned",
  "a perceptual hash, a block hash",
  "Sign in to see the pictures you registered on this device",
  "Every picture you registered on this device",
  "signed by the app's key under the edit policy",
  "which is not a real enclave",
  "Sign in, unlock once with this device",
];

/** Each language's own word for an enclave, which the studio's sealed switch no longer uses. */
const ENCLAVE: Record<(typeof LANGS)[number], string> = {
  en: "enclave",
  de: "Enklave",
  es: "enclave",
  fr: "enclave",
  hi: "एन्क्लेव",
  ja: "エンクレーブ",
  ko: "엔클레이브",
  pt: "enclave",
  ta: "enclave",
  zh: "飞地",
};

describe("the plain words", () => {
  it("put every new key in all ten message files, with the English placeholders", () => {
    for (const key of NEW_KEYS) {
      const english = at(messages.en, key);
      expect(typeof english, `en ${key}`).toBe("string");
      for (const lang of LANGS) {
        const words = at(messages[lang], key);
        expect(typeof words, `${lang} ${key}`).toBe("string");
        expect((words as string).trim(), `${lang} ${key}`).not.toBe("");
        expect(placeholders(words as string), `${lang} ${key}`).toEqual(placeholders(english as string));
      }
    }
  });

  it("keep the score's formula as the same untranslated line in every language", () => {
    for (const key of ["agents.formula", "agent.index.formula"]) {
      for (const lang of LANGS) {
        expect(at(messages[lang], key), `${lang} ${key}`).toBe(at(messages.en, key));
      }
    }
  });

  it("leave none of the old engineering phrases in the English", () => {
    const english = strings(messages.en);
    for (const old of OLD_VALUES) {
      expect(english, old).not.toContain(old);
    }
    for (const old of OLD_PHRASES) {
      expect(english.filter((words) => words.includes(old)), old).toEqual([]);
    }
  });

  it("leave no English-only word object for the lab pages", () => {
    expect(existsSync(`${root}components/studio/openingWords.ts`)).toBe(false);
    expect(existsSync(`${root}components/studio/wideWords.ts`)).toBe(false);
    expect(readFileSync(`${root}components/passport/top-facts.ts`, "utf8")).not.toContain("TOP_FACT_WORDS");
  });
});

describe("the last words of the passport roll-in", () => {
  it("watch for the edit on Monad, in every language, without the edit policy", () => {
    expect(at(messages.en, "passport.edit.steps.send.watching")).toBe("Watching for your edit to land on Monad.");
    for (const lang of LANGS) {
      const words = String(at(messages[lang], "passport.edit.steps.send.watching"));
      expect(words.trim(), lang).not.toBe("");
      expect(words, lang).toContain("Monad");
    }
  });

  it("say the sealed switch's workflow is not inside Chainlink's secure hardware, and never call it an enclave", () => {
    expect(String(at(messages.en, "studio.sealed.switch.privateWho"))).toContain(
      "Today the workflow runs in Chainlink's simulator, not inside Chainlink's secure hardware.",
    );
    for (const lang of LANGS) {
      const words = String(at(messages[lang], "studio.sealed.switch.privateWho"));
      expect(words, lang).not.toContain(ENCLAVE[lang]);
      expect(words, lang).toContain("Chainlink");
    }
  });

  it("give the studio one lede for everyone, and no signed-in variant", () => {
    expect(at(messages.en, "studio.lede")).toBe(
      "Every image you register here gets its own record on Monad: fingerprinted, signed by you, findable from any copy.",
    );
    for (const lang of LANGS) {
      expect(String(at(messages[lang], "studio.lede")).trim(), lang).not.toBe("");
      expect(at(messages[lang], "studio.ledeSignedIn"), lang).toBeUndefined();
    }
  });

  it("open the agent's stored record with the passport page's own words", () => {
    for (const lang of LANGS) {
      expect(at(messages[lang], "agent.ipfsCid"), lang).toBe(at(messages[lang], "passport.ipfsCid"));
      expect(String(at(messages[lang], "agent.ipfsCid")), lang).not.toContain("{cid}");
    }
  });
});
