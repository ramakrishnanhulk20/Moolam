"use client";

import { GUIDE_OPEN_EVENT } from "./FirstVisitGuide";
import { forgetGuideSeen } from "./seen";

/**
 * The way back to the guide for somebody who skipped it and wishes they had
 * not.
 *
 * It belongs in the footer, which every page carries, next to Privacy and
 * Terms. It forgets the mark on this device and shouts, and whichever page is
 * carrying the guide hears it and opens: no reload, and no state shared between
 * a layout and a page that never meet in the tree.
 *
 * The label is handed in, like the bottom bar's, because the caller is the one
 * that knows which language the footer is being read in.
 */
export function ShowGuideAgain({
  onOpen,
  className = "",
  label = "Show the guide again",
}: {
  /** The bench passes its own opener. On the real footer the event is enough. */
  onOpen?: () => void;
  className?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        forgetGuideSeen();
        window.dispatchEvent(new Event(GUIDE_OPEN_EVENT));
        onOpen?.();
      }}
      className={`tap transition-colors duration-200 hover:text-accent focus-visible:text-accent ${className}`}
    >
      {label}
    </button>
  );
}
