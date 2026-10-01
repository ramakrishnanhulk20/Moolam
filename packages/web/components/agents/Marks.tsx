/** What the registry holds about one passport, as the Explore plate lights it. */
export interface PlateMarks {
  manifest: boolean;
  rechecked: boolean;
  /** True when that re-check came through the Chainlink receiver, which changes the R's words. */
  chainlink: boolean;
  /** Whether Chainlink's network wrote the newest verdict, as the index says; left out where it does not say. */
  network?: boolean;
  disputed: boolean;
  sealed?: boolean;
}

/** The words each lit mark carries for a screen reader and a pointer, from the explore messages. */
export interface MarkWords {
  manifest: string;
  rechecked: string;
  chainlink: string;
  /** A Chainlink verdict the index says the network did not write: a run in the simulator. */
  testRun: string;
  /** A Chainlink verdict on an index that does not say yet whether the network wrote it. */
  unconfirmed: string;
  disputed: string;
  sealed: string;
}

/**
 * The R's words and ink, by the trust mark's own rule: only a verdict the
 * index says Chainlink's network wrote is a check and takes the verified ink.
 * A run in the simulator, a verdict the index cannot yet tell apart, and a
 * writer the site cannot name are each said for what they are, in quiet ink.
 */
export function verdictMark(
  marks: Pick<PlateMarks, "chainlink" | "network">,
  words: Pick<MarkWords, "rechecked" | "chainlink" | "testRun" | "unconfirmed">,
): { label: string; tone: "verified" | "quiet" } {
  if (!marks.chainlink) {
    return { label: words.rechecked, tone: "quiet" };
  }
  if (marks.network === true) {
    return { label: words.chainlink, tone: "verified" };
  }
  return { label: marks.network === false ? words.testRun : words.unconfirmed, tone: "quiet" };
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
  const verdict = verdictMark(marks, words);
  const all = [
    { on: marks.manifest, letter: "M", label: words.manifest, tone: "accent" as const },
    { on: marks.rechecked, letter: "R", label: verdict.label, tone: verdict.tone },
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
  tone: "accent" | "verified" | "disputed" | "quiet";
}) {
  // Quiet is a verdict that is not a check: lit, so the letter still says a
  // verdict exists, but never in the verified ink the mark's rule reserves.
  const lit =
    tone === "accent"
      ? "border-accent text-accent"
      : tone === "verified"
        ? "border-verified text-verified"
        : tone === "disputed"
          ? "border-disputed text-disputed"
          : "border-line-strong text-text-muted";

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
