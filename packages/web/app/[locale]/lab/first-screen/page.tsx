import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { Bench } from "@/components/lab/first-screen/Bench";
import { drawingAsked } from "@/components/lab/first-screen/finding";
import { firstScreenData } from "@/components/lab/first-screen/read";

// The finding is read on the request, through the same one minute holds the
// passport and verify pages use, so the bench always shows today's numbers.
export const dynamic = "force-dynamic";

/**
 * The first screen bench: two drawings of a product-first home screen, the
 * poster and the evidence board, for Ram to pick between. ?d=a or ?d=b opens
 * one, ?full=1 drops the bench strip. Nothing links here and the flag that
 * opens it is only set on this machine, so the route is a 404 everywhere else.
 */
export default async function FirstScreenLabPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const asked = searchParams === undefined ? {} : await searchParams;
  const data = await firstScreenData();

  return <Bench data={data} drawing={drawingAsked(asked.d)} full={asked.full === "1"} />;
}
