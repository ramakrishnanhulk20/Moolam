"use client";

import { useLinkStatus } from "next/link";
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
 * One plate: the picture, the kolam mark, and the three marks that say what the
 * registry holds about it.
 *
 * The same language as the plates in the film on the home page, drawn in CSS
 * rather than WebGL because a grid of forty of them has to work on a phone.
 * A gateway that will not serve the picture leaves the plate dark with the kolam
 * mark on it, never a broken image icon. A sealed passport is a different thing
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
  const test = isTestCard(plate.title, plate.id, plate.unread === true);
  const sealed = plate.sealed === true;

  // Centred on the whole plate, the kolam mark sat under the title and the id on a
  // phone, where the words at the foot take more than half of a 166 px plate.
  // It is in the flow instead, between the marks and the title, and the plate
  // reads the attribute to turn into a column around it. That holds for a
  // gateway that fails after the page is drawn as well, because the mark
  // arrives as the picture's own fallback.
  const seal = (
    <span
      data-plate-seal
      className="pointer-events-none relative flex min-h-[5rem] flex-1 flex-col items-center justify-center gap-2.5 px-4 py-3 text-center @[17rem]:gap-4"
    >
      <span className="motif h-6 w-6 shrink-0 opacity-70 transition-opacity duration-500 group-hover:opacity-100 @[17rem]:h-7 @[17rem]:w-7" />
      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-text-faint">{t("noPicture")}</span>
    </span>
  );

  // Every no-picture class hangs off the kolam mark being there, so a picture
  // plate keeps the overlay it always had.
  const ifSeal = {
    plate: "has-[[data-plate-seal]]:flex has-[[data-plate-seal]]:flex-col has-[[data-plate-seal]]:overflow-visible",
    top: "group-has-[[data-plate-seal]]:relative group-has-[[data-plate-seal]]:order-first",
    foot: "group-has-[[data-plate-seal]]:relative group-has-[[data-plate-seal]]:pt-3 [.light_&]:group-has-[[data-plate-seal]]:pt-3",
  };

  // On a plate narrower than 17rem, every plate on a phone, the top and the
  // foot used to be pinned to opposite edges independently, and a two line
  // title under a platform line climbed over the letters and the AI-use marks.
  // There both join the plate's flow instead: the foot is pushed to the bottom
  // when there is room, and when there is not it starts where the top ends and
  // the plate grows, the way a plate with no picture already does. It can grow
  // because it clips rather than hides: a box that hides its overflow is held
  // to its four by five, and one that clips is not. The top gives back the
  // foot's empty fade padding, so the words of the foot start exactly where the
  // top's own padding ends. That padding is pinned to 2rem here in both themes,
  // since sm:p-4 would otherwise leave dark with less than the top gives back. The top is lifted over the fade so its tags keep their
  // ground, and the pressed plate's veil is lifted over the top in turn. A
  // plate with the kolam mark in its flow keeps the column it already had.
  const narrow = {
    plate: "supports-[overflow:clip]:overflow-clip",
    top: "@max-[17rem]:relative @max-[17rem]:z-[1] @max-[17rem]:-mb-8 group-has-[[data-plate-seal]]:mb-0",
    foot: "@max-[17rem]:relative @max-[17rem]:mt-auto @max-[17rem]:pt-8",
  };

  // In light the picture has no band across its top, so each group of words
  // up here stands on a small tag of the page's own ground instead. The tag
  // reaches out past the words by its own padding, so the words sit exactly
  // where they sit in dark. A sealed plate has no picture under its marks.
  const ground = sealed
    ? ""
    : "[.light_&]:-mx-1.5 [.light_&]:-my-0.5 [.light_&]:w-fit [.light_&]:rounded-[4px] [.light_&]:bg-bg-raised [.light_&]:px-1.5 [.light_&]:py-0.5";

  // A grid rather than a row with the two ends pushed apart: the kind and the
  // letters can never be drawn over each other, whatever the language or the
  // plate's width. On a plate narrower than 17rem, which is every plate on a
  // phone, the letters take a line of their own under the kind.
  const top = (
    <span
      data-plate-top
      className={`pointer-events-none grid grid-cols-1 content-start items-start gap-x-3 gap-y-2 p-3 @[17rem]:grid-cols-[minmax(0,1fr)_auto] ${
        sealed ? "relative shrink-0" : `absolute inset-x-0 top-0 ${ifSeal.top} ${narrow.top}`
      }`}
    >
      {/* A sealed plate on a phone has its marks in a column beside the
          drawing, and no width there for the kind as well; the kind waits for
          a wider plate or the passport page. */}
      <span
        data-plate-kind
        className={`min-w-0 items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-text-muted [overflow-wrap:anywhere] ${
          sealed ? "hidden @[17rem]:flex" : "flex"
        } ${ground}`}
      >
        <span className="motif h-[7px] w-[7px] shrink-0 opacity-60 transition-opacity duration-500 group-hover:opacity-100" />
        <span className="min-w-0">{kinds(String(plate.kind))}</span>
      </span>
      <span
        data-plate-marks
        className={`flex shrink-0 items-center gap-1 @[17rem]:row-span-2 @[17rem]:justify-end ${ground}`}
      >
        <Mark on={plate.manifest} letter="M" label={t("marks.manifest")} tone="accent" />
        <Mark
          on={plate.rechecked}
          letter="R"
          label={plate.chainlink ? t("marks.chainlink") : t("marks.rechecked")}
          tone="verified"
        />
        <Mark on={plate.disputed} letter="D" label={t("marks.disputed")} tone="disputed" />
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
        <span className={`mt-0.5 flex ${ground}`}>
          <Statement statement={plate.consent} />
        </span>
      ) : null}
    </span>
  );

  return (
    <Link
      href={`/passport/${plate.id}`}
      data-plate={sealed ? "sealed" : "picture"}
      className={`group @container relative aspect-[4/5] min-w-0 grow overflow-hidden bg-bg-sunken outline-offset-[-2px] ${
        sealed ? "flex flex-col" : `flex flex-col ${narrow.plate} ${ifSeal.plate}`
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
      {/* Dark keeps the poster gradient over the whole plate. In light both
          scrims are cream, and over most of the still they read as a pale
          haze, so light draws neither: the foot carries its own ground behind
          the words, and the top has its tags. */}
      {sealed ? null : (
        <span data-scrim="dark" className="scrim pointer-events-none absolute inset-0 [.light_&]:hidden" />
      )}
      {/* The same scrim turned over, so the kind, the letters and the AI-use
          marks keep their ground on a bright sky or a white shirt the way the
          title does at the foot. Quieter than the foot's: there is less to
          read up here, and most of the picture should still show. */}
      {sealed ? null : (
        <span
          aria-hidden
          data-plate-top-scrim
          className="pointer-events-none absolute inset-x-0 top-0 h-[34%] bg-[linear-gradient(to_bottom,var(--scrim-from),var(--scrim-to))] opacity-80 [.light_&]:hidden"
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
          // In light the foot is its own scrim: clear through its empty top
          // padding, thick enough under the title, then the full scrim under
          // the id and the date, which are the smaller and paler words. The
          // padding is pinned at 2rem there because sm:p-4 otherwise wins over
          // pt-8 on a wide screen and the title would start inside the fade.
          sealed
            ? "relative border-t border-line bg-bg-raised"
            : `absolute inset-x-0 bottom-0 pt-8 [.light_&]:pt-8 [.light_&]:bg-[linear-gradient(to_bottom,var(--scrim-to)_0,rgb(242_239_233/0.3)_0.9rem,rgb(242_239_233/0.82)_2rem,var(--scrim-from)_calc(100%-4.5rem))] ${ifSeal.foot} ${narrow.foot}`
        }`}
      >
        {/* Truthiness, like the statement above: a sheet held from before
            this field existed has no such key. The name is printed as the
            signed list spells it, so it is never set in capitals. */}
        {plate.platform ? <PlatformMark text={t("marks.platform", { platform: plate.platform })} /> : null}
        {/* Two lines, not one with a tail of dots. At 375 px a plate is 166 px
            wide and almost every real title was cut: "Monsoon Fishing Nets
            Drying" arrived as "Monsoon Fishing N...". */}
        <span className="line-clamp-2 font-display text-[0.95rem] font-semibold leading-tight tracking-[-0.02em] text-text transition-colors duration-300 group-hover:text-accent sm:text-[1.05rem]">
          {plate.title ?? t("untitled")}
        </span>
        {/* The id and the date are the two things a reader checks a plate by, so
            they are read at 11 px in muted ink rather than 9 px in the faintest,
            which measured 3.4:1 on the light theme. */}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          {/* The row is set in capitals, but an id is lower case hex everywhere
              else on the site, and 0X reads as a different value. */}
          <span data-plate-id className="normal-case">
            {shortHex(plate.id, 6, 4)}
          </span>
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

      <Opening />
    </Link>
  );
}

