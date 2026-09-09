import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { VerifyScreen } from "@/components/verify/VerifyScreen";

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
 * passport it belongs to. The screen itself runs in the browser because the
 * upload goes straight to the verify service.
 */
export default async function VerifyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <VerifyScreen />;
}
