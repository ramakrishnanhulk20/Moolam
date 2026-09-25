import { Picture } from "@/components/passport/Picture";
import { bitsOf } from "@/lib/chain/fingerprint";
import { Link } from "@/lib/i18n/routing";
import { pictureSources } from "@/lib/images";
import type { TrySample } from "@/lib/data/samples";
import { Billing } from "./Billing";
import { Drop } from "./Drop";
import { Headline, MakeOne } from "./Headline";
import { Play } from "./Play";
import { isRead, type CopyReading, type Finding, type Read } from "./finding";
import { day, recheckLine, statementLine, type Line } from "./lines";
import { SUMMARIES, WORDS } from "./words";

/**
 * The moment, in CSS so it runs from the server's markup without any script:
 * every cell of both fingerprints arrives, the bits the two readings disagree
 * on light up in the accent and then settle back to their true value with a
 * ring left round them, and the verdict rises last. Play.tsx only restarts it
 * when the board is below the fold. A reader who asked for less motion gets the
 * settled board at once, delays included, which the site's global rule alone
 * would not give them.
 */
const MOMENT = `
@keyframes fs-cell { from { opacity: 0.12; } to { opacity: 1; } }
@keyframes fs-lit {
  0%, 12% { background: var(--accent); box-shadow: 0 0 14px var(--accent); transform: scale(1.3); }
  62% { background: var(--accent); box-shadow: 0 0 10px var(--accent); transform: scale(1.12); }
  100% { }
}
@keyframes fs-say { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
@keyframes fs-sweep { from { transform: translateX(-120%); opacity: 0; } 20% { opacity: 1; } to { transform: translateX(420%); opacity: 0; } }
[data-play="go"] .fs-cell { animation: fs-cell 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
[data-play="go"] .fs-lit { animation: fs-cell 0.5s both, fs-lit 1.9s cubic-bezier(0.16, 1, 0.3, 1) 0.35s both; }
[data-play="go"] .fs-say { animation: fs-say 0.8s cubic-bezier(0.16, 1, 0.3, 1) 1.7s both; }
[data-play="go"] .fs-sweep { animation: fs-sweep 1.5s ease-in-out 0.2s both; }
[data-play="wait"] .fs-cell, [data-play="wait"] .fs-lit, [data-play="wait"] .fs-say { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  [data-play] .fs-cell, [data-play] .fs-lit, [data-play] .fs-say { animation: none !important; opacity: 1 !important; }
  [data-play] .fs-sweep { display: none; }
}
`;

/**
 * Drawing B, the evidence board.
 *
 * Split down the middle on a wide screen and stacked on a phone. The left half
 * is the product: the why, the drop and the three real passports. The right
 * half is the proof: the registered picture beside a copy this server mangled
 * a moment ago, each with its 64 bit fingerprint drawn from the real numbers,
 * the one from the registry and the one the verify service read off the copy.
 */
export function Board({
  finding,
  copy,
  samples,
}: {
  finding: Read<Finding>;
  copy: Read<CopyReading>;
  samples: TrySample[];
}) {
  return (
    <section data-drawing="b" data-motif="seal" className="relative bg-bg">
      <style href="moolam-first-screen-moment" precedence="default">
        {MOMENT}
      </style>
      <div className="mx-auto grid min-h-[calc(100svh-var(--header-h))] w-full max-w-[100rem] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)]">
        <div className="flex flex-col justify-between gap-8 px-5 pb-10 pt-12 sm:px-8 lg:px-14 lg:pb-8 lg:pt-[5svh]">
          <div>
            <Headline size="board" />
            <div className="rise mt-7" style={{ animationDelay: "240ms" }}>
              <Drop samples={samples} look="board" />
            </div>
          </div>
          <MakeOne className="rise" />
        </div>

        <Evidence finding={finding} copy={copy} />
      </div>
    </section>
  );
}

