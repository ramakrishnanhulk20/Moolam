import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Picture } from "@/components/passport/Picture";
import { bitsOf } from "@/lib/chain/fingerprint";
import { Link } from "@/lib/i18n/routing";
import { pictureSources } from "@/lib/images";
import type { TrySample } from "@/lib/data/samples";
import { Billing } from "./Billing";
import { Drop } from "./Drop";
import { Headline, MakeOne } from "./Headline";
import { Play } from "./Play";
import { isRead, type CopyReading, type Finding, type LooseFinding, type Read } from "./finding";

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
 * The home page's first screen: the evidence board, drawing B on the bench.
 *
 * Split down the middle on a wide screen and stacked on a phone. The left half
 * is the product: the why, the drop and the three real passports. The right
 * half is the proof: the registered picture beside a copy this server mangled
 * when the site was built, each with its 64 bit fingerprint drawn from the real
 * numbers, the one from the registry and the one the verify service read off
 * the copy.
 *
 * Every figure on the right is shown only if it was read. A copy that could not
 * be measured takes its exhibit and its verdict with it and leaves the chain's
 * own facts; a registry that would not answer leaves the picture and its name.
 */
export function Board({
  finding,
  copy,
  samples,
  loose = null,
}: {
  finding: Read<Finding>;
  copy: Read<CopyReading>;
  samples: TrySample[];
  loose?: LooseFinding | null;
}) {
  return (
    <section data-drawing="b" data-motif="seal" className="relative bg-bg">
      <style href="moolam-first-screen-moment" precedence="default">
        {MOMENT}
      </style>
      <div className="mx-auto grid min-h-[calc(100svh-var(--header-h))] w-full max-w-[100rem] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)]">
        <div className="flex flex-col justify-between gap-8 px-5 pb-10 pt-12 sm:px-8 lg:gap-5 lg:px-14 lg:pb-6 lg:pt-[3.5svh]">
          <div>
            <Headline size="board" />
            <div className="rise mt-7 lg:mt-6" style={{ animationDelay: "240ms" }}>
              <Drop samples={samples} look="board" />
            </div>
          </div>
          <MakeOne className="rise" />
        </div>

        <Panel>
          {isRead(finding) ? <Evidence finding={finding.read} copy={copy} /> : <Loose loose={loose} />}
        </Panel>
      </div>
    </section>
  );
}

/** One sentence of the finding: the lead in quiet ink and the fact in bright. */
interface Line {
  lead: string;
  fact: string;
  /** How the fact is inked: the accent for the proof, plain for the rest, the cold status colour for a miss. */
  tone: "proof" | "plain" | "miss";
}

/** A chain second as a date a stranger reads at a glance, in their own language. */
function useDay(): (seconds: number) => string {
  const format = useFormatter();
  return (seconds) => format.dateTime(new Date(seconds * 1000), { dateStyle: "medium", timeZone: "UTC" });
}

/** What the holder said about AI use, in the product's own words for it, the ones the passport card prints. */
function useStatementLine(): (statement: Finding["statement"]) => Line {
  const t = useTranslations("home.first");
  const says = useTranslations("passport.consent.summary");
  const day = useDay();
  return (statement) =>
    statement === null
      ? { lead: t("aiUse"), fact: says("none"), tone: "plain" }
      : { lead: t("statedOn", { date: day(statement.at) }), fact: says(statement.summary), tone: "plain" };
}

