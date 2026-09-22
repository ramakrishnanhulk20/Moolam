import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { MineScreen } from "@/components/mine/MineScreen";
import { WalletProvider } from "@/components/providers/WalletProvider";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "mine" });
  // One person's own pictures. There is nothing on it for a crawler, which is
  // also why it is left out of the sitemap and closed in robots.txt.
  return { title: t("title"), description: t("description"), robots: { index: false, follow: false } };
}

/**
 * Everything the signed in account registered, in one place.
 *
 * The list already existed at the foot of the studio, under the panel a
 * creator was working in, and it was reachable from nowhere else: the pictures
 * a person made took two minutes and a scroll to find. This page is that list
 * with an address of its own and an entry in the bar on every page.
 *
 * The words around the grid render on the server, so the page has its heading
 * before any script arrives. The grid itself needs the account, so it sits
 * under the wallet, asked for here the way the studio asks for it, on one of
 * the few routes that carry it at all.
 */
export default async function MinePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("mine");

  // Tamil letters carry marks above and below the line, so the tight leading
  // the display face wants in Latin makes two lines touch.
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
          className={`rise mt-6 max-w-[11ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase tracking-[-0.035em] ${leading}`}
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

      <WalletProvider>
        <MineScreen />
      </WalletProvider>
    </div>
  );
}
