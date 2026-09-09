import { setRequestLocale } from "next-intl/server";
import { LogoBench } from "@/components/lab/LogoBench";

/**
 * The logo bench. Three candidates for the Moolam mark, drawn as real SVG and
 * shown on both surfaces at the sizes that decide it. Labels here are English
 * on purpose: nothing links to this page and it never ships to a visitor.
 */
export default async function LogoLabPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <LogoBench />;
}
