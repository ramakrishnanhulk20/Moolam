import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { StudioScreen } from "@/components/studio/StudioScreen";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "studio" });
  return { title: t("title"), description: t("lede") };
}

/**
 * Where a creator turns a picture into a passport: sign in, bind the unlock on
 * this device once, then prepare, sign and send. Everything on the screen is a
 * live read or a real transaction.
 *
 * The page itself runs on the server so the tab carries the page's own name.
 * The screen under it is the browser's, because every step of it needs a wallet,
 * and this is one of the three routes that asks for the wallet at all.
 */
export default async function StudioPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <WalletProvider>
      <StudioScreen />
    </WalletProvider>
  );
}
