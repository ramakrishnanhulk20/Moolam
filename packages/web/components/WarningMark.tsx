/**
 * The failure mark: an octagon, which is the seal's square with its corners
 * cut, and an exclamation whose dot is the seal's filled square. It takes the
 * colour of the line it stands in, so a failure line sets text-failed once and
 * the mark and the words match.
 *
 * An octagon rather than a triangle because it marks a thing that stopped, not
 * a caution, and the stop shape reads that way without a word. It carries no
 * words of its own: the sentence beside it says what went wrong.
 */
export function WarningMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={`inline-block shrink-0 ${className}`.trim()}
    >
      <polygon points="4.6,1 9.4,1 13,4.6 13,9.4 9.4,13 4.6,13 1,9.4 1,4.6" />
      <line x1="7" y1="3.9" x2="7" y2="7.7" />
      <rect x="6.3" y="9.3" width="1.4" height="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
