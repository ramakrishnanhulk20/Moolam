import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BusinessPage } from "@/components/business/BusinessPage";
import { businessData } from "@/components/business/data";
import { routing } from "@/lib/i18n/routing";

// The same minute as the home page: every figure here is read through a hold of
// that length, so a page rebuilt more often could show nothing newer, and one
// rebuilt less often would show a count older than the index could give.
export const revalidate = 600;

/**
 * The ten pages are drawn when the site is built and a minute at a time after
 * that, so a company opening the link is handed a finished page rather than
 * waiting on the index, the chain and a highlighter.
 */
export function generateStaticParams(): { locale: string }[] {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "business.meta" });
  // The card is app/opengraph-image.tsx, which Next attaches to every route
  // along with these two lines. An openGraph block here would replace it.
  return { title: t("title"), description: t("description") };
}

/**
 * The page for companies that make AI pictures: why their users want Moolam
 * passports, every step a person takes, the three calls to build it, what it
 * costs, and the proof that it is live and was attacked first.
 */
export default async function BusinessRoute({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <BusinessPage data={await businessData()} />;
}
