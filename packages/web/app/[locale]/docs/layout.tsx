import { setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { HashLanding } from "@/components/docs/HashLanding";
import { HeaderOffset } from "@/components/docs/HeaderOffset";
import { ReadingLine } from "@/components/docs/ReadingLine";
import { DocsToolbar } from "@/components/docs/Toolbar";
import { DocsTree } from "@/components/docs/Tree";
import { readNav } from "@/lib/docs/nav";

/**
 * The reading frame every documentation page sits in: the tree on the left at a
 * desktop width, the bar with search and the drawer above, and the app's own
 * header and footer still around all of it.
 */
export default async function DocsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const nav = readNav();

  return (
    <div className="docs">
      <HeaderOffset />
      <HashLanding />
      <ReadingLine />
      <DocsToolbar nav={nav} />
      <div className="mx-auto grid w-full max-w-[1400px] gap-x-12 px-5 sm:px-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <div className="sticky top-[calc(var(--docs-top,4rem)+2rem)] max-h-[calc(100dvh-var(--docs-top,4rem)-4rem)] overflow-y-auto py-12 pr-4">
            <DocsTree nav={nav} />
          </div>
        </aside>
        {children}
      </div>
    </div>
  );
}
