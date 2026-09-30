import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CosignScreen } from "@/components/cosign/CosignScreen";
import { WalletProvider } from "@/components/providers/WalletProvider";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "cosign" });
  // A page for one person holding one link. There is nothing on it for a
  // crawler, so it is closed in robots.txt and left out of the sitemap too.
  return { title: t("metaTitle"), description: t("metaDescription"), robots: { index: false, follow: false } };
}

/**
 * Where a person sent by an AI image site signs as the creator of a picture
 * made for them. The link is /cosign#<handle>: the handle rides in the
 * fragment, which never reaches this server, so the page is the same for
 * everyone and the browser alone reads which record it is for (P4).
 */
export default async function CosignPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="relative mx-auto w-full max-w-[1400px] pb-[var(--bar-room)] md:pb-0">
      <WalletProvider>
        <CosignScreen />
      </WalletProvider>
    </div>
  );
}
