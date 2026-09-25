"use client";

import { useFormatter, useTranslations } from "next-intl";
import { UseBlock } from "@/components/consent/Marks";
import { SUMMARY_TONES } from "@/components/consent/tones";
import { Picture } from "@/components/passport/Picture";
import { sealedBits } from "@/components/passport/sealed";
import { SealedSketch } from "@/components/sealed/Sketch";
import { shortHex } from "@/lib/chain/client";
import type { PassportStatement } from "@/lib/data/passports";
import { pictureSources } from "@/lib/images";
import { Link } from "@/lib/i18n/routing";
import { isTestCard, type ExplorePlate } from "./sort";

/**
 * One plate: the picture, the seal, and the three marks that say what the
 * registry holds about it.
 *
 * The same language as the plates in the film on the home page, drawn in CSS
 * rather than WebGL because a grid of forty of them has to work on a phone.
 * A gateway that will not serve the picture leaves the plate dark with the seal
 * on it, never a broken image icon. A sealed passport is a different thing
 * again: there is no picture to serve, so the plate draws the block hash and
 * says sealed, in the corner and in words.
 *
 * `first` marks a plate in the row a reader can see before scrolling. Its
 * picture is named in the head of the page and fetched ahead of the rest, which
 * is what the browser needs to paint the sheet early; every other plate is left
 * to load as it comes into view.
 */
