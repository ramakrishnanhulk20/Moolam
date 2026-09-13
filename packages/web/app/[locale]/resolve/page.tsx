import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { ResolveConsole } from "@/components/resolve/ResolveConsole";
import { reason } from "@/lib/chain/client";
import { resolver as readResolver } from "@/lib/chain/registry";
import { openDisputeQueue, type OpenDispute } from "@/lib/disputes/queue";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "resolve" });
  // One address settles disputes, so there is nothing here for a search engine to index.
  return { title: t("title"), description: t("lede"), robots: { index: false, follow: false } };
}

/**
 * Where the resolver works: every challenge the registry still has open, with
 * the picture, the claim and the bond behind it.
 *
 * Anyone can read it. The address the policy names is the only one that can act
 * on it, and that is the registry's rule, not this page's.
 *
 * The queue is read here on the server from both sources that know something:
 * the index, which is the only place a list of open disputes exists, and the
 * registry, which is the only place the truth of each one does.
 */
export default async function ResolvePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("resolve");

  let policyResolver: Hex;
  try {
    policyResolver = await readResolver();
  } catch (error) {
    return <Shell locale={locale}>{<Notice text={t("error", { reason: reason(error) })} />}</Shell>;
  }

  let queue: OpenDispute[] = [];
  let problem: string | null = null;
  try {
    queue = await openDisputeQueue();
  } catch (error) {
    problem = reason(error);
  }

  return (
    <Shell locale={locale}>
      {problem === null ? (
        <ResolveConsole resolver={policyResolver} disputes={queue} />
      ) : (
        <>
          <Notice text={t("unavailable", { reason: problem })} />
          <ResolveConsole resolver={policyResolver} disputes={[]} />
        </>
      )}
    </Shell>
  );
}

/**
 * The words around the console, rendered on the server so the page has its
 * heading before any script arrives.
 */
async function Shell({ locale, children }: { locale: string; children: React.ReactNode }) {
  const t = await getTranslations("resolve");

  // Tamil letters carry marks above and below the line, so the tight leading the
  // display face wants in Latin makes two lines touch.
  const leading = locale === "ta" ? "leading-[1.12]" : "leading-[0.88]";

  return (
    <div className="relative mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <span
        aria-hidden
        className="pointer-events-none absolute right-5 top-20 hidden select-none font-mono text-[11px] uppercase tracking-[0.4em] text-text-faint lg:block"
        style={{ writingMode: "vertical-rl" }}
      >
        {t("rail")}
      </span>

      <header className="relative max-w-[56ch]">
        <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          {t("kicker")}
        </p>

        <h1
          className={`rise mt-6 max-w-[12ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase tracking-[-0.035em] ${leading}`}
          style={{ animationDelay: "60ms" }}
        >
          {t("heading")}
        </h1>

        <p
          className="rise mt-7 max-w-[54ch] text-base leading-relaxed text-text-muted sm:text-lg"
          style={{ animationDelay: "120ms" }}
        >
          {t("lede")}
        </p>
      </header>

      {children}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return <p className="rise mt-12 max-w-[58ch] border-s-2 border-failed bg-failed/5 py-3 ps-4 text-sm leading-relaxed text-failed">{text}</p>;
}