/**
 * The platform line at the foot of a plate, drawn only for a passport the one
 * credit rule gives a case: it names where the picture was drawn, never who
 * made it. Shared with the agent page's plates so the mark reads the same on
 * both.
 */
export function PlatformMark({ text }: { text: string }) {
  return (
    <span
      data-plate-platform
      className="mb-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-accent"
    >
      <span aria-hidden className="motif h-[6px] w-[6px] shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

/**
 * What a pressed plate shows while the passport it opens is on its way.
 *
 * The passport page is drawn on the server and took up to 1.6 s to swap in,
 * with nothing on the pressed plate until then, so a reader pressed again. The
 * plate steps back and carries the same pulsing kolam mark a chip carries
 * while its sheet is read. It sits inside the link because that is where the
 * router says whether this navigation is the one in flight, and the router
 * clears it when
 * the navigation ends or another one replaces it. Opacity and a pulse only:
 * the reduced-motion rule in globals.css cuts both to a still.
 */
function Opening() {
  const t = useTranslations("explore");
  const { pending } = useLinkStatus();

  return (
    <>
      <span
        aria-hidden
        data-plate-opening={pending ? "true" : undefined}
        className={`pointer-events-none absolute inset-0 z-[2] bg-bg transition-opacity duration-200 ${
          pending ? "opacity-45" : "opacity-0"
        }`}
      />
      {pending ? (
        <>
          <span
            aria-hidden
            className="motif pointer-events-none absolute inset-0 z-[2] m-auto h-4 w-4 animate-pulse"
          />
          <span className="sr-only">{t("reading")}</span>
        </>
      ) : null}
    </>
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
