import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { StudioBench } from "@/components/lab/studio/StudioBench";

/**
 * The studio bench: two drawings of a press that answers itself. Nothing links
 * here and the flag that opens it is only set on this machine, so the route is
 * a 404 everywhere else.
 */
export default async function StudioLabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  return <StudioBench />;
}
