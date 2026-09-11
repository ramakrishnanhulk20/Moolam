/** The page that answers at /docs itself. */
export const indexSlug = "intro";

export type ResolvedLink =
  | { kind: "page"; href: string; slug: string; hash: string }
  | { kind: "file"; href: string; file: string }
  | { kind: "anchor"; href: string }
  | { kind: "external"; href: string };

/** Locale-free on purpose: next-intl's Link puts the language on the front. */
export function pageHref(slug: string): string {
  return slug === indexSlug ? "/docs" : `/docs/${slug}`;
}

export function fileHref(file: string): string {
  return `/docs-files/${file}`;
}

export function slugFromSegments(segments: string[] | undefined): string {
  return segments === undefined || segments.length === 0 ? indexSlug : segments.join("/");
}

export function segmentsFromSlug(slug: string): string[] {
  return slug === indexSlug ? [] : slug.split("/");
}

function normalise(base: string, target: string): string | null {
  const out: string[] = [];
  for (const part of `${base}/${target}`.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length === 0) {
        return null;
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * Turns a link written in a markdown page into a link this app can serve.
 *
 * Everything is resolved against the page's own place in the docs folder, the
 * way it reads on GitHub, so the same markdown works in both places. A link to
 * another page becomes an app route, a link to a file becomes the files route,
 * and anything with a scheme on it stays as it is.
 */
export function resolveLink(fromSlug: string, target: string): ResolvedLink {
  const raw = target.trim();
  if (raw === "" || raw.startsWith("#")) {
    return { kind: "anchor", href: raw };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith("//")) {
    return { kind: "external", href: raw };
  }

  const cut = raw.indexOf("#");
  const hash = cut === -1 ? "" : raw.slice(cut);
  const pathPart = cut === -1 ? raw : raw.slice(0, cut);
  if (pathPart === "") {
    return { kind: "anchor", href: hash };
  }

  const from = fromSlug.split("/").slice(0, -1).join("/");
  const base = raw.startsWith("/") ? "docs" : `docs/${from}`;
  const file = normalise(base, pathPart);
  if (file === null) {
    // The link climbs above the repo, so there is nothing here to point it at.
    return { kind: "external", href: raw };
  }

  const last = file.slice(file.lastIndexOf("/") + 1);
  if (file.startsWith("docs/") && !last.includes(".")) {
    return { kind: "page", href: pageHref(file.slice("docs/".length)) + hash, slug: file.slice("docs/".length), hash };
  }
  if (file.startsWith("docs/") && last.endsWith(".md")) {
    const slug = file.slice("docs/".length, -".md".length);
    return { kind: "page", href: pageHref(slug) + hash, slug, hash };
  }
  if (file.startsWith("docs/") || file.startsWith("proofs/")) {
    return { kind: "file", href: fileHref(file) + hash, file };
  }
  return { kind: "external", href: raw };
}
