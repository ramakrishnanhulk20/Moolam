import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "@/lib/i18n/routing";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  /** What the link resolver made of it: page, file, anchor or external. */
  kind: string;
  children: ReactNode;
};

/**
 * One anchor for every link inside a page. A link to another page keeps the
 * reader's language and navigates in the client, a transcript goes to the files
 * route, which carries no language, and anything off the site opens away from
 * it.
 */
export function DocsLink({ href, kind, children, ...rest }: Props) {
  if (kind === "page") {
    return (
      <Link href={href} {...rest}>
        {children}
      </Link>
    );
  }
  if (kind === "external") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="docs-external" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
