import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { docsRoot } from "./paths";

export type DocsPage = {
  /** The path under docs/ without the extension, for example concepts/why-monad. */
  slug: string;
  title: string;
  /** The markdown with the front matter block taken off. */
  body: string;
};

/**
 * The attack transcripts are evidence the security pages link to, not pages of
 * their own, so the folder stays out of the tree. The docs site excluded it the
 * same way.
 */
const notPages = new Set(["security/attacks"]);

function walk(dir: string, prefix: string, found: string[]): void {
  for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const slug = prefix === "" ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      if (!notPages.has(slug)) {
        walk(path.join(dir, item.name), slug, found);
      }
    } else if (item.name.endsWith(".md")) {
      found.push(slug.slice(0, -".md".length));
    }
  }
}

/** Every page on disk, whether or not the tree names it. */
export function allSlugs(): string[] {
  const found: string[] = [];
  walk(docsRoot, "", found);
  return found;
}

function fileFor(slug: string): string | null {
  // A slug is built from URL segments, so it is checked rather than trusted: no
  // segment may climb out of the docs folder or hide a second extension.
  if (slug === "" || !/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(slug)) {
    return null;
  }
  const file = path.join(docsRoot, `${slug}.md`);
  return existsSync(file) ? file : null;
}

export function pageExists(slug: string): boolean {
  return fileFor(slug) !== null;
}

export function readPage(slug: string): DocsPage | null {
  const file = fileFor(slug);
  if (file === null) {
    return null;
  }
  // The bundler is told to leave this read alone: it cannot see where the docs
  // folder is, so it would copy the whole project into the deployment to be
  // safe. next.config.ts names the two folders that really are needed instead.
  const source = readFileSync(/* turbopackIgnore: true */ file, "utf8");
  const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const body = front === null ? source : source.slice(front[0].length);
  const titled = front?.[1].match(/^title:\s*(.+)$/m);
  // A page with no front matter takes its title from the first heading, which is
  // what every page here carries anyway.
  const heading = body.match(/^#\s+(.+)$/m);
  const title = (titled?.[1] ?? heading?.[1] ?? slug).trim();
  return { slug, title, body };
}
