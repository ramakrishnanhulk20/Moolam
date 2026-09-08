import type { ReactNode } from "react";

/**
 * The repeated mark: a filled accent square. Its shape is decided by the
 * data-motif attribute on a wrapper, so the lab page can show both candidates
 * without either being written into a component.
 */
export function Motif({ size = 10, className = "" }: { size?: number; className?: string }) {
  return <span aria-hidden className={`motif shrink-0 ${className}`} style={{ width: size, height: size }} />;
}

/** The label above every section: the mark, a gap, and small mono capitals. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`flex items-center gap-3 font-mono text-[13px] uppercase tracking-[0.05em] text-accent ${className}`}>
      <Motif />
      {children}
    </p>
  );
}
