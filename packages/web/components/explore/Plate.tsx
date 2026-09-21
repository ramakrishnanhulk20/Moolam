"use client";

import { useFormatter, useTranslations } from "next-intl";
import { UseBlock } from "@/components/consent/Marks";
import { SUMMARY_TONES } from "@/components/consent/tones";
import { Picture } from "@/components/passport/Picture";
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
 * on it, never a broken image icon.
 *
 * `first` marks a plate in the row a reader can see before scrolling. Its
 * picture is named in the head of the page and fetched ahead of the rest, which
 * is what the browser needs to paint the sheet early; every other plate is left
 * to load as it comes into view.
 */
export function Plate({ plate, first = false }: { plate: ExplorePlate; first?: boolean }) {
  const t = useTranslations("explore");
  const kinds = useTranslations("kind");
  const format = useFormatter();
  const test = isTestCard(plate.title);

  const seal = (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="motif h-7 w-7 opacity-70 transition-opacity duration-500 group-hover:opacity-100" />
      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-text-faint">{t("noPicture")}</span>
    </span>
  );

  return (
    <Link
      href={`/passport/${plate.id}`}
      className="group relative block aspect-[4/5] min-w-0 overflow-hidden bg-bg-sunken outline-offset-[-2px]"
    >
      {plate.thumbnailUrl === null ? (
        seal
      ) : (
        // The pinned thumbnail, the same file a verifier fetches when it
        // re-checks this picture, served through the optimizer so a grid of
        // forty plates costs the gateway nothing after the first view.
        <Picture
          sources={pictureSources(plate.thumbnailUrl)}
          sizes="(min-width: 1280px) 22vw, (min-width: 640px) 33vw, 50vw"
          priority={first}
          className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.07]"
          fallback={seal}
        />
      )}

      <span className="grain pointer-events-none absolute inset-0" />
      <span className="scrim pointer-events-none absolute inset-0" />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 border border-transparent transition-colors duration-500 group-hover:border-accent/60"
      />

      <span className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <span className="flex min-w-0 flex-col items-start gap-2.5">
          <span className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-text-muted">
            <span className="motif h-[7px] w-[7px] opacity-60 transition-opacity duration-500 group-hover:opacity-100" />
            {kinds(String(plate.kind))}
          </span>
          {/* Truthiness rather than a null test: a sheet held from the minute
              before this shipped has plates with no such field at all. */}
          {plate.consent ? <Statement statement={plate.consent} /> : null}
        </span>
        <span className="flex items-center gap-1">
          <Mark on={plate.manifest} letter="M" label={t("marks.manifest")} tone="accent" />
          <Mark
            on={plate.rechecked}
            letter="R"
            label={plate.chainlink ? t("marks.chainlink") : t("marks.rechecked")}
            tone="verified"
          />
          <Mark on={plate.disputed} letter="D" label={t("marks.disputed")} tone="failed" />
        </span>
      </span>

      <span className="pointer-events-none absolute inset-x-0 bottom-0 p-3 pt-8 sm:p-4">
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
