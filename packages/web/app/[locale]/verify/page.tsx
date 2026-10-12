import type { Metadata } from "next";
import { connection } from "next/server";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ToolOpening } from "@/components/studio/ToolOpening";
import { VerifyScreen } from "@/components/verify/VerifyScreen";
import { offeredSamples } from "@/lib/data/offeredSamples";

// The offered pictures are read from the registry, and the page is rebuilt from
// that read a minute at a time rather than on every visit. It is the same
// cadence the index itself catches up on, and the same one the home page uses,
// so the two screens offer the same three pictures.
export const revalidate = 600;

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

  // Real records, read here on the server. A judge with no Moolam picture on
  // their laptop has something to press, and it runs the same check a dropped
  // file gets.
  const { samples, error } = await offeredSamples();

  if (samples.length === 0 && error !== null) {
    // A registry with nothing in it yet is a true page and worth keeping for the
    // minute. A row that is empty because the read failed is not, and keeping it
    // would offer every visitor for the next minute a verify page with nothing
    // to press. The connection takes this render out of the store.
    await connection();
  }

  // A short opening, so the drop box and the answer card both start inside the
  // first screen of a laptop.
  return (
    <div className="relative mx-auto w-full max-w-[1400px] px-5 pb-16 pt-7 sm:px-8 sm:pb-24 sm:pt-9">
      <ToolOpening kicker={t("kicker")} title={t("title")} line={t("lede")} locale={locale} />
      <VerifyScreen samples={samples} />
    </div>
  );
}
