import { Picture } from "@/components/passport/Picture";
import { shortHex } from "@/lib/chain/client";
import { pictureSources } from "@/lib/images";
import { bitsOf, isRead, type ChainlinkRecheck, type Reading } from "@/lib/lab/sponsors";
import { BitGrid } from "./BitGrid";
import { Act, Field, Footnote, Missing, addressLink, count, txLink, when } from "./parts";

/**
 * Chainlink on the passport page.
 *
 * The record is already the first block under the poster. What it is not is
 * legible: the strongest fact on the site arrives as the word "distance" over a
 * number, with a 32 byte hex word underneath. The visible take draws the two
 * fingerprints as the 64 bits they are and says the thing in one sentence.
 */
export function ChainlinkAct({ reading }: { reading: Reading<ChainlinkRecheck> }) {
  return (
    <Act
      index="03"
      sponsor="Chainlink"
      heading="The strongest fact on the site, written as a field called distance."
      standfirst="Both panes are the same re-check on the same picture, read from the registry's own event. The picture is found by the title in its pinned document, not by an id typed into this page."
      quiet={isRead(reading) ? <QuietRow recheck={reading.read} /> : <Missing why={reading.failed} />}
      visible={isRead(reading) ? <VisibleCard recheck={reading.read} /> : <Missing why={reading.failed} />}
    />
  );
}

/** Today's row, word for word: a verdict, three fields and a hex word. */
function QuietRow({ recheck }: { recheck: ChainlinkRecheck }) {
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">The second opinion</p>
      <p className="mt-4 max-w-[15ch] font-display text-[clamp(1.3rem,2.6vw,2rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
        Checked again, by someone else
      </p>

      <div className="mt-7 border border-line bg-bg p-5">
        <p
          className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] ${
            recheck.matched ? "text-verified" : "text-failed"
          }`}
        >
          <span aria-hidden className={`h-2 w-2 ${recheck.matched ? "bg-verified" : "bg-failed"}`} />
          {recheck.matched ? "matched" : "did not match"}
        </p>
        <p className="mt-4 max-w-[22ch] font-display text-[clamp(1.1rem,2.2vw,1.5rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
          {recheck.chainlink ? "Verified independently by Chainlink" : "Written by an allowed receiver"}
        </p>
        <dl className="mt-6 grid gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field label="Distance" value={`${count(recheck.distance)} of 64 bits`} />
          <Field label="At" value={when(recheck.at)} wrap />
        </dl>
        <p className="mt-5 break-all font-mono text-[11px] text-text-faint">
          {`Recomputed pHash 0x${recheck.recomputed.toString(16).padStart(16, "0")}`}
        </p>
      </div>
    </div>
  );
}

/** The same record, drawn: the picture, the two fingerprints, one sentence. */
function VisibleCard({ recheck }: { recheck: ChainlinkRecheck }) {
  const original = bitsOf(recheck.original);
  const recomputed = bitsOf(recheck.recomputed);

  return (
    <div>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
        {/* The poster this card would sit under, at the size it reads at on a
            phone. A film still, not a thumbnail: grain and a scrim over it. */}
        <div className="grain relative aspect-[4/5] w-full max-w-[13rem] shrink-0 overflow-hidden border border-line bg-bg">
          {recheck.picture === null ? (
            <span className="motif absolute inset-0 m-auto h-8 w-8" aria-hidden />
          ) : (
            <Picture sources={pictureSources(recheck.picture)} sizes="208px" className="object-cover" />
          )}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_38%,rgb(0_0_0_/_0.55))]"
          />
        </div>

        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
            {recheck.chainlink ? "Chainlink" : "Allowed receiver"}
          </p>
          <p className="mt-3 max-w-[16ch] font-display text-[clamp(1.8rem,4.6vw,3.2rem)] font-semibold uppercase leading-[0.9] tracking-[-0.045em]">
            {recheck.title}
          </p>
        </div>
      </div>

      <div className="mt-9 flex flex-wrap items-start gap-x-10 gap-y-8 border-t border-line pt-7">
        <BitGrid bits={original} label="Registered fingerprint" tone="original" />
        <BitGrid bits={recomputed} against={original} label="Recomputed by the network" tone="recomputed" />
      </div>

      <p className="mt-9 max-w-[44ch] font-display text-[clamp(1.2rem,2.6vw,1.9rem)] font-semibold leading-[1.15] tracking-[-0.03em]">
        An independent network re-fetched this picture and recomputed its fingerprint:{" "}
        <span className={recheck.counted === 0 ? "text-verified" : "text-failed"}>
          {count(recheck.counted)} of 64 bits apart
        </span>
        .
      </p>

      <dl className="mt-8 grid gap-x-8 gap-y-6 border-t border-line pt-6 sm:grid-cols-2">
        <Field label="Report transaction" value={shortHex(recheck.reportTx, 10, 8)} href={txLink(recheck.reportTx)} />
        <Field label="Report block" value={count(recheck.reportBlock)} />
        <Field label="Written by" value={shortHex(recheck.receiver)} href={addressLink(recheck.receiver)} />
        <Field label="At" value={when(recheck.at)} wrap />
        <Field label="Passport" value={shortHex(recheck.passportId, 10, 8)} />
        <Field label="As the receiver wrote it" value={`${count(recheck.distance)} of 64 bits`} />
      </dl>

      <Footnote>
        The left grid is the fingerprint the registry stored when the picture was registered. The right one is what the
        independent network computed from the file it fetched itself, read out of the report it wrote back on Monad.
        Every cell that disagreed would be marked. The bits are counted on this page and match the distance the
        receiver wrote.
      </Footnote>
    </div>
  );
}
