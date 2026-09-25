import { getFormatter, getTranslations } from "next-intl/server";
import type { CSSProperties, ReactNode } from "react";
import { SealedPlate } from "@/components/sealed/SealedPlate";
import { shortHex } from "@/lib/chain/client";
import type { Passport } from "@/lib/chain/registry";
import { pictureSources } from "@/lib/images";
import type { Art } from "./art";
import { Picture } from "./Picture";
import { sealedBits } from "./sealed";

/**
 * The passport as a poster: the registered picture full-bleed, the scrim over
 * it, and the title and the seal sitting on the still. A gateway that will not
 * hand the picture over gets the seal on a dark plate and a sentence, never a
 * broken image icon.
 *
 * A sealed passport opens on the sealed plate instead, at the same height and
 * in the same type. It is not the same state as a gateway that would not
 * answer, and it must never be drawn with those words: there is no picture to
 * fetch, because the creator chose not to publish one.
 *
 * The date carries its own word. Under the kind alone, "Captured" sat where a
 * label belongs and read as the label for the date, which said the wrong thing
 * about a generated image.
 *
 * `strip` is the facts strip the lab page tries along the poster's foot. The
 * real route leaves it out and draws exactly what it drew before.
 */
export async function Poster({
  passport,
  art,
  locale,
  strip,
}: {
  passport: Passport;
  art: Art;
  locale: string;
  strip?: ReactNode;
}) {
  const t = await getTranslations("passport");
  const kinds = await getTranslations("kind");
  const common = await getTranslations("common");
  const format = await getFormatter({ locale });

  if (art.sealed === true) {
    const registered = format.dateTime(new Date(Number(passport.registeredAt) * 1000), { dateStyle: "medium" });

    return (
      // The plate is the whole header here, so it keeps the element the rest of
      // the page's landmarks are laid out against.
      <header>
        <SealedPlate
          // The chain's own word first. The pinned document says the same
          // thing, and it is the fallback for the day the two ever disagree.
          bits={sealedBits(passport.blockhash256, art.blockhash)}
          title={art.title ?? null}
          size="poster"
          as="h1"
          shortId={shortHex(passport.id, 10, 8)}
          words={{
            sealed: t("sealed.label"),
            // "Keeps no copy" would be untrue once the creator asked for the
            // private re-check, so that passport gets its own line.
            line: t(art.privateRecheck === true ? "sealed.posterLinePrivate" : "sealed.posterLine", { date: registered }),
            untitled: t("untitled"),
          }}
        />
        {/* The plate is drawn by a component three screens share, so the strip
            hangs off its foot rather than inside it, on the ground the
            plate's scrim ends on, so the two read as one. */}
        {strip === undefined ? null : (
          <div
            data-strip-under-plate
            // The band rises into the plate's own bottom padding, which
            // holds nothing, so the strip starts closer to the first screen.
            className="relative -mt-6 border-b border-line bg-bg px-5 pb-6 sm:-mt-8 sm:px-8 sm:pb-8"
          >
            <div className="mx-auto w-full max-w-[1400px]">{strip}</div>
          </div>
        )}
      </header>
    );
  }

  const seal = (
    // With the strip the title rides higher, so the seal keeps to the top
    // part rather than sitting under the words.
    <div
      className={`absolute inset-x-0 top-0 flex flex-col items-center justify-center gap-5 ${
        strip === undefined ? "bottom-0" : "h-[40%]"
      }`}
    >
      <span className="motif h-8 w-8" />
      <p className="max-w-[34ch] px-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
        {t("noPicture")}
      </p>
    </div>
  );

  return (
    <header
      className={`grain relative w-full overflow-hidden border-b border-line bg-bg-sunken sm:h-[min(78vh,46rem)] ${
        // The strip makes a phone's poster a hand's width deeper, so the
        // picture keeps its share and the strip still ends above the tab bar.
        strip === undefined ? "h-[62vh] min-h-[26rem]" : "h-[74svh] min-h-[34rem]"
      }`}
    >
      {art.imageUrl === undefined ? (
        seal
      ) : (
        // The full pinned image, the same file a verifier fetches when it
        // re-checks this record. This is the one screen that draws it at full
        // size; every grid and every plate elsewhere uses the thumbnail.
        <Picture
          sources={pictureSources(art.imageUrl)}
          alt={art.title ?? common("registeredPicture")}
          sizes="100vw"
          priority
          className="object-cover"
          fallback={seal}
        />
      )}
      {/* Dark keeps the full poster gradient and the band along the top. In
          light both are cream, and over the whole still they read as a pale
          haze, so light keeps only the foot the title stands on and the
          picture shows at full strength above it. */}
      <div data-scrim="dark" className="scrim pointer-events-none absolute inset-0 [.light_&]:hidden" />
      <div
        aria-hidden
        data-scrim="dark"
        className="pointer-events-none absolute inset-x-0 top-0 h-32 [.light_&]:hidden"
        style={{ background: "linear-gradient(to bottom, var(--scrim-from) 0%, var(--scrim-to) 100%)" }}
      />
      <div
        aria-hidden
        data-scrim="light"
        className={`pointer-events-none absolute inset-x-0 bottom-0 hidden [.light_&]:block ${
          strip === undefined ? "h-[46%]" : "h-[64%]"
        }`}
        style={{
          background: "linear-gradient(to top, var(--scrim-from) 0%, rgb(242 239 233 / 0.8) 45%, var(--scrim-to) 100%)",
        }}
      />

      <div className="absolute inset-x-0 top-0 px-5 py-6 sm:px-8">
        {/* With no band along the top in light, the label sits on a small plate
            of the page's own ground so it reads on any sky. */}
        <div className="inline-flex flex-wrap items-center gap-x-5 gap-y-2 [.light_&]:rounded-[8px] [.light_&]:bg-bg/85 [.light_&]:px-3 [.light_&]:py-1.5 [.light_&]:backdrop-blur-sm">
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
            <span className="motif h-[10px] w-[10px]" />
            {t("title")}
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
            {shortHex(passport.id, 10, 8)}
          </p>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 px-5 pb-8 sm:px-8 sm:pb-12">
        <div className="mx-auto w-full max-w-[1400px]">
          <h1
            className="rise max-w-[16ch] font-display text-[clamp(2.2rem,7vw,5.5rem)] font-semibold uppercase leading-[0.9] tracking-[-0.04em]"
            style={{ animationDelay: "60ms" }}
          >
            {art.title ?? t("untitled")}
          </h1>
          <MetaLine className="rise mt-5" style={{ animationDelay: "120ms" }}>
            <span>{kinds(String(passport.kind))}</span>
            <span>
              {t("registered")}{" "}
              {format.dateTime(new Date(Number(passport.registeredAt) * 1000), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
            <span>{t("fingerprintVersion", { version: passport.fingerprintVersion })}</span>
            {/* Where the sealed line stood. This passport was registered with
                no picture behind it and its holder published one later, which
                is worth one quiet clause on the poster and a full sentence in
                the record below. */}
            {art.unsealed === undefined ? null : (
              <span className="text-accent">
                {t("unsealed.poster", {
                  date: format.dateTime(new Date(art.unsealed.at), { dateStyle: "medium" }),
                })}
              </span>
            )}
          </MetaLine>
          {strip === undefined ? null : <div className="mt-6 sm:mt-8">{strip}</div>}
        </div>
      </div>
    </header>
  );
}

/**
 * The poster's credit line, with a thin rule between its parts that never
 * starts or ends a row.
 *
 * Each part carries its rule in front of it, inside its own padding, and the
 * row is pulled back by exactly that padding inside a box that clips. The part
 * that opens a row therefore has its rule outside the box wherever the line
 * wraps, and no part has a rule after it at all.
 */
export function MetaLine({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div data-meta-line className={`overflow-hidden ${className}`} style={style}>
      <p className="-ms-[33px] flex flex-wrap items-center gap-y-1 font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted [&>span]:relative [&>span]:ps-[33px] [&>span]:before:absolute [&>span]:before:start-4 [&>span]:before:top-1/2 [&>span]:before:h-[10px] [&>span]:before:w-px [&>span]:before:-translate-y-1/2 [&>span]:before:bg-line-strong [&>span]:before:content-['']">
        {children}
      </p>
    </div>
  );
}
