import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { VerifyScreen } from "@/components/verify/VerifyScreen";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "verify" });
  return { title: t("title"), description: t("lede") };
}

/**
 * Anyone, signed in or not, can drop a copy of an image here and get the
 * passport it belongs to.
 *
 * The words are rendered here, on the server, and enter on a CSS animation. The
 * panel under them runs in the browser because the upload goes straight to the
 * verify service, and a heading that waits for that script to arrive is a blank
 * screen on a slow connection.
 */
export default async function VerifyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("verify");

  // Tamil letters carry marks above and below the line, so the tight leading the
  // display face wants in Latin makes two lines touch.
  const leading = locale === "ta" ? "leading-[1.12]" : "leading-[0.86]";

  return (
    <div className="relative mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <span
        aria-hidden
        className="pointer-events-none absolute right-5 top-20 hidden select-none font-mono text-[11px] uppercase tracking-[0.4em] text-text-faint lg:block"
        style={{ writingMode: "vertical-rl" }}
      >
        {t("rail")}
      </span>

      <header className="relative max-w-[54ch]">
        <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          {t("kicker")}
        </p>

        <h1
          className={`rise mt-6 max-w-[13ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase tracking-[-0.035em] ${leading}`}
          style={{ animationDelay: "60ms" }}
        >
          {t("title")}
        </h1>

        <p
          className="rise mt-7 max-w-[52ch] text-base leading-relaxed text-text-muted sm:text-lg"
          style={{ animationDelay: "120ms" }}
        >
          {t("lede")}
        </p>
      </header>

      <VerifyScreen />
    </div>
  );
}
