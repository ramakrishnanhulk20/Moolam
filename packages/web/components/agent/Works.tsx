import { getFormatter, getTranslations } from "next-intl/server";
import { IndexRetry } from "@/components/IndexRetry";
import { WarningMark } from "@/components/WarningMark";
import { Marks, type MarkWords } from "@/components/agents/Marks";
import { isTestCard, type ExplorePlate } from "@/components/explore/sort";
import { Picture } from "@/components/passport/Picture";
import { sealedBits } from "@/components/passport/sealed";
import { SealedSketch } from "@/components/sealed/Sketch";
import { shortHex } from "@/lib/chain/client";
import { pictureSources } from "@/lib/images";
import { Link } from "@/lib/i18n/routing";
import { agentSheetHref, splitTestPlates } from "./signed";

/** The words a plate carries, read once for the whole grid. */
interface PlateWords {
  marks: MarkWords;
  untitled: string;
  noPicture: string;
  seedCard: string;
  sealed: string;
  common: (key: "registeredPicture") => string;
  kind: (kind: number) => string;
  date: (seconds: number) => string;
}

/**
 * What this agent has signed: its real pictures first, drawn as the same
 * plates Explore draws, and its test images folded behind one toggle with
 * their count. An agent that has signed only test images says so in a line
 * and still offers the toggle, so nothing it signed is out of reach.
 *
 * The plates are Explore's own records for this agent, so a passport carries
 * the same aspect, the same marks and the same missing-picture words here as
 * on the sheet the "see all" link opens.
 */
export async function Works({
  agentId,
  works,
  complete = true,
  error,
  locale,
  retry = true,
}: {
  agentId: bigint | string;
  works: ExplorePlate[];
  /** Whether the read reached the agent's oldest passport. Only then may the page say every picture is a test image. */
  complete?: boolean;
  error: string | null;
  locale: string;
  /**
   * Whether a failed read offers the way back here. False when the counts above
   * already show one: both reads refresh the same page, so one countdown is
   * enough and two would ask the shared index twice.
   */
  retry?: boolean;
}) {
  const t = await getTranslations("agent.works");
  const explore = await getTranslations("explore");
  const kinds = await getTranslations("kind");
  const common = await getTranslations("common");
  const format = await getFormatter({ locale });

  const words: PlateWords = {
    marks: {
      manifest: explore("marks.manifest"),
      rechecked: explore("marks.rechecked"),
      chainlink: explore("marks.chainlink"),
      disputed: explore("marks.disputed"),
      sealed: explore("sealed.mark"),
    },
    untitled: explore("untitled"),
    noPicture: explore("noPicture"),
    seedCard: explore("seedCard"),
    sealed: explore("sealed.word"),
    common: (key) => common(key),
    kind: (kind) => kinds(String(kind)),
    date: (seconds) => format.dateTime(new Date(seconds * 1000), { dateStyle: "medium" }),
  };

  const { real, tests } = splitTestPlates(works);

  return (
    <section className="mx-auto w-full max-w-[1400px] px-5 pb-24 sm:px-8 sm:pb-32">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-t border-line pt-10">
        <h2 className="font-display text-[clamp(1.6rem,3.2vw,2.6rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
          {t("heading")}
        </h2>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[10px] uppercase tracking-[0.2em]">
          <span className="text-text-faint">{t("source")}</span>
          <Link
            href={agentSheetHref(agentId)}
            data-agent-see-all
            className="group/all inline-flex items-center gap-3 text-text-muted transition-colors duration-200 hover:text-accent"
          >
            <span
              aria-hidden
              className="h-px w-6 bg-line-strong transition-all duration-300 group-hover/all:w-10 group-hover/all:bg-accent"
            />
            {t("seeAll")}
          </Link>
        </div>
      </div>

      {error !== null ? (
        <div data-index-unread className="mt-10 max-w-[54ch]">
          <p className="flex items-start gap-2.5 text-sm leading-relaxed text-failed">
            <WarningMark className="mt-[3px]" />
            <span className="min-w-0">{t("error", { reason: error })}</span>
          </p>
          {retry ? <IndexRetry said={error} /> : null}
        </div>
      ) : works.length === 0 ? (
        <p className="mt-10 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("empty")}</p>
      ) : (
        <>
          {real.length > 0 ? (
            <PlateGrid plates={real} words={words} className="rise mt-10" />
          ) : complete ? (
            <p data-agent-only-test className="rise mt-10 max-w-[54ch] text-sm leading-relaxed text-text-muted">
              {t("onlyTest")}
            </p>
          ) : null}

          {tests.length === 0 ? null : (
            // A details element rather than a script: the fold works before the
            // page has hydrated, and the browser keeps it keyboard-reachable.
            <details data-agent-tests className="group/tests mt-8">
              <summary className="inline-flex cursor-pointer list-none items-center gap-3 rounded-[8px] border border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="relative h-2.5 w-2.5 shrink-0">
                  <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current" />
                  <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-current transition-transform duration-300 group-open/tests:scale-y-0" />
                </span>
                <span className="group-open/tests:hidden">{t("showTest", { count: tests.length })}</span>
                <span className="hidden group-open/tests:inline">{t("hideTest")}</span>
              </summary>
              <PlateGrid plates={tests} words={words} className="mt-6" />
            </details>
          )}
        </>
      )}
    </section>
  );
}

