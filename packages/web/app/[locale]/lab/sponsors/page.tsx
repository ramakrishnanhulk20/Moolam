import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { SponsorsBench } from "@/components/lab/sponsors/SponsorsBench";
import { sponsorBench } from "@/lib/lab/sponsors";

// Every figure on the bench is read on the request. A prerendered copy would
// show how far behind the index was when the build ran, which is not what live
// means to anyone looking at it.
export const dynamic = "force-dynamic";

/**
 * The sponsor bench. Four screens a judge sees, each drawn as it reads today
 * and as it would read if the sponsor's technology showed. Nothing links here
 * and the flag that opens it is only set on this machine, so the route is a 404
 * everywhere else.
 */
export default async function SponsorsLabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  return <SponsorsBench bench={await sponsorBench()} />;
}
