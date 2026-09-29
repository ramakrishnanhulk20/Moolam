import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { ResolveConsole } from "@/components/resolve/ResolveConsole";
import { ToolOpening } from "@/components/studio/ToolOpening";
import { WarningMark } from "@/components/WarningMark";
import { reason } from "@/lib/chain/client";
import { resolver as readResolver } from "@/lib/chain/registry";
import { openDisputeQueue, type OpenDispute } from "@/lib/disputes/queue";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "resolve" });
  // One address settles disputes, so there is nothing here for a search engine to index.
  return { title: t("title"), description: t("lede"), robots: { index: false, follow: false } };
}

/**
 * Where the resolver works: every challenge the registry still has open, with
 * the picture, the claim and the bond behind it.
 *
 * Anyone can read it. The address the policy names is the only one that can act
 * on it, and that is the registry's rule, not this page's.
 *
 * The queue is read here on the server from both sources that know something:
 * the index, which is the only place a list of open disputes exists, and the
 * registry, which is the only place the truth of each one does.
 */
export default async function ResolvePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("resolve");

  let policyResolver: Hex;
  try {
    policyResolver = await readResolver();
  } catch (error) {
    return <Shell locale={locale}>{<Notice text={t("error", { reason: reason(error) })} />}</Shell>;
  }

  let queue: OpenDispute[] = [];
  let problem: string | null = null;
  try {
    queue = await openDisputeQueue();
  } catch (error) {
    problem = reason(error);
  }

  // The console is the only thing on this route that signs, so the wallet is
  // asked for here rather than in the layout every page shares. A queue that
  // could not be read goes in as its reason, so the desk says that in the
  // list's place instead of calling the list empty.
  return (
    <Shell locale={locale}>
      <WalletProvider>
        <ResolveConsole resolver={policyResolver} disputes={queue} listError={problem} />
      </WalletProvider>
    </Shell>
  );
}

/**
 * The words around the console, rendered on the server so the page has its
 * heading before any script arrives. The opening is short, so both of the
 * desk's cards start inside the first screen.
 */
async function Shell({ locale, children }: { locale: string; children: React.ReactNode }) {
  const t = await getTranslations("resolve");

  return (
    <div className="relative mx-auto w-full max-w-[1400px] px-5 pb-16 pt-7 sm:px-8 sm:pb-24 sm:pt-9">
      <ToolOpening kicker={t("kicker")} title={t("heading")} line={t("lede")} locale={locale} />
      {children}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p className="mt-8 flex max-w-[58ch] items-start gap-2.5 text-base leading-relaxed text-failed">
      <WarningMark className="mt-[5px]" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}
