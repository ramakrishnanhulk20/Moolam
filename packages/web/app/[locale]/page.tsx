import { Suspense } from "react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { reason, shortHex } from "@/lib/chain/client";
import { latestPassports } from "@/lib/data/passports";
import { Link } from "@/lib/i18n/routing";

// The strip below is read from the chain on every request. A prerendered copy
// would show whatever was true when the build ran, which is not what "live"
// means to anyone looking at it.
export const dynamic = "force-dynamic";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");

  return (
    <div>
      {/* SWAP: hero. This is the skeleton only. The real hero, its still and its
          signature moment arrive with the hero work order. */}
      <section className="grain relative overflow-hidden border-b border-line">
        <div className="scrim pointer-events-none absolute inset-0">
          <div className="absolute -left-40 top-[-30%] h-[70vw] w-[70vw] rounded-full bg-accent-soft blur-[120px]" />
        </div>

        <div className="relative mx-auto w-full max-w-[1400px] px-5 pb-24 pt-20 sm:px-8 sm:pb-32 sm:pt-28">
          <p className="rise font-mono text-[11px] uppercase tracking-[0.28em] text-accent">{t("kicker")}</p>
          <h1
            className="rise mt-6 max-w-[16ch] font-display text-[clamp(3rem,10vw,9rem)] uppercase leading-[0.9] tracking-[-0.02em]"
            style={{ animationDelay: "80ms" }}
          >
            {t("title")}
          </h1>
          <p
            className="rise mt-8 max-w-[58ch] text-base leading-relaxed text-text-muted sm:text-lg"
            style={{ animationDelay: "160ms" }}
          >
            {t("lede")}
          </p>
          <div className="rise mt-10 flex flex-wrap gap-3" style={{ animationDelay: "240ms" }}>
            <Link
              href="/verify"
              className="rounded-[8px] bg-accent px-6 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
            >
              {t("ctaVerify")}
            </Link>
            <Link
              href="/studio"
              className="rounded-[8px] border border-line px-6 py-3 text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("ctaStudio")}
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1400px] px-5 py-20 sm:px-8 sm:py-28">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="font-display text-[clamp(1.8rem,4vw,3rem)] uppercase leading-[0.95] tracking-[-0.01em]">
            {t("latest.heading")}
          </h2>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{t("latest.subheading")}</p>
        </div>

        <Suspense fallback={<p className="mt-10 text-sm text-text-muted">{t("latest.pending")}</p>}>
          <LatestStrip locale={locale} />
        </Suspense>
      </section>
    </div>
  );
}

async function LatestStrip({ locale }: { locale: string }) {
  const t = await getTranslations("home");
  const format = await getFormatter({ locale });

  let rows;
  try {
    rows = (await latestPassports(6)).passports;
  } catch (error) {
    return <p className="mt-10 max-w-[60ch] text-sm text-failed">{t("latest.error", { reason: reason(error) })}</p>;
  }

  if (rows.length === 0) {
    return <p className="mt-10 max-w-[60ch] text-sm text-text-muted">{t("latest.empty")}</p>;
  }

  return (
    <ul className="mt-10 border-t border-line">
      {rows.map((row, index) => (
        <li key={row.id} className="rise" style={{ animationDelay: `${index * 60}ms` }}>
          <Link
            href={`/passport/${row.id}`}
            className="group grid gap-x-8 gap-y-2 border-b border-line py-6 transition-colors duration-200 hover:bg-bg-raised sm:grid-cols-[1.4fr_1fr_0.6fr_0.8fr] sm:items-baseline"
          >
            <span className="font-mono text-sm text-text transition-colors duration-200 group-hover:text-accent sm:text-base">
              {shortHex(row.id, 10, 8)}
            </span>
            <span className="font-mono text-xs text-text-muted">
              <span className="mr-2 uppercase tracking-[0.18em] text-text-faint sm:hidden">
                {t("latest.columnCreator")}
              </span>
              {shortHex(row.creator, 8, 6)}
            </span>
            <span className="font-mono text-xs text-text-muted">
              {row.agentId === 0n ? t("latest.agentNone") : `#${row.agentId.toString()}`}
            </span>
            <span className="font-mono text-xs text-text-faint sm:text-right">
              {format.dateTime(new Date(Number(row.registeredAt) * 1000), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
