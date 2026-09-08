import { getTranslations, setRequestLocale } from "next-intl/server";

/**
 * The hidden bench. Visual pieces are built and looked at here first, and only
 * roll into a real screen once Ram has seen them. Nothing links to this page.
 */
export default async function LabPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("lab");

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-24 sm:px-8">
      <h1 className="rise font-display text-[clamp(2.5rem,8vw,6rem)] uppercase leading-[0.9] tracking-[-0.02em]">
        {t("title")}
      </h1>
      <p className="rise mt-6 max-w-[52ch] text-sm text-text-muted" style={{ animationDelay: "80ms" }}>
        {t("note")}
      </p>
    </div>
  );
}
