"use client";

import { forgetGuideSeen } from "./seen";

/**
 * The way back to the guide for somebody who skipped it and wishes they had
 * not.
 *
 * It belongs in the footer, which every page carries, next to Privacy and
 * Terms. It forgets the mark on this device and opens the guide on the spot, so
 * nobody has to reload anything to see it.
 */
export function ShowGuideAgain({
  onOpen,
  className = "",
  label = "Show the guide again",
}: {
  onOpen: () => void;
  className?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        forgetGuideSeen();
        onOpen();
      }}
      className={`tap transition-colors duration-200 hover:text-accent focus-visible:text-accent ${className}`}
    >
      {label}
    </button>
  );
}
