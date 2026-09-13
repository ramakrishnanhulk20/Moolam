import { notFound } from "next/navigation";

/**
 * Any path under a locale that no route claims lands here, so the locale's own
 * not-found page answers instead of the root one in English.
 */
export default function Missing(): never {
  notFound();
}
