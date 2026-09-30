/**
 * Dreamloom's name set in its own display face: "dream" in ink, "loom" in the
 * daybreak gradient, and a round dot where a full stop would sit.
 */
export function Wordmark({ size = "1.6rem", onDark = false }: { size?: string; onDark?: boolean }) {
  return (
    <span
      className="inline-flex items-baseline font-display leading-none font-extrabold tracking-[-0.045em]"
      style={{ fontSize: size, fontVariationSettings: '"opsz" 96, "wdth" 88' }}
    >
      <span className={onDark ? "text-white" : "text-ink"}>dream</span>
      <span className="text-daybreak">loom</span>
      <span aria-hidden className="bg-daybreak ml-[0.08em] inline-block size-[0.26em] rounded-full" />
    </span>
  );
}