function Evidence({ finding, copy }: { finding: Finding; copy: Read<CopyReading> }) {
  const t = useTranslations("home.first");
  const verify = useTranslations("verify");
  const day = useDay();
  const stated = useStatementLine();
  const original = bitsOf(BigInt(finding.phash));
  const measured = isRead(copy) ? bitsOf(BigInt(copy.read.phash)) : null;

  // Only a re-check written through one of the Chainlink receivers is named
  // here: read.ts keeps every other writer out of it.
  const { recheck } = finding;
  const apart = recheck === null ? "" : verify("bits", { count: recheck.distance, of: 64 });
  const rechecked: Line =
    recheck === null
      ? { lead: t("chainlink"), fact: t("recheckNone"), tone: "plain" }
      : recheck.matched
        ? { lead: t("recheckOn", { date: day(recheck.at) }), fact: apart, tone: "proof" }
        : { lead: t("recheckOn", { date: day(recheck.at) }), fact: t("recheckMissed", { bits: apart }), tone: "miss" };
  // A register that would not answer is left out rather than reported: the
  // column only ever says what was read.
  const lines: Line[] = [rechecked, ...(finding.statementError === null ? [stated(finding.statement)] : [])];

  return (
    <Play className="relative">
      <LiveMark />

      <div className={`mt-6 grid gap-4 sm:gap-8 ${isRead(copy) ? "grid-cols-2" : "max-w-[15rem] grid-cols-1"}`}>
        <Exhibit
          mark="A"
          label={t("registered", { date: day(finding.registeredAt) })}
          tilt="-rotate-[1.5deg]"
          still={<Registered thumbnail={finding.thumbnail} title={finding.title} />}
          print={{ caption: t("printRegistry"), bits: original, against: measured }}
        />
        {isRead(copy) && measured !== null ? (
          <Exhibit
            mark="B"
            label={t("copied", { date: day(copy.read.measuredAt / 1000), size: Math.round(copy.read.bytes / 1000) })}
            tilt="rotate-[2deg]"
            still={
              // The copy is the exact file the verify service was handed, sent
              // inline, so the picture a reader sees is the picture that was
              // measured. It is not in any gateway for the optimizer to fetch.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={copy.read.image}
                width={copy.read.width}
                height={copy.read.height}
                alt={t("copyAlt")}
                className="absolute inset-0 h-full w-full object-cover"
              />
            }
            print={{ caption: t("printCopy"), bits: measured, against: original }}
          />
        ) : null}
      </div>

      {isRead(copy) ? <Verdict copy={copy.read} /> : null}

      <Lines lines={lines} />
      <OpenPassport id={finding.id} title={finding.title} />
    </Play>
  );
}

/** What is left without the registry: the picture, its name and, if the register answered, the holder's word. */
function Loose({ loose }: { loose: LooseFinding | null }) {
  const verify = useTranslations("verify");
  const stated = useStatementLine();
  if (loose === null) {
    return null;
  }
  const shown = loose.title !== null || loose.thumbnail !== null;
  const lines: Line[] = loose.statement === null ? [] : [stated(loose.statement)];

  return (
    <div data-first-loose className="relative">
      <LiveMark />
      {shown ? (
        <div className="mt-6 grid max-w-[15rem] grid-cols-1">
          <Exhibit
            mark="A"
            label={loose.title ?? verify("untitled")}
            tilt="-rotate-[1.5deg]"
            still={<Registered thumbnail={loose.thumbnail} title={loose.title} />}
          />
        </div>
      ) : null}
      <Lines lines={lines} />
      <OpenPassport id={loose.id} title={loose.title} />
    </div>
  );
}

function LiveMark() {
  const t = useTranslations("home.first");

  return (
    <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
      <span aria-hidden className="relative flex h-2 w-2">
        <span className="absolute inset-0 animate-ping bg-verified/60" />
        <span className="relative h-2 w-2 bg-verified" />
      </span>
      {t("live")}
    </p>
  );
}

function Registered({ thumbnail, title }: { thumbnail: string | null; title: string | null }) {
  const t = useTranslations("home.first");

  return thumbnail === null ? null : (
    <Picture
      sources={pictureSources(thumbnail)}
      alt={title ?? t("pictureAlt")}
      sizes="(min-width: 1024px) 16rem, 45vw"
      className="object-cover"
    />
  );
}

function Lines({ lines }: { lines: Line[] }) {
  const t = useTranslations("home.first");

  if (lines.length === 0) {
    return null;
  }
  return (
    <ul className="mt-6 space-y-2 border-t border-line pt-5 lg:mt-5 lg:space-y-1.5 lg:pt-4">
      {lines.map((line) => (
        <li key={line.lead} className="max-w-[60ch] text-sm leading-relaxed text-text-muted">
          {line.lead}{" "}
          <span className={line.tone === "proof" ? "text-accent" : line.tone === "miss" ? "text-failed" : "text-text"}>
            {line.fact}
          </span>
          {t("stop")}
        </li>
      ))}
    </ul>
  );
}

