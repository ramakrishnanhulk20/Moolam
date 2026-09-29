import { getFormatter, getTranslations } from "next-intl/server";
import type { CSSProperties, ReactNode } from "react";
import { SealedPlate } from "@/components/sealed/SealedPlate";
import { shortHex } from "@/lib/chain/client";
import type { Passport } from "@/lib/chain/registry";
import { pictureSources } from "@/lib/images";
import type { Art } from "./art";
import { DownloadOriginal } from "./DownloadOriginal";
import { Picture } from "./Picture";
import { sealedBits } from "./sealed";
import { ShareLink } from "./ShareLink";
import { recordUnread } from "./unread";

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
 * `strip` is the facts strip along the poster's foot. The page always hands it
 * over; a test that leaves it out gets the same poster with nothing there.
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
          share={{ copy: t("share.copy"), copied: t("share.copied"), copyFailed: common("copyFailed") }}
        />
        {/* The plate is drawn by a component three screens share, so the strip
            hangs off its foot rather than inside it, on the ground the
            plate's scrim ends on, so the two read as one. */}
        <div
          data-strip-under-plate
          // The band rises into the plate's own bottom padding, which holds
          // nothing, so the strip starts closer to the first screen.
          className="relative -mt-6 border-b border-line bg-bg px-5 pb-6 sm:-mt-8 sm:px-8 sm:pb-8"
        >
          <div className="mx-auto w-full max-w-[1400px]">{strip}</div>
        </div>
      </header>
    );
  }

  // A picture that is missing, or that every gateway refused, leaves this mark
  // where it would have been. The seal further down only shows beside it.
  const missing = <span data-no-picture hidden />;
  const unread = recordUnread(art);

  return (
    <header className="group/poster grain relative h-[74svh] min-h-[34rem] w-full overflow-hidden border-b border-line bg-bg-sunken sm:h-[min(78vh,46rem)]">
      {art.imageUrl === undefined ? (
        missing
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
          fallback={missing}
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
        className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-[64%] [.light_&]:block"
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
            {/* Hex reads as hex: an upper case X in 0x is not an address. */}
            <span data-poster-id className="normal-case">
              {shortHex(passport.id, 10, 8)}
            </span>
          </p>
        </div>
      </div>

      {/* The seal takes only the room between the label and the title block.
          The box wraps its one child into a second column, off the side and
          clipped, whenever that room is too short to hold it, so a long title
          hides the seal rather than lying over it. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col px-5 pb-8 sm:px-8 sm:pb-12">
        <div
          data-missing-seal
          className="hidden min-h-0 flex-1 flex-col flex-wrap justify-center overflow-hidden pt-16 group-has-[[data-no-picture]]/poster:flex"
        >
          <span aria-hidden className="block h-0 w-full" />
          <div className="flex w-full flex-col items-center justify-center gap-5 py-4">
            <span className="motif h-8 w-8 shrink-0" />
            <p className="max-w-[34ch] text-center font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
              {t("noPicture")}
            </p>
          </div>
        </div>
        <div className="pointer-events-auto mx-auto mt-auto w-full max-w-[1400px]">
          {unread ? (
            // The record never arrived, so there is no name to print and
            // "Untitled" would say the creator gave none. The id is the one
            // name this passport certainly has.
            <>
              <h1
                data-title-unread
                className="rise max-w-[16ch] break-all font-display text-[clamp(2.2rem,7vw,5.5rem)] font-semibold leading-[0.9] tracking-[-0.04em]"
                style={{ animationDelay: "60ms" }}
              >
                {shortHex(passport.id, 6, 4)}
              </h1>
              <p
                className="rise mt-3 font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted"
                style={{ animationDelay: "90ms" }}
              >
                {t("titleUnread")}
              </p>
            </>
          ) : (
            <h1
              className="rise max-w-[16ch] font-display text-[clamp(2.2rem,7vw,5.5rem)] font-semibold uppercase leading-[0.9] tracking-[-0.04em]"
              style={{ animationDelay: "60ms" }}
            >
              {art.title ?? t("untitled")}
            </h1>
          )}
          <MetaLine className="rise mt-5" style={{ animationDelay: "120ms" }}>
            <span>{kinds(String(passport.kind))}</span>
            <span>
              {t("registered")}{" "}
              {format.dateTime(new Date(Number(passport.registeredAt) * 1000), "moment")}
            </span>
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
            <ShareLink
              words={{ copy: t("share.copy"), copied: t("share.copied"), copyFailed: common("copyFailed") }}
            />
            {/* The exact signed file, straight from IPFS through this app's own
                route, so the saved copy hashes to this passport's id. Only
                where a picture is known to be public: this branch is never a
                sealed passport, and a document the gateway would not hand over
                says nothing either way. And only where the route can serve
                it, which art.ts works out for a published document by the
                route's own rule; an unsealed picture is served from the record
                that published it. */}
            {art.imageUrl === undefined || (art.original !== true && art.unsealed === undefined) ? null : (
              <DownloadOriginal
                href={`/api/passports/${passport.id}/picture`}
                fallbackName={`moolam-${passport.id.slice(2, 10)}`}
                words={{ download: t("download"), downloading: t("downloading"), downloadFailed: t("downloadFailed") }}
              />
            )}
          </MetaLine>
          <div className="mt-6 sm:mt-8">{strip}</div>
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
 *
 * The clipping box reaches 20 px above and below the row and 4 px to each side,
 * with margins that give the room back, so a link's tap pad and its focus ring
 * are drawn whole. The rules sit 17 px out, so they stay clipped.
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
    <div className={className} style={style}>
      <div data-meta-line className="-mx-1 -my-5 overflow-hidden px-1 py-5">
        <p className="-ms-[33px] flex flex-wrap items-center gap-y-1 font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted [&>span]:relative [&>span]:ps-[33px] [&>span]:before:absolute [&>span]:before:start-4 [&>span]:before:top-1/2 [&>span]:before:h-[10px] [&>span]:before:w-px [&>span]:before:-translate-y-1/2 [&>span]:before:bg-line-strong [&>span]:before:content-['']">
          {children}
        </p>
      </div>
    </div>
  );
}
