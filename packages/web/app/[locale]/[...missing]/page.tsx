import { notFound } from "next/navigation";

/**
 * Any path under a locale that no route claims lands here, so the locale's own
 * not-found page answers instead of the root one in English.
 *
 * The words in the head come from the layout beside this file: Next drops a
 * page's own metadata the moment the page answers 404.
 */
export default function Missing(): never {
  notFound();
}
