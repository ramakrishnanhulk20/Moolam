import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isReleased } from "@/lib/docs/drafts";
import { resolveDocsFile } from "@/lib/docs/files";
import { resolveLink } from "@/lib/docs/links";
import { isDraft, navPages, neighbours, readNav, sectionOf } from "@/lib/docs/nav";
import { allSlugs, readPage } from "@/lib/docs/pages";
import { repoRoot } from "@/lib/docs/paths";

/** The pages a visitor can reach on the deployed site: everything except the drafts. */
const pages = navPages();

/** Every page the tree names, drafts included, which is what has to match the disk. */
const written = navPages({ drafts: true });

const DRAFTS = ["legal/privacy", "legal/terms"];

/** Runs a check as the machine where work in progress is visible. */
function withLabPages<T>(run: () => T): T {
  process.env.NEXT_PUBLIC_LAB_PAGES = "1";
  try {
    return run();
  } finally {
    delete process.env.NEXT_PUBLIC_LAB_PAGES;
  }
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_LAB_PAGES;
});

/** Links inside code are examples, not links, so the fences come out first. */
function linksIn(body: string): string[] {
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((hit) => hit[1]);
}

describe("the pages the app can read", () => {
  it("finds every page on disk in the tree, and nothing else", () => {
    expect(allSlugs().sort()).toEqual(written.map((page) => page.slug).sort());
  });

  it("has all 44 markdown files accounted for: 43 released pages and the note beside the attack transcripts", () => {
    expect(pages).toHaveLength(43);
    expect(written).toHaveLength(43);
    expect(existsSync(path.join(repoRoot, "docs", "security", "attacks", "README.md"))).toBe(true);
  });

  it("reads a title and a body for every slug in nav.json", () => {
    for (const page of written) {
      const loaded = readPage(page.slug);
      expect(loaded, page.slug).not.toBeNull();
      expect(loaded?.title).toBe(page.title);
      expect(loaded?.body.startsWith("---")).toBe(false);
    }
  });

  it("puts every page in a section except the first and the last released one", () => {
    expect(sectionOf("concepts/why-monad")).toBe("Concepts");
    expect(sectionOf("intro")).toBeNull();
    expect(sectionOf("faq")).toBeNull();
    expect(readNav().filter((entry) => entry.type === "section")).toHaveLength(7);
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

describe("drafts, now that nothing is held back", () => {
  it("names no page as a draft, now that the legal pages are released", () => {
    expect(written.filter((page) => page.draft === true)).toEqual([]);
    expect(pages).toEqual(written);
    for (const slug of DRAFTS) {
      expect(isDraft(slug), slug).toBe(false);
    }
    expect(isDraft("faq")).toBe(false);
  });

  it("puts the legal pages in the tree, in their own section, for everyone", () => {
    expect(pages.map((page) => page.slug)).toContain("legal/privacy");
    expect(pages.map((page) => page.slug)).toContain("legal/terms");
    expect(readNav().some((entry) => entry.type === "section" && entry.title === "Legal")).toBe(true);
    expect(neighbours("faq").next?.slug).toBe("legal/privacy");
    expect(neighbours("legal/privacy").next?.slug).toBe("legal/terms");
    expect(sectionOf("legal/privacy")).toBe("Legal");
  });

  it("would still hold a page back if a fixture nav marked it draft, until drafts are shown", () => {
    const unreleased = { slug: "example/unreleased", title: "Unreleased", draft: true };
    const released = { slug: "example/released", title: "Released" };
    expect(isReleased(unreleased, false)).toBe(false);
    expect(isReleased(released, false)).toBe(true);
    withLabPages(() => {
      expect(isReleased(unreleased)).toBe(true);
    });
  });
});

describe("every link written in a page", () => {
  it("lands on a page that exists or a file that exists", () => {
    const broken: string[] = [];
    for (const page of written) {
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
