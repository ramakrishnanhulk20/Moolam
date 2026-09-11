import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDocsFile } from "@/lib/docs/files";
import { resolveLink } from "@/lib/docs/links";
import { navPages, neighbours, readNav, sectionOf } from "@/lib/docs/nav";
import { allSlugs, readPage } from "@/lib/docs/pages";
import { repoRoot } from "@/lib/docs/paths";

const pages = navPages();

/** Links inside code are examples, not links, so the fences come out first. */
function linksIn(body: string): string[] {
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((hit) => hit[1]);
}

describe("the pages the app can read", () => {
  it("finds every page on disk in the tree, and nothing else", () => {
    expect(allSlugs().sort()).toEqual(pages.map((page) => page.slug).sort());
  });

  it("has all 31 markdown files accounted for: 30 pages and the note beside the attack transcripts", () => {
    expect(pages).toHaveLength(30);
    expect(existsSync(path.join(repoRoot, "docs", "security", "attacks", "README.md"))).toBe(true);
  });

  it("reads a title and a body for every slug in nav.json", () => {
    for (const page of pages) {
      const loaded = readPage(page.slug);
      expect(loaded, page.slug).not.toBeNull();
      expect(loaded?.title).toBe(page.title);
      expect(loaded?.body.startsWith("---")).toBe(false);
    }
  });

  it("puts every page in a section except the first and the last", () => {
    expect(sectionOf("concepts/why-monad")).toBe("Concepts");
    expect(sectionOf("intro")).toBeNull();
    expect(sectionOf("faq")).toBeNull();
    expect(readNav().filter((entry) => entry.type === "section")).toHaveLength(6);
  });

  it("walks the whole tree with previous and next", () => {
    expect(neighbours("intro").previous).toBeNull();
    expect(neighbours(pages[pages.length - 1].slug).next).toBeNull();

    let at = pages[0].slug;
    const walked = [at];
    for (;;) {
      const step = neighbours(at).next;
      if (step === null) {
        break;
      }
      at = step.slug;
      walked.push(at);
    }
    expect(walked).toEqual(pages.map((page) => page.slug));
  });
});

describe("every link written in a page", () => {
  it("lands on a page that exists or a file that exists", () => {
    const broken: string[] = [];
    for (const page of pages) {
      const body = readPage(page.slug)?.body ?? "";
      for (const target of linksIn(body)) {
        const link = resolveLink(page.slug, target);
        if (link.kind === "page" && readPage(link.slug) === null) {
          broken.push(`${page.slug}: ${target}`);
        }
        if (link.kind === "file" && resolveDocsFile(link.file.split("/")) === null) {
          broken.push(`${page.slug}: ${target}`);
        }
        if (link.kind === "external" && !link.href.startsWith("http")) {
          broken.push(`${page.slug}: ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
