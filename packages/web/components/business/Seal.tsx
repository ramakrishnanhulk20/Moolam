/** The kolam seal a passport lands with: the knot inside two rings, in the verified ink. */
export function Seal({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`relative block text-verified ${className}`}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <circle cx="50" cy="50" r="47" fill="var(--bg)" fillOpacity="0.7" />
        <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" strokeWidth="3" />
        <circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 3" />
      </svg>
      <span className="absolute left-1/2 top-1/2 flex h-[44%] w-[44%] -translate-x-1/2 -translate-y-1/2">
        <span className="motif h-full w-full bg-verified" />
      </span>
    </span>
  );
}
