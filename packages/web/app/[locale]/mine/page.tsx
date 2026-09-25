import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { MineScreen } from "@/components/mine/MineScreen";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { Showcase } from "@/components/studio/Showcase";
import { showcasePassport } from "@/components/studio/showcasePassport";
import { SignInSplit } from "@/components/studio/SignInSplit";
import { ToolOpening } from "@/components/studio/ToolOpening";

// The passport beside the sign-in card is read from the registry through the
// same one minute holds the passport page keeps, so the page is refreshed on
// that cadence rather than frozen at whatever the build read.
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "mine" });
  // One person's own pictures. There is nothing on it for a crawler, which is
  // also why it is left out of the sitemap and closed in robots.txt.
  return { title: t("title"), description: t("description"), robots: { index: false, follow: false } };
}

/**
 * Everything the signed in account registered, in one place.
 *
 * The list already existed at the foot of the studio, under the panel a
 * creator was working in, and it was reachable from nowhere else: the pictures
 * a person made took two minutes and a scroll to find. This page is that list
 * with an address of its own and an entry in the bar on every page.
 *
 * The words around the grid render on the server, so the page has its heading
 * before any script arrives. The grid itself needs the account, so it sits
 * under the wallet, asked for here the way the studio asks for it, on one of
 * the few routes that carry it at all. A visitor who is not signed in gets the
 * sign-in card beside one real passport, read from the registry here.
 */
export default async function MinePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("mine");

  const passport = await showcasePassport();

  return (
    <div className="relative mx-auto w-full max-w-[1400px] px-5 pb-16 pt-7 sm:px-8 sm:pb-24 sm:pt-9">
      <ToolOpening kicker={t("kicker")} title={t("heading")} line={t("lede")} locale={locale} />
      <SignInSplit showcase={<Showcase passport={passport} caption={t("showcaseCaption")} />}>
        <WalletProvider>
          <MineScreen />
        </WalletProvider>
      </SignInSplit>
    </div>
  );
}
