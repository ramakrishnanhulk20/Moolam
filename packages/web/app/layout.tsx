import type { ReactNode } from "react";

/**
 * Every real page lives under a locale, and that layout carries the html and
 * body tags. This one exists only because Next asks for a root layout.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