function OpenPassport({ id, title }: { id: string; title: string | null }) {
  const t = useTranslations("home.first");
  const verify = useTranslations("verify");

  return (
    <Link
      href={`/passport/${id}`}
      className="mt-4 inline-flex h-11 items-center text-xs uppercase lg:mt-2 tracking-[0.16em] text-text underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
    >
      {t("openPassport", { title: title ?? verify("untitled") })}
    </Link>
  );
}

/** The right half, with the sponsor line along its foot whatever was read above it. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="grain relative flex flex-col justify-between gap-6 overflow-hidden border-t border-line bg-bg-sunken px-5 py-10 sm:px-8 lg:gap-4 lg:border-l lg:border-t-0 lg:px-12 lg:py-[3svh]">
      {/* A faint rule grid, the board the exhibits are pinned to. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(var(--line)_1px,transparent_1px),linear-gradient(90deg,var(--line)_1px,transparent_1px)] [background-size:48px_48px]"
      />
      <div className="relative">{children}</div>
      <Billing className="relative border-t border-line pt-5 lg:pt-4" />
    </div>
  );
}

function Exhibit({
  mark,
  label,
  tilt,
  still,
  print,
}: {
  mark: string;
  label: string;
  tilt: string;
  still: React.ReactNode;
  print?: { caption: string; bits: boolean[]; against: boolean[] | null };
}) {
  const t = useTranslations("home.first");

  return (
    <figure className="min-w-0">
      <div className={`group relative mx-auto w-full max-w-[13.5rem] transition-transform duration-500 hover:rotate-0 lg:max-w-[12rem] ${tilt}`}>
        <span className="absolute -top-2.5 left-1/2 z-10 h-5 w-16 -translate-x-1/2 rotate-[-3deg] bg-accent/25 backdrop-blur-sm" aria-hidden />
        <div className="grain relative aspect-square overflow-hidden border border-line-strong bg-bg shadow-[0_24px_60px_rgb(0_0_0/0.45)]">
          {still}
          <span className="scrim pointer-events-none absolute inset-0 opacity-40" />
          <span className="absolute left-2 top-2 bg-bg/85 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
            {t("exhibit", { mark })}
          </span>
        </div>
      </div>
      <figcaption className="mx-auto mt-3 max-w-[13.5rem] text-[11px] leading-snug text-text-muted lg:max-w-[12rem]">{label}</figcaption>
      {print === undefined ? null : (
        <div className="mx-auto mt-4 max-w-[13.5rem] lg:mt-3 lg:max-w-[12rem]">
          <p className="min-h-[2.6em] font-mono text-[9px] uppercase tracking-[0.2em] text-text-faint sm:text-[10px]">
            {print.caption}
          </p>
          <Grid bits={print.bits} against={print.against} />
        </div>
      )}
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

function Verdict({ copy }: { copy: CopyReading }) {
  const t = useTranslations("home.first");
  // The figure carries Tamil letters in Tamil ("64-இல் 5"), and the tight
  // Latin leading lets its marks run into the sentence under it.
  const tamil = useLocale() === "ta";
  const { distance, found } = copy;
  return (
    <p data-first-verdict className="fs-say mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 lg:mt-5">
      <span
        className={`font-display text-[clamp(2.4rem,4.6vw,4.4rem)] font-semibold tracking-[-0.045em] tabular-nums text-accent ${
          tamil ? "leading-[1.15]" : "leading-[0.9]"
        }`}
      >
        {t("verdictFigure", { count: distance })}
      </span>
      <span
        className={`font-display text-[clamp(1.2rem,2vw,1.8rem)] font-semibold tracking-[-0.03em] ${
          tamil ? "leading-[1.3]" : "leading-[1.05]"
        }`}
      >
        {found ? t("verdictSame") : t("verdictMissed")}
      </span>
    </p>
  );
}
