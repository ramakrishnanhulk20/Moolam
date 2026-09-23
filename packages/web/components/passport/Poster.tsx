import { getFormatter, getTranslations } from "next-intl/server";
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
 */
export async function Poster({
  passport,
  art,
  locale,
}: {
  passport: Passport;
  art: Art;
  locale: string;
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
      </header>
    );
  }

  const seal = (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
      <span className="motif h-8 w-8" />
      <p className="max-w-[34ch] px-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
        {t("noPicture")}
      </p>
    </div>
  );

  return (
    <header className="grain relative h-[62vh] min-h-[26rem] w-full overflow-hidden border-b border-line bg-bg-sunken sm:h-[min(78vh,46rem)]">
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
      <div className="scrim pointer-events-none absolute inset-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32"
        style={{ background: "linear-gradient(to bottom, var(--scrim-from) 0%, var(--scrim-to) 100%)" }}
      />

      <div className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-6 sm:px-8">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          {t("title")}
        </p>
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
          {shortHex(passport.id, 10, 8)}
        </p>
      </div>

      <div className="absolute inset-x-0 bottom-0 px-5 pb-8 sm:px-8 sm:pb-12">
        <div className="mx-auto w-full max-w-[1400px]">
          <h1
            className="rise max-w-[16ch] font-display text-[clamp(2.2rem,7vw,5.5rem)] font-semibold uppercase leading-[0.9] tracking-[-0.04em]"
            style={{ animationDelay: "60ms" }}
          >
            {art.title ?? t("untitled")}
          </h1>
          <p
            className="rise mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted"
            style={{ animationDelay: "120ms" }}
          >
            <span>{kinds(String(passport.kind))}</span>
            <span aria-hidden className="h-[10px] w-px bg-line-strong" />
            <span>
              {t("registered")}{" "}
              {format.dateTime(new Date(Number(passport.registeredAt) * 1000), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
            <span aria-hidden className="h-[10px] w-px bg-line-strong" />
            <span>{t("fingerprintVersion", { version: passport.fingerprintVersion })}</span>
            {/* Where the sealed line stood. This passport was registered with
                no picture behind it and its holder published one later, which
                is worth one quiet clause on the poster and a full sentence in
                the record below. */}
            {art.unsealed === undefined ? null : (
              <>
                <span aria-hidden className="h-[10px] w-px bg-line-strong" />
                <span className="text-accent">
                  {t("unsealed.poster", {
                    date: format.dateTime(new Date(art.unsealed.at), { dateStyle: "medium" }),
                  })}
                </span>
              </>
            )}
          </p>
        </div>
      </div>
    </header>
  );
}
