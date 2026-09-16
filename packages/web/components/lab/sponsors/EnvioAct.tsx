import { BEHIND_BLOCKS } from "@/lib/status/read";
import { isRead, type EnvioStanding, type Reading } from "@/lib/lab/sponsors";
import { Act, Field, Footnote, Missing, count, when } from "./parts";

/**
 * Envio on the footer.
 *
 * The line already carries the index's block. What it never says is the thing
 * the index is for: how close behind the chain it is running. The visible take
 * puts the gap itself on the page, in blocks, because blocks are the only unit
 * the index can actually be measured in.
 */
export function EnvioAct({ reading }: { reading: Reading<EnvioStanding> }) {
  return (
    <Act
      index="04"
      sponsor="Envio"
      heading="Two block numbers nobody subtracts."
      standfirst="The index's own processed block against the chain head, read on this request. The gap is what makes the site feel instant, and today it is left for the reader to work out."
      quiet={isRead(reading) ? <QuietLine standing={reading.read} /> : <Missing why={reading.failed} />}
      visible={isRead(reading) ? <VisibleLine standing={reading.read} /> : <Missing why={reading.failed} />}
    />
  );
}

/** The footer line as it reads now, the same dots and the same two numbers. */
function QuietLine({ standing }: { standing: EnvioStanding }) {
  const behind = standing.behind > BEHIND_BLOCKS;

  return (
    <div>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint">
        <li className="flex items-center gap-2">
          <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-verified" />
          <span>Index</span>
          <span className={behind ? "text-failed" : "text-verified"}>
            {behind ? `behind by ${count(standing.behind)} blocks` : "live"}
          </span>
          <span>block {count(standing.indexBlock)}</span>
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-verified" />
          <span>Chain</span>
          <span className="text-verified">live</span>
          <span>block {count(standing.head)}</span>
        </li>
      </ul>
      <p className="mt-6 max-w-[38ch] text-sm leading-relaxed text-text-faint">
        Two nine digit numbers, one after the other, in eleven pixel type at the bottom of the page. What the gap
        between them is, and whether it is good, is left to the reader.
      </p>
    </div>
  );
}

/** The gap itself, said out loud, with the bar that shows how small it is. */
function VisibleLine({ standing }: { standing: EnvioStanding }) {
  // The bar is the lag against the window the footer already calls "behind", so
  // a healthy index reads as a sliver rather than as a full bar of trouble.
  const share = Math.min(1, standing.behind / BEHIND_BLOCKS);

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">Right now</p>
      <p className="mt-3 font-display text-[clamp(2.6rem,8vw,5.6rem)] font-semibold uppercase leading-[0.86] tracking-[-0.05em] tabular-nums">
        {count(standing.behind)}
        <span className="ms-3 align-top font-mono text-[clamp(0.9rem,2vw,1.3rem)] tracking-[0.06em] text-accent">
          blocks
        </span>
      </p>
      <p className="mt-4 max-w-[34ch] font-display text-[clamp(1.1rem,2.4vw,1.6rem)] font-semibold leading-[1.1] tracking-[-0.03em]">
        behind the chain, and still answering every list on this site.
      </p>

      <div className="mt-8">
        <div className="relative h-[6px] w-full max-w-[26rem] border border-line">
          <span
            aria-hidden
            className="absolute inset-y-0 start-0 bg-accent"
            style={{ width: `${Math.max(1.5, share * 100)}%` }}
          />
        </div>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint tabular-nums">
          against the {count(BEHIND_BLOCKS)} blocks the footer calls behind
        </p>
      </div>

      <dl className="mt-8 grid gap-x-8 gap-y-6 border-t border-line pt-6 sm:grid-cols-2">
        <Field label="Index has processed" value={count(standing.indexBlock)} />
        <Field label="Chain head" value={count(standing.head)} />
        <Field label="Newest registration" value={`block ${count(standing.newestBlock)}`} />
        <Field label="Sealed" value={when(standing.newestAt)} wrap />
        <Field label="Blocks since that one" value={count(standing.sinceNewest)} />
      </dl>

      <Footnote>
        {standing.noSeenTime
          ? "The index keeps the block it has finished processing and nothing about when it got there, so this gap can only honestly be given in blocks. A time would have to be invented, and it is not on this page for that reason."
          : "The index reports when it saw the block, so the gap above can be given as a time."}
      </Footnote>
    </div>
  );
}
