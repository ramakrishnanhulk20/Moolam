import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { StudioScreen } from "@/components/studio/StudioScreen";
import { initialRegisterState, type Mode } from "@/lib/studio/flow";

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
export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const asked = searchParams === undefined ? undefined : (await searchParams).mode;

  return (
    <WalletProvider>
      <StudioScreen initialMode={modeFrom(asked)} />
    </WalletProvider>
  );
}

/**
 * Which panel the studio opens on, taken from the link that brought the
 * visitor here.
 *
 * The URL says "register" where the state calls the same panel "upload": the
 * word in a link is the one a reader would write, and the state's word is
 * older than the generate path. Anything else at all, including a second copy
 * of the parameter, opens the studio where it has always opened.
 */
function modeFrom(asked: string | string[] | undefined): Mode {
  if (asked === "generate") {
    return "generate";
  }
  if (asked === "register") {
    return "upload";
  }
  return initialRegisterState.mode;
}
