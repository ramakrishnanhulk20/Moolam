import { setRequestLocale } from "next-intl/server";
import { Hero } from "@/components/hero/Hero";
import { LabControls } from "@/components/hero/LabControls";

// The still, the passport count and the record beside it are read from Monad on
// every request. A prerendered copy would show whatever was true when the build
// ran, which is not what live means to anyone looking at it.
export const dynamic = "force-dynamic";

/**
 * The hidden bench. Visual pieces are built and looked at here first, and only
 * roll into a real screen once Ram has seen them. Nothing links to this page.
 */
export default async function LabPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <LabControls>
      <Hero locale={locale} />
    </LabControls>
  );
}
