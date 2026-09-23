"use client";

import { usePathname, useRouter } from "@/lib/i18n/routing";
import { forgetGuideSeen, onLabPage } from "./seen";
import { askGuideAfterNavigation, tellGuideToOpen } from "./signal";

/**
 * The way back to the guide for somebody who skipped it and wishes they had
 * not.
 *
 * It belongs in the footer, which every page carries, next to Privacy and
 * Terms. Only the home page carries the walk, though. There the entry forgets
 * the mark and shouts, and the walk opens in place. Anywhere else a shout would
 * reach nobody, so the entry leaves a one-use note for the home page and takes
 * the reader there, locale and all, and the walk opens on arrival.
 *
 * A lab page keeps the old quiet behaviour: it shouts into a page that ignores
 * it and stays put, because a bench is where the product is being drawn, not
 * read.
 *
 * The label is handed in, like the bottom bar's, because the caller is the one
 * that knows which language the footer is being read in.
 */
export function ShowGuideAgain({
  className = "",
  label = "Show the guide again",
}: {
  className?: string;
  label?: string;
}) {
  const path = usePathname();
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        forgetGuideSeen();
        if (path === "/" || onLabPage(path)) {
          tellGuideToOpen();
          return;
        }
        askGuideAfterNavigation();
        router.push("/");
      }}
      className={`tap transition-colors duration-200 hover:text-accent focus-visible:text-accent ${className}`}
    >
      {label}
    </button>
  );
}
