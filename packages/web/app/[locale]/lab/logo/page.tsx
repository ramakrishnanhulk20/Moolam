import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { LogoBench } from "@/components/lab/LogoBench";

/**
 * The logo bench. Three candidates for the Moolam mark, drawn as real SVG and
 * shown on both surfaces at the sizes that decide it. Labels here are English
 * on purpose: nothing links to this page and it never ships to a visitor.
 */
export default async function LogoLabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    // The bench is a working surface, not a page anyone should land on. It
    // exists on this machine, where the flag is set in .env.local, and nowhere
    // else: the deployment never sets it, so the route is a 404 in production.
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  return <LogoBench />;
}
