import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { docsRoot, repoRoot, servableRoots } from "./paths";

const textTypes: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export function contentTypeFor(file: string): string {
  return textTypes[path.extname(file).toLowerCase()] ?? "text/plain; charset=utf-8";
}

/**
 * Turns the segments of a /docs-files URL into a real file, or null.
 *
 * The path comes from the address bar, so it is never trusted: a segment that
 * climbs, a backslash, a byte that is not part of a file name, a folder outside
 * the two the docs link into, or a page rather than an attachment all answer
 * null, and the resolved path is checked against the repo root again afterwards.
 */
export function resolveDocsFile(segments: string[]): string | null {
  if (segments.length < 2) {
    return null;
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      return null;
    }
  }
  if (!(servableRoots as readonly string[]).includes(segments[0])) {
    return null;
  }
  const name = segments[segments.length - 1];
  if (name.startsWith(".") || name.endsWith(".md")) {
    return null;
  }

  const file = path.resolve(repoRoot, ...segments);
  const inside = path.resolve(repoRoot, segments[0]) + path.sep;
  if (!file.startsWith(inside)) {
    return null;
  }
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function walk(dir: string, prefix: string, found: string[]): void {
  for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const at = `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      walk(path.join(dir, item.name), at, found);
    } else if (resolveDocsFile(at.split("/")) !== null) {
      found.push(at);
    }
  }
}

/** Every attachment the docs can link to, as repo-relative paths. */
export function servableFiles(): string[] {
  const found: string[] = [];
  walk(docsRoot, "docs", found);
  walk(path.join(repoRoot, "proofs"), "proofs", found);
  return found.filter((file) => file !== "docs/nav.json");
}
