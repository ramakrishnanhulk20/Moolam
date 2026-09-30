/**
 * Moolam's badge, so it wears Moolam's own dark plate and kolam mark rather
 * than Dreamloom's colours: a visitor should see at a glance that the passport
 * is kept by someone else.
 */
export function PassportBadge({ href, className = "" }: { href: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`group/badge inline-flex items-center gap-1 rounded-full bg-[#14121c]/85 py-1 pr-2.5 pl-1 text-[0.7rem] whitespace-nowrap sm:gap-1.5 sm:pr-3 sm:pl-1.5 sm:text-[0.78rem] font-semibold text-white ring-1 ring-white/15 backdrop-blur-md transition duration-200 hover:scale-[1.04] hover:bg-[#14121c] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sun ${className}`}
    >
      <img src="/moolam-mark.svg" alt="" width={20} height={20} className="size-4 sm:size-5" />
      Moolam passport
      <span className="sr-only">, opens on Moolam's site</span>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="size-3 -translate-x-0.5 opacity-0 transition duration-200 group-hover/badge:translate-x-0 group-hover/badge:opacity-100"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 11l6-6M6 5h5v5" />
      </svg>
    </a>
  );
}
