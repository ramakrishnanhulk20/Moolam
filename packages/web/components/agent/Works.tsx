import { getFormatter, getTranslations } from "next-intl/server";
import { IndexRetry } from "@/components/IndexRetry";
import { Picture } from "@/components/passport/Picture";
import { shortHex } from "@/lib/chain/client";
import { pictureSources } from "@/lib/images";
import { Link } from "@/lib/i18n/routing";
import type { SignedWork } from "./signed";

/**
 * Everything this agent signed, real pictures first. Each tile is the pinned picture
 * with its passport under it, so a reader can go from the agent straight to any
 * one record. An agent with nothing registered says so in a sentence.
 */
export async function Works({
  works,
  error,
  locale,
  retry = true,
}: {
  works: SignedWork[];
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
  const kinds = await getTranslations("kind");
  const common = await getTranslations("common");
  const format = await getFormatter({ locale });

  return (
    <section className="mx-auto w-full max-w-[1400px] px-5 pb-24 sm:px-8 sm:pb-32">
      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-line pt-10">
        <h2 className="font-display text-[clamp(1.6rem,3.2vw,2.6rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
          {t("heading")}
        </h2>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("source")}</p>
      </div>

      {error !== null ? (
        <div data-index-unread className="mt-10 max-w-[54ch]">
          <p className="text-sm leading-relaxed text-failed">{t("error", { reason: error })}</p>
          {retry ? <IndexRetry said={error} /> : null}
        </div>
      ) : works.length === 0 ? (
        <p className="mt-10 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("empty")}</p>
      ) : (
        <ul className="mt-10 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {/* min-w-0 on the tile or the truncated title sets the grid track: a
              nowrap line reports its full width as its minimum, so one long title
              pushes the whole column past the screen on a phone. */}
          {works.map((work) => (
            <li key={work.id} className="group min-w-0 bg-bg-raised">
              <Link href={`/passport/${work.id}`} className="block">
                <div className="grain relative aspect-[4/3] overflow-hidden bg-bg-sunken">
                  {work.thumbnailUrl === undefined ? (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {t("noThumbnail")}
                    </span>
                  ) : (
                    // The pinned thumbnail, the same file a verifier fetches
                    // when it re-checks this image, served through the
                    // optimizer so the gateway is read once per file.
                    <Picture
                      sources={pictureSources(work.thumbnailUrl)}
                      alt={work.title ?? common("registeredPicture")}
                      sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                      className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                      fallback={
                        <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                          {t("noThumbnail")}
                        </span>
                      }
                    />
                  )}
                  {/* No words sit on the tile, so the scrim is only depth. In
                      light it is cream and would wash the picture out, so light
                      shows the picture at full strength, as Explore does. */}
                  <div data-scrim="dark" className="scrim pointer-events-none absolute inset-0 [.light_&]:hidden" />
                </div>

                <div className="p-5">
                  <p className="truncate text-sm text-text transition-colors duration-200 group-hover:text-accent">
                    {work.title ?? t("untitled")}
                  </p>
                  <p className="mt-2 font-mono text-[11px] text-text-faint">
                    <span data-hex className="normal-case">
                      {shortHex(work.id, 10, 8)}
                    </span>
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-text-faint">
                    {kinds(String(work.kind))} <span className="mx-1">/</span>
                    {format.dateTime(new Date(Number(work.registeredAt) * 1000), "moment")}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
