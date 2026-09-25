import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { SUMMARY_TONES } from "@/components/consent/tones";
import { Picture } from "@/components/passport/Picture";
import { shortHex } from "@/lib/chain/client";
import { pictureSources } from "@/lib/images";
import { Link } from "@/lib/i18n/routing";
import type { ShowcasePassport } from "./showcasePassport";

/**
 * One real passport, set beside a sign-in card as the thing a creator gets.
 *
 * Every value is the registry's: the picture and its title from the pinned
 * document, the creator and the agent from the record, the statement from the
 * consent register, the re-check from the attestations Chainlink wrote. With no
 * read there is nothing to show, and the card stands alone.
 *
 * The labels are the passport page's and the home page's own words, so the
 * only new line is the caption, which the lab carries in English until roll-in.
 */
export async function Showcase({ passport, caption }: { passport: ShowcasePassport | null; caption: string }) {
  if (passport === null) {
    return null;
  }

  const t = await getTranslations("passport");
  const home = await getTranslations("home.first");
  const explore = await getTranslations("explore");
  const recheck = await getTranslations("recheck");
  const format = await getFormatter();
  const common = await getTranslations("common");
  const title = passport.title ?? common("registeredPicture");

  return (
    <aside data-showcase className="rise min-w-0" style={{ animationDelay: "160ms" }}>
      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
        <span aria-hidden className="h-px w-8 bg-accent" />
        {caption}
      </p>

      <Link
        href={`/passport/${passport.id}`}
        aria-label={home("openPassport", { title })}
        className="group mt-4 block border border-line bg-bg-raised transition-colors duration-300 hover:border-accent/60"
      >
        <span className="grain relative block aspect-[16/11] overflow-hidden">
          <Picture
            sources={pictureSources(passport.picture)}
            alt={title}
            sizes="(min-width: 1024px) 36rem, 100vw"
            priority
            className="object-cover transition-transform duration-[1100ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.04]"
          />
          <span className="scrim pointer-events-none absolute inset-0" />
          <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-4 sm:p-5">
            <span className="line-clamp-2 max-w-[24ch] font-display text-[clamp(1.15rem,1.8vw,1.5rem)] font-semibold leading-[1.1] tracking-[-0.02em] text-text transition-colors duration-300 group-hover:text-accent">
              {title}
            </span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
              {shortHex(passport.id, 6, 4)}
            </span>
          </span>
        </span>

        <dl className="grid grid-cols-2 gap-px bg-line text-sm">
          <Fact label={t("creator")}>
            <span className="font-mono text-[12px] text-text">{shortHex(passport.creator)}</span>
          </Fact>

          {passport.agentId === null ? null : (
            <Fact label={t("agent")}>
              <span className="text-text">
                {passport.agentName ?? t("agentNumber", { id: passport.agentId })}
                {passport.agentName === null ? null : (
                  <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint">
                    {t("agentNumber", { id: passport.agentId })}
                  </span>
                )}
              </span>
            </Fact>
          )}

          {passport.statement === null ? null : (
            <Fact label={explore("ai.label")}>
              <span className={`flex items-center gap-2 ${SUMMARY_TONES[passport.statement].ink}`}>
                <span aria-hidden className={`h-2 w-2 shrink-0 ${SUMMARY_TONES[passport.statement].fill}`} />
                {t(`consent.summary.${passport.statement}`)}
              </span>
            </Fact>
          )}

          <Fact label={home("billing.chainlink")}>
            {passport.recheck === null ? (
              <span className="text-text-faint">{home("recheckNone")}</span>
            ) : (
              <span className={passport.recheck.matched ? "text-verified" : "text-failed"}>
                {passport.recheck.matched
                  ? home("recheckBits", { count: passport.recheck.distance })
                  : home("recheckMissed", { bits: home("recheckBits", { count: passport.recheck.distance }) })}
                <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint">
                  {recheck("recheckedOn", {
                    date: format.dateTime(new Date(passport.recheck.at * 1000), { dateStyle: "medium" }),
                  })}
                </span>
              </span>
            )}
          </Fact>
        </dl>
      </Link>
    </aside>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-bg-raised px-4 py-3.5 sm:px-5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="mt-1.5 min-w-0 leading-snug">{children}</dd>
    </div>
  );
}