export function Plate({ plate, first = false }: { plate: ExplorePlate; first?: boolean }) {
  const t = useTranslations("explore");
  const kinds = useTranslations("kind");
  const common = useTranslations("common");
  const format = useFormatter();
  const test = isTestCard(plate.title, plate.id);
  const sealed = plate.sealed === true;

  const seal = (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="motif h-7 w-7 opacity-70 transition-opacity duration-500 group-hover:opacity-100" />
      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-text-faint">{t("noPicture")}</span>
    </span>
  );

  // A grid rather than a row with the two ends pushed apart: the kind and the
  // letters can never be drawn over each other, whatever the language or the
  // plate's width. On a plate narrower than 17rem, which is every plate on a
  // phone, the letters take a line of their own under the kind.
  const top = (
    <span
      data-plate-top
      className={`pointer-events-none grid grid-cols-1 content-start items-start gap-x-3 gap-y-2 p-3 @[17rem]:grid-cols-[minmax(0,1fr)_auto] ${
        sealed ? "relative shrink-0" : "absolute inset-x-0 top-0"
      }`}
    >
      {/* A sealed plate on a phone has its marks in a column beside the
          drawing, and no width there for the kind as well; the kind waits for
          a wider plate or the passport page. */}
      <span
        data-plate-kind
        className={`min-w-0 items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-text-muted [overflow-wrap:anywhere] ${
          sealed ? "hidden @[17rem]:flex" : "flex"
        }`}
      >
        <span className="motif h-[7px] w-[7px] shrink-0 opacity-60 transition-opacity duration-500 group-hover:opacity-100" />
        <span className="min-w-0">{kinds(String(plate.kind))}</span>
      </span>
      <span data-plate-marks className="flex shrink-0 items-center gap-1 @[17rem]:row-span-2 @[17rem]:justify-end">
        <Mark on={plate.manifest} letter="M" label={t("marks.manifest")} tone="accent" />
        <Mark
          on={plate.rechecked}
          letter="R"
          label={plate.chainlink ? t("marks.chainlink") : t("marks.rechecked")}
          tone="verified"
        />
        <Mark on={plate.disputed} letter="D" label={t("marks.disputed")} tone="failed" />
        <Mark on={sealed} letter="S" label={t("sealed.mark")} tone="accent" />
      </span>
      {/* On a narrow plate the word sits under its letter instead of taking a
          third line at the foot, which is height the drawing needs. The lit S
          already carries it for a screen reader. */}
      {sealed ? (
        <span aria-hidden className="font-mono text-[9px] uppercase tracking-[0.2em] text-accent @[17rem]:hidden">
          {t("sealed.word")}
        </span>
      ) : null}
      {/* Truthiness rather than a null test: a sheet held from the minute
          before this shipped has plates with no such field at all. */}
      {plate.consent ? (
        <span className="mt-0.5 flex">
          <Statement statement={plate.consent} />
        </span>
      ) : null}
    </span>
  );

  return (
    <Link
      href={`/passport/${plate.id}`}
      data-plate={sealed ? "sealed" : "picture"}
      className={`group @container relative aspect-[4/5] min-w-0 overflow-hidden bg-bg-sunken outline-offset-[-2px] ${
        sealed ? "flex flex-col" : "block"
      }`}
    >
      {sealed ? (
        // The block hash drawn, which is the only trace of a sealed picture
        // anyone outside the creator ever sees. The plate is a column here: the
        // marks and the drawing in whatever height is left, then the words on a
        // ground of their own. A two line title and a date that wraps on a
        // phone used to climb up into the lit cells; now the drawing gives way
        // to them, and to the marks, which stand above it on a wide plate and
        // beside it on a phone.
        <span className="relative flex min-h-0 flex-1 flex-row @[17rem]:flex-col">
          {top}
          <span
            data-sealed-drawing
            className="pointer-events-none relative flex min-h-0 min-w-0 flex-1 items-start justify-center pb-2 pe-3 pt-3 [container-type:size] @[17rem]:px-3 @[17rem]:pb-3 @[17rem]:pt-0"
          >
            <span
              aria-hidden
              className="pointer-events-none absolute end-[-18%] top-[-30%] h-[110%] w-[70%] rounded-full bg-accent-soft blur-[48px]"
            />
            <SealedSketch
              bits={sealedBits(plate.blockhash)}
              size="plate"
              className="relative h-[min(100cqw,100cqh)] w-[min(100cqw,100cqh)] transition-transform duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.05]"
            />
          </span>
        </span>
      ) : plate.thumbnailUrl === null ? (
        seal
      ) : (
        // The pinned thumbnail, the same file a verifier fetches when it
        // re-checks this picture, served through the optimizer so a grid of
        // forty plates costs the gateway nothing after the first view.
        <Picture
          sources={pictureSources(plate.thumbnailUrl)}
          alt={plate.title ?? common("registeredPicture")}
          // A plate is four wide by five tall and the picture covers it, so what
          // the browser has to fetch is the plate's HEIGHT, not its width. The
          // old widths were the column widths, which had a 1440 px laptop
          // painting a 316 px picture into a 416 px box, and about twice that on
          // a 1.5 density screen. Each number below is a column plus the quarter
          // again the height asks for. Two columns on a phone keep the width
          // they had: the next size up the optimizer offers is the whole 512 px
          // thumbnail, which is 57 per cent more bytes for nine per cent more
          // picture, and a phone is the one place that trade is wrong.
          sizes="(min-width: 1520px) 440px, (min-width: 1280px) 31vw, (min-width: 640px) 42vw, 50vw"
          priority={first}
          className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.07]"
          fallback={seal}
        />
      )}

      <span className="grain pointer-events-none absolute inset-0" />
      {sealed ? null : <span className="scrim pointer-events-none absolute inset-0" />}
      {/* The same scrim turned over, so the kind, the letters and the AI-use
          marks keep their ground on a bright sky or a white shirt the way the
          title does at the foot. Quieter than the foot's: there is less to
          read up here, and most of the picture should still show. */}
      {sealed ? null : (
        <span
          aria-hidden
          data-plate-top-scrim
          className="pointer-events-none absolute inset-x-0 top-0 h-[34%] bg-[linear-gradient(to_bottom,var(--scrim-from),var(--scrim-to))] opacity-80"
        />
      )}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 border border-transparent transition-colors duration-500 group-hover:border-accent/60"
      />

      {sealed ? null : top}

      <span
        data-plate-foot
        className={`pointer-events-none p-3 sm:p-4 ${
          sealed ? "relative border-t border-line bg-bg-raised" : "absolute inset-x-0 bottom-0 pt-8"
        }`}
      >
        {/* Two lines, not one with a tail of dots. At 375 px a plate is 166 px
            wide and almost every real title was cut: "Monsoon Fishing Nets
            Drying" arrived as "Monsoon Fishing N...". */}
        <span className="line-clamp-2 block font-display text-[0.95rem] font-semibold leading-tight tracking-[-0.02em] text-text transition-colors duration-300 group-hover:text-accent sm:text-[1.05rem]">
          {plate.title ?? t("untitled")}
        </span>
        {/* The id and the date are the two things a reader checks a plate by, so
            they are read at 11 px in muted ink rather than 9 px in the faintest,
            which measured 3.4:1 on the light theme. */}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          <span>{shortHex(plate.id, 6, 4)}</span>
          <span aria-hidden className="h-[8px] w-px bg-line-strong" />
          <span>{format.dateTime(new Date(plate.registeredAt * 1000), { dateStyle: "medium" })}</span>
          {test ? (
            <>
              <span aria-hidden className="h-[8px] w-px bg-line-strong" />
              <span className="text-text-faint">{t("seedCard")}</span>
            </>
          ) : null}
          {/* The letter in the corner is the mark; this is the word, so the
              plate says sealed to a reader who is not hovering anything. */}
          {sealed ? (
            <span className="hidden items-center gap-x-2 @[17rem]:flex">
              <span aria-hidden className="h-[8px] w-px bg-line-strong" />
              <span className="text-accent">{t("sealed.word")}</span>
            </span>
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

/**
 * What the holder said about AI use, drawn on the picture itself.
 *
 * The same four marks and the same colours as the passport page, small enough
 * to sit under the kind and far from the three letters in the other corner: a
 * statement is a different kind of fact from a re-check, and the two should not
 * read as one row of badges. A picture nobody has spoken for carries nothing at
 * all, because silence is drawn as silence.
 *
 * The block already reads its four uses out for a screen reader. Here the
 * statement and its date are what a reader browsing a sheet of forty needs, so
 * the wrapper takes that reading and the marks inside it become decoration.
 */
function Statement({ statement }: { statement: PassportStatement }) {
  const t = useTranslations("explore");
  const summaries = useTranslations("passport.consent.summary");
  const format = useFormatter();

  const said = t("ai.mark", {
    statement: summaries(statement.summary),
    when: format.dateTime(new Date(statement.at * 1000), { dateStyle: "medium" }),
  });

  return (
    <span
      role="img"
      aria-label={said}
      title={said}
      className={`opacity-80 transition-opacity duration-500 group-hover:opacity-100 ${
        SUMMARY_TONES[statement.summary].ink
      }`}
    >
      <UseBlock consent={statement.uses} size="h-2 w-2" />
    </span>
  );
}

/**
 * One of the three marks. Lit when the registry says so, a dim outline when it
 * does not.
 *
 * A lit mark carries its meaning as a label rather than as hidden text beside
 * it: a title never fires under a thumb, and the letter on its own said nothing
 * to anybody on a phone. An unlit mark is a place holder in a row of three, so
 * it is left out of the reading altogether rather than announcing an absence
 * three times on every plate of a sheet of forty.
 */
function Mark({
  on,
  letter,
  label,
  tone,
}: {
  on: boolean;
  letter: string;
  label: string;
  tone: "accent" | "verified" | "failed";
}) {
  const lit =
    tone === "accent"
      ? "border-accent text-accent"
      : tone === "verified"
        ? "border-verified text-verified"
        : "border-failed text-failed";

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