function PlateGrid({ plates, words, className }: { plates: ExplorePlate[]; words: PlateWords; className: string }) {
  return (
    // The same columns as the Explore sheet, so a plate is the same size on
    // both pages at any width.
    <ul className={`grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-3 xl:grid-cols-4 ${className}`}>
      {/* min-w-0 on the plate or its title sets the grid track: a long word
          reports its full width as its minimum and pushes the column past the
          screen on a phone. */}
      {plates.map((plate) => (
        <li key={plate.id} className="min-w-0 bg-bg">
          <WorkPlate plate={plate} words={words} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One passport as Explore's plate draws it: four by five, the picture under a
 * grain and a scrim, the kind and the marks across the top, the title, the id
 * and the date at the foot. A gateway that will not serve the picture leaves
 * the seal and the same words Explore uses, never a broken image.
 */
function WorkPlate({ plate, words }: { plate: ExplorePlate; words: PlateWords }) {
  const { common } = words;
  const sealed = plate.sealed === true;
  const test = isTestCard(plate.title, plate.id, plate.unread);

  const seal = (
    <span
      data-plate-seal
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-4 pb-16 text-center @[17rem]:gap-4"
    >
      <span className="motif h-6 w-6 shrink-0 opacity-70 transition-opacity duration-500 group-hover:opacity-100 @[17rem]:h-7 @[17rem]:w-7" />
      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-text-faint">{words.noPicture}</span>
    </span>
  );

  return (
    <Link
      href={`/passport/${plate.id}`}
      data-plate={sealed ? "sealed" : "picture"}
      className="group @container relative block aspect-[4/5] min-w-0 overflow-hidden bg-bg-sunken outline-offset-[-2px]"
    >
      {sealed ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 pb-20 pt-12">
          <span aria-hidden className="absolute end-[-18%] top-[-30%] h-[110%] w-[70%] rounded-full bg-accent-soft blur-[48px]" />
          <SealedSketch
            bits={sealedBits(plate.blockhash)}
            size="plate"
            className="relative w-[min(78%,14rem)] transition-transform duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.05]"
          />
        </span>
      ) : plate.thumbnailUrl === null ? (
        seal
      ) : (
        // The pinned thumbnail, the same file a verifier fetches when it
        // re-checks this picture, served through the optimizer so the gateway
        // is read once per file.
        <Picture
          sources={pictureSources(plate.thumbnailUrl)}
          alt={plate.title ?? common("registeredPicture")}
          sizes="(min-width: 1520px) 440px, (min-width: 1280px) 31vw, (min-width: 640px) 42vw, 50vw"
          className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.07]"
          fallback={seal}
        />
      )}

      <span className="grain pointer-events-none absolute inset-0" />
      {/* No cream haze in light: the picture shows at full strength there, as
          on Explore, and the words at the foot carry their own ground. */}
      {sealed ? null : <span data-scrim="dark" className="scrim pointer-events-none absolute inset-0 [.light_&]:hidden" />}
      {sealed ? null : (
        <span
          aria-hidden
          data-scrim="dark"
          className="pointer-events-none absolute inset-x-0 top-0 h-[34%] bg-[linear-gradient(to_bottom,var(--scrim-from),var(--scrim-to))] opacity-80 [.light_&]:hidden"
        />
      )}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 border border-transparent transition-colors duration-500 group-hover:border-accent/60"
      />

      <span className="pointer-events-none absolute inset-x-0 top-0 grid grid-cols-1 content-start items-start gap-x-3 gap-y-2 p-3 @[17rem]:grid-cols-[minmax(0,1fr)_auto]">
        <span className="flex min-w-0 items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-text-muted [overflow-wrap:anywhere] [.light_&]:-mx-1.5 [.light_&]:-my-0.5 [.light_&]:w-fit [.light_&]:rounded-[4px] [.light_&]:bg-bg-raised [.light_&]:px-1.5 [.light_&]:py-0.5">
          <span className="motif h-[7px] w-[7px] shrink-0 opacity-60 transition-opacity duration-500 group-hover:opacity-100" />
          <span className="min-w-0">{words.kind(plate.kind)}</span>
        </span>
        <Marks
          marks={{ ...plate, sealed }}
          words={words.marks}
          className="@[17rem]:justify-end [.light_&]:-mx-1.5 [.light_&]:-my-0.5 [.light_&]:w-fit [.light_&]:rounded-[4px] [.light_&]:bg-bg-raised [.light_&]:px-1.5 [.light_&]:py-0.5"
        />
      </span>

      <span
        data-plate-foot
        className="pointer-events-none absolute inset-x-0 bottom-0 p-3 pt-8 sm:p-4 sm:pt-8 [.light_&]:bg-[linear-gradient(to_bottom,var(--scrim-to)_0,rgb(242_239_233/0.3)_0.9rem,rgb(242_239_233/0.82)_2rem,var(--scrim-from)_calc(100%-4.5rem))]"
      >
        <span className="line-clamp-2 block font-display text-[0.95rem] font-semibold leading-tight tracking-[-0.02em] text-text transition-colors duration-300 group-hover:text-accent sm:text-[1.05rem]">
          {plate.title ?? words.untitled}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          {/* The row is set in capitals, but an id is lower case hex everywhere
              else on the site, and 0X reads as a different value. */}
          <span data-hex className="normal-case">
            {shortHex(plate.id, 6, 4)}
          </span>
          <span aria-hidden className="h-[8px] w-px bg-line-strong" />
          <span>{words.date(plate.registeredAt)}</span>
          {test ? (
            <>
              <span aria-hidden className="h-[8px] w-px bg-line-strong" />
              <span className="text-text-faint">{words.seedCard}</span>
            </>
          ) : null}
          {sealed ? (
            <>
              <span aria-hidden className="h-[8px] w-px bg-line-strong" />
              <span className="text-accent">{words.sealed}</span>
            </>
          ) : null}
        </span>
        <span
          aria-hidden
          className="mt-3 block h-px w-0 bg-accent transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:w-full"
        />
      </span>
    </Link>
  );
}