function Evidence({ finding, copy }: { finding: Read<Finding>; copy: Read<CopyReading> }) {
  if (!isRead(finding)) {
    return (
      <Panel>
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-failed">
          The finding could not be read this minute: {finding.failed}
        </p>
      </Panel>
    );
  }

  const record = finding.read;
  const original = bitsOf(BigInt(record.phash));
  const measured = isRead(copy) ? bitsOf(BigInt(copy.read.phash)) : null;
  const lines: Line[] = [recheckLine(record), statementLine(record, SUMMARIES)];

  return (
    <Panel>
      <Play className="relative">
        <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
          <span aria-hidden className="relative flex h-2 w-2">
            <span className="absolute inset-0 animate-ping bg-verified/60" />
            <span className="relative h-2 w-2 bg-verified" />
          </span>
          Live finding, read while this page was drawn
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:gap-8">
          <Exhibit
            mark="A"
            label={`Registered on Monad, ${day(record.registeredAt)}`}
            tilt="-rotate-[1.5deg]"
            still={
              record.thumbnail === null ? null : (
                <Picture
                  sources={pictureSources(record.thumbnail)}
                  alt={record.title ?? "The registered picture"}
                  sizes="(min-width: 1024px) 16rem, 45vw"
                  className="object-cover"
                />
              )
            }
            bits={original}
            against={measured}
            caption="Fingerprint in the registry"
          />
          <Exhibit
            mark="B"
            label={isRead(copy) ? `Trimmed, recoloured, re-encoded: ${Math.round(copy.read.bytes / 1000)} KB` : "The copy"}
            tilt="rotate-[2deg]"
            still={
              isRead(copy) ? (
                // The copy is the exact file the verify service was handed, sent
                // inline, so the picture a reader sees is the picture that was
                // measured. It is not in any gateway for the optimizer to fetch.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={copy.read.image}
                  width={copy.read.width}
                  height={copy.read.height}
                  alt="A trimmed, recoloured, re-encoded copy of the registered picture"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : null
            }
            bits={measured}
            against={original}
            caption="Fingerprint the verifier read off the copy"
          />
        </div>

        <Verdict copy={copy} />

        <ul className="mt-6 space-y-2 border-t border-line pt-5">
          {lines.map((line) => (
            <li key={line.lead} className="max-w-[60ch] text-sm leading-relaxed text-text-muted">
              {line.lead}{" "}
              <span className={line.tone === "proof" ? "text-accent" : line.tone === "miss" ? "text-failed" : "text-text"}>
                {line.fact}
              </span>
              .
            </li>
          ))}
        </ul>
        <Link
          href={`/passport/${record.id}`}
          className="mt-4 inline-flex h-11 items-center text-xs uppercase tracking-[0.16em] text-text underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
        >
          {WORDS.openPassport}: {record.title ?? "Untitled"}
        </Link>
        <Billing className="mt-6 border-t border-line pt-5" />
      </Play>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="grain relative overflow-hidden border-t border-line bg-bg-sunken px-5 py-10 sm:px-8 lg:border-l lg:border-t-0 lg:px-12 lg:py-[4svh]">
      {/* A faint rule grid, the board the exhibits are pinned to. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(var(--line)_1px,transparent_1px),linear-gradient(90deg,var(--line)_1px,transparent_1px)] [background-size:48px_48px]"
      />
      <div className="relative">{children}</div>
    </div>
  );
}

function Exhibit({
  mark,
  label,
  tilt,
  still,
  bits,
  against,
  caption,
}: {
  mark: string;
  label: string;
  tilt: string;
  still: React.ReactNode;
  bits: boolean[] | null;
  against: boolean[] | null;
  caption: string;
}) {
  return (
    <figure className="min-w-0">
      <div className={`group relative mx-auto w-full max-w-[13.5rem] transition-transform duration-500 hover:rotate-0 ${tilt}`}>
        <span className="absolute -top-2.5 left-1/2 z-10 h-5 w-16 -translate-x-1/2 rotate-[-3deg] bg-accent/25 backdrop-blur-sm" aria-hidden />
        <div className="grain relative aspect-square overflow-hidden border border-line-strong bg-bg shadow-[0_24px_60px_rgb(0_0_0/0.45)]">
          {still}
          <span className="scrim pointer-events-none absolute inset-0 opacity-40" />
          <span className="absolute left-2 top-2 bg-bg/85 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.2em] text-accent">
            EXHIBIT {mark}
          </span>
        </div>
      </div>
      <figcaption className="mx-auto mt-3 max-w-[13.5rem] text-[11px] leading-snug text-text-muted">{label}</figcaption>
      <div className="mx-auto mt-4 max-w-[13.5rem]">
        <p className="min-h-[2.6em] font-mono text-[9px] uppercase tracking-[0.2em] text-text-faint sm:text-[10px]">{caption}</p>
        {bits === null ? (
          <p className="mt-2 text-xs text-text-faint">Not measured this minute.</p>
        ) : (
          <Grid bits={bits} against={against} />
        )}
      </div>
    </figure>
  );
}

/** 64 bits, eight by eight, highest first. A bit the other reading disagrees on keeps a ring round it. */
function Grid({ bits, against }: { bits: boolean[]; against: boolean[] | null }) {
  return (
    <div className="relative mt-2 w-full max-w-[9.5rem] overflow-hidden">
      <div className="grid aspect-square grid-cols-8 gap-[3px]">
        {bits.map((bit, at) => {
          const apart = against !== null && against[at] !== bit;
          return (
            <span
              key={at}
              className={`${apart ? "fs-lit ring-2 ring-accent ring-offset-1 ring-offset-bg-sunken" : "fs-cell"} ${
                bit ? "bg-text" : "border border-line-strong"
              }`}
              style={{ animationDelay: `${((at * 37) % 64) * 9}ms` }}
            />
          );
        })}
      </div>
      <span
        aria-hidden
        className="fs-sweep pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-transparent via-accent/30 to-transparent"
      />
    </div>
  );
}

function Verdict({ copy }: { copy: Read<CopyReading> }) {
  if (!isRead(copy)) {
    return (
      <p className="mt-8 max-w-[44ch] text-sm leading-relaxed text-text-muted">
        The copy could not be measured this minute: {copy.failed}
      </p>
    );
  }
  const { distance, found } = copy.read;
  return (
    <p data-first-verdict className="fs-say mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="font-display text-[clamp(2.4rem,4.6vw,4.4rem)] font-semibold leading-[0.9] tracking-[-0.045em] tabular-nums text-accent">
        {distance} of 64
      </span>
      <span className="font-display text-[clamp(1.2rem,2vw,1.8rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
        {found ? "bits apart: the same picture." : "bits apart, and the verify service did not find it."}
      </span>
    </p>
  );
}
