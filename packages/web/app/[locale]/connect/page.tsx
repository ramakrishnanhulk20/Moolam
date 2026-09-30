import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ConnectScreen } from "@/components/connect/ConnectScreen";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { askerAt } from "@/lib/data/platform-label";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "connect" });
  return { title: t("metaTitle"), description: t("metaDescription"), robots: { index: false, follow: false } };
}

/**
 * Where a platform asks for a person's Moolam address (P22). The asking site
 * names itself in ?origin=, which is canonicalised by the same function the
 * platform list's origins passed and looked up in that list here, so the page
 * names a listed platform or calls it an unlisted site, and shows the exact
 * origin either way. The address goes only to that origin, only on a press.
 */
export default async function ConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ origin?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { origin } = await searchParams;
  const asker = await askerAt(typeof origin === "string" ? origin.slice(0, 300) : "");

  return (
    <div className="relative mx-auto w-full max-w-[1400px] pb-[var(--bar-room)] md:pb-0">
      <WalletProvider>
        <ConnectScreen asker={asker} />
      </WalletProvider>
    </div>
  );
}
