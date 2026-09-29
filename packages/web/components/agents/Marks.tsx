/** What the registry holds about one passport, as the Explore plate lights it. */
export interface PlateMarks {
  manifest: boolean;
  rechecked: boolean;
  /** True when that re-check came through the Chainlink receiver, which changes the R's words. */
  chainlink: boolean;
  disputed: boolean;
  sealed?: boolean;
}

/** The words each lit mark carries for a screen reader and a pointer, from the explore messages. */
export interface MarkWords {
  manifest: string;
  rechecked: string;
  chainlink: string;
  disputed: string;
  sealed: string;
}

/**
 * The marks in the corner of an Explore plate, for the other places the same
 * passport is drawn: the agent page's tiles and the strip on the Agents board.
 * A passport that reads M and R on Explore has to read M and R everywhere, or
 * a reader stops trusting the letters.
 *
 * `litOnly` is for a tile too small to carry three outlines: the strip's
 * tiles are about 60 px wide on a phone, and three empty boxes there would be
 * most of the picture. The lit ones still say exactly what Explore says.
 *
 * Words come in as props so the server page and the client strip share one
 * drawing without either reaching for the other's translation hook.
 */
export function Marks({
  marks,
  words,
  litOnly = false,
  className = "",
}: {
  marks: PlateMarks;
  words: MarkWords;
  litOnly?: boolean;
  className?: string;
}) {
  const all = [
    { on: marks.manifest, letter: "M", label: words.manifest, tone: "accent" as const },
    {
      on: marks.rechecked,
      letter: "R",
      label: marks.chainlink ? words.chainlink : words.rechecked,
      tone: "verified" as const,
    },
    { on: marks.disputed, letter: "D", label: words.disputed, tone: "disputed" as const },
    { on: marks.sealed === true, letter: "S", label: words.sealed, tone: "accent" as const },
  ];
  const shown = litOnly ? all.filter((mark) => mark.on) : all;
  if (shown.length === 0) {
    return null;
  }

  return (
    <span data-plate-marks className={`flex shrink-0 items-center gap-1 ${className}`.trim()}>
      {shown.map((mark) => (
        <Mark key={mark.letter} {...mark} />
      ))}
    </span>
  );
}

function Mark({
  on,
  letter,
  label,
  tone,
}: {
  on: boolean;
  letter: string;
  label: string;
  tone: "accent" | "verified" | "disputed";
}) {
  const lit =
    tone === "accent"
      ? "border-accent text-accent"
      : tone === "verified"
        ? "border-verified text-verified"
        : "border-disputed text-disputed";

  return (
    <span
      role={on ? "img" : undefined}
      aria-label={on ? label : undefined}
      aria-hidden={on ? undefined : true}
      title={on ? label : undefined}
      className={`flex h-[15px] w-[15px] items-center justify-center rounded-[3px] border font-mono text-[8px] leading-none ${
        on ? lit : "border-line-strong/60 text-transparent"
      }`}
    >
      {letter}
    </span>
  );
}
