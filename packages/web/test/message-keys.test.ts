import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every word the app asks for is in every language, and no language carries a
 * key the others do not.
 *
 * The reads are found the way a person would find them: a translator is bound
 * to a namespace with useTranslations or getTranslations, and then called with
 * a literal key. A key built at run time (`steps.${id}.title`) is not checked
 * here; the second test covers it, because the English file is the full list
 * and every other file must match it key for key.
 */

const LANGS = ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"] as const;
const root = fileURLToPath(new URL("..", import.meta.url));

type Tree = { [key: string]: string | Tree };
const messages = Object.fromEntries(
  LANGS.map((lang) => [lang, JSON.parse(readFileSync(`${root}messages/${lang}.json`, "utf8")) as Tree]),
) as Record<(typeof LANGS)[number], Tree>;

function leaves(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`),
  );
}

// Each language's notes to its translators. They are never shown, and each
// file keeps the terms its own language needed.
const readable = (key: string) => !key.startsWith("_glossary.");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const BIND =
  /const (\w+) = (?:await )?(?:useTranslations|getTranslations)\(\s*(?:"([\w.]+)"|\{[^}]*?namespace:\s*"([\w.]+)"[^}]*\})?\s*\)/g;
const INLINE = /(?:useTranslations|getTranslations)\(\s*"([\w.]+)"\s*\)\(\s*"([\w.]+)"/g;

/** Every literal key the app reads, as the list of full paths it could be, and where it was read. */
function reads(): { file: string; candidates: string[] }[] {
  const found: { file: string; candidates: string[] }[] = [];
  const files = [...sources(`${root}app`), ...sources(`${root}components`), ...sources(`${root}lib`)];
  // A name bound in one function can be a plain parameter in the next, so
  // bindings and calls are matched within each top-level declaration.
  const chunks = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\n(?=(?:export )?(?:default )?(?:async )?function |export const |const \w+ = (?:async )?\()/)
      .map((text) => ({ file, text })),
  );
  for (const { file, text } of chunks) {
    // A declaration can bind the same name to different namespaces in inner
    // functions, so a call counts if its key is under any of them.
    const bound = new Map<string, Set<string>>();
    for (const match of text.matchAll(BIND)) {
      const namespace = match[2] ?? match[3] ?? "";
      bound.set(match[1], (bound.get(match[1]) ?? new Set()).add(namespace));
    }
    for (const [name, namespaces] of bound) {
      const call = new RegExp(`(?<![\\w.])${name}(?:\\.rich|\\.markup)?\\(\\s*"([\\w.]+)"`, "g");
      for (const match of text.matchAll(call)) {
        found.push({
          file: file.slice(root.length),
          candidates: [...namespaces].map((namespace) => (namespace === "" ? match[1] : `${namespace}.${match[1]}`)),
        });
      }
    }
    for (const match of text.matchAll(INLINE)) {
      found.push({ file: file.slice(root.length), candidates: [`${match[1]}.${match[2]}`] });
    }
  }
  return found;
}

describe("the message files", () => {
  it("say every key the app reads, in all ten languages", () => {
    const all = reads();
    // A scanner that stopped matching would pass with nothing to check.
    expect(all.length).toBeGreaterThan(800);
    for (const lang of LANGS) {
      const said = new Set(leaves(messages[lang]));
      const missing = all.filter(({ candidates }) => !candidates.some((key) => said.has(key)));
      expect(
        missing.map(({ file, candidates }) => `${file}: ${candidates.join(" or ")}`),
        lang,
      ).toEqual([]);
    }
  });

  it("carry the same keys as the English, no more and no fewer", () => {
    const english = leaves(messages.en).filter(readable).sort();
    for (const lang of LANGS) {
      expect(leaves(messages[lang]).filter(readable).sort(), lang).toEqual(english);
    }
  });

  it("no longer carry the keys nothing reads", () => {
    const gone = [
      "agents.rail",
      "resolve.rail",
      "mine.rail",
      "studio.rail",
      "studio.wide.bench",
      "studio.wide.today",
      "header.nav.home",
      "common.swapNotice",
      "studio.bind.rebind",
      "home.hero.credit",
      "home.hero.generate",
      "home.hero.verify",
      "story.kicker",
      "story.line",
      "story.close.register",
    ];
    for (const lang of LANGS) {
      const said = new Set(leaves(messages[lang]));
      expect(
        gone.filter((key) => said.has(key)),
        lang,
      ).toEqual([]);
    }
  });
});
