import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { GuideBench } from "@/components/lab/guide/GuideBench";

/**
 * The first-visit guide bench: two drawings of the same three things, over a
 * stand-in for the home page. Nothing links here and the flag that opens it is
 * only set on this machine, so the route is a 404 everywhere else.
 */
export default async function GuideLabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  return <GuideBench />;
}
