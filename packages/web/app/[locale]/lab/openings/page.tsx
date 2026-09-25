import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import type { Hex } from "viem";
import { AgentsSheet } from "@/components/agents/Sheet";
import { ExploreSheet } from "@/components/explore/Sheet";
import { DEFAULT_SEARCH } from "@/components/explore/query";
import { MineScreen } from "@/components/mine/MineScreen";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { ResolveConsole } from "@/components/resolve/ResolveConsole";
import { OpeningProvider } from "@/components/studio/opening";
import { OPENING_WORDS } from "@/components/studio/openingWords";
import { Showcase } from "@/components/studio/Showcase";
import { showcasePassport } from "@/components/studio/showcasePassport";
import { StudioIntro } from "@/components/studio/StudioIntro";
import { StudioScreen } from "@/components/studio/StudioScreen";
import { ToolOpening } from "@/components/studio/ToolOpening";
import { VerifyScreen } from "@/components/verify/VerifyScreen";
import { reason } from "@/lib/chain/client";
import { resolver as readResolver } from "@/lib/chain/registry";
import { offeredSamples } from "@/lib/data/offeredSamples";
import { openDisputeQueue, type OpenDispute } from "@/lib/disputes/queue";
import { Link } from "@/lib/i18n/routing";

// Every drawing reads the chain and the index on the request, through the same
// one minute holds the real routes use, so the bench shows today's numbers.
export const dynamic = "force-dynamic";

/** The six tool pages the compact opening is drawn for, and the real route each one sits beside. */
const OPENING_PAGES = {
  verify: "/verify",
  studio: "/studio",
  mine: "/mine",
  agents: "/agents",
  resolve: "/resolve",
  explore: "/explore",
} as const;

type OpeningPage = keyof typeof OPENING_PAGES;

/** Which drawing the address asks for. Anything else opens Verify. */
function openingAsked(value: string | string[] | undefined): OpeningPage {
  return typeof value === "string" && value in OPENING_PAGES ? (value as OpeningPage) : "verify";
}

/**
 * The compact openings for the tool pages, for Ram to compare with today's.
 * ?p=verify|studio|mine|agents|resolve|explore opens one, ?full=1 drops the
 * bench strip. The real routes are unchanged until he says yes. Nothing links
 * here and the flag that opens it is only set on this machine, so the route is
 * a 404 everywhere else.
 */
export default async function OpeningsLabPage({
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
  const page = openingAsked(asked.p);

  return (
    <>
      <Drawing page={page} locale={locale} />
      {asked.full === "1" ? null : <Bench page={page} />}
    </>
  );
}

async function Drawing({ page, locale }: { page: OpeningPage; locale: string }) {
  if (page === "agents") {
    return <AgentsSheet locale={locale} opening="compact" />;
  }
  if (page === "explore") {
    return <ExploreSheet locale={locale} search={DEFAULT_SEARCH} stored={false} opening="compact" />;
  }
  if (page === "studio") {
    return <StudioDrawing locale={locale} />;
  }
  if (page === "mine") {
    return <MineDrawing locale={locale} />;
  }
  if (page === "resolve") {
    return <ResolveDrawing locale={locale} />;
  }
  return <VerifyDrawing locale={locale} />;
}

/** The frame every drawn page sits in: today's width, a short top so the tool is in the first screen. */
function Frame({ children }: { children: ReactNode }) {
  return <div className="relative mx-auto w-full max-w-[1400px] px-5 pb-16 pt-7 sm:px-8 sm:pb-24 sm:pt-9">{children}</div>;
}

async function VerifyDrawing({ locale }: { locale: string }) {
  const t = await getTranslations("verify");
  const { samples } = await offeredSamples();

  return (
    <Frame>
      <ToolOpening kicker={t("kicker")} title={t("title")} line={t("lede")} locale={locale} />
      <VerifyScreen samples={samples} opening="compact" />
    </Frame>
  );
}

/**
 * The sign-in card on the left and a real passport on the right, as the thing
 * signing in gets you. The wallet is asked for around the card only, the way
 * the studio route asks for it.
 */
async function StudioDrawing({ locale }: { locale: string }) {
  const passport = await showcasePassport();

  return (
    <Frame>
      <StudioIntro locale={locale} opening="compact" />
      <SignInSplit showcase={<Showcase passport={passport} caption={OPENING_WORDS.studioCaption} />}>
        <OpeningProvider opening="compact">
          <WalletProvider>
            <StudioScreen />
          </WalletProvider>
        </OpeningProvider>
      </SignInSplit>
    </Frame>
  );
}

async function MineDrawing({ locale }: { locale: string }) {
  const t = await getTranslations("mine");
  const passport = await showcasePassport();

  return (
    <Frame>
      <ToolOpening kicker={t("kicker")} title={t("heading")} line={t("lede")} locale={locale} />
      <SignInSplit showcase={<Showcase passport={passport} caption={OPENING_WORDS.mineCaption} />}>
        <WalletProvider>
          <MineScreen opening="compact" />
        </WalletProvider>
      </SignInSplit>
    </Frame>
  );
}

/** The card's column is the studio box's own width; the passport takes what is left. */
function SignInSplit({ children, showcase }: { children: ReactNode; showcase: ReactNode }) {
  return (
    <div className="mt-7 grid items-start gap-10 sm:mt-8 lg:grid-cols-[minmax(0,44rem)_minmax(0,1fr)] xl:gap-14">
      <div className="min-w-0">{children}</div>
      {showcase}
    </div>
  );
}

async function ResolveDrawing({ locale }: { locale: string }) {
  const t = await getTranslations("resolve");
  const opening = <ToolOpening kicker={t("kicker")} title={t("heading")} line={t("lede")} locale={locale} />;

  let policyResolver: Hex;
  try {
    policyResolver = await readResolver();
  } catch (error) {
    return (
      <Frame>
        {opening}
        <p className="mt-8 max-w-[58ch] text-sm leading-relaxed text-failed">{t("error", { reason: reason(error) })}</p>
      </Frame>
    );
  }

  let queue: OpenDispute[] = [];
  let problem: string | null = null;
  try {
    queue = await openDisputeQueue();
  } catch (error) {
    problem = reason(error);
  }

  return (
    <Frame>
      {opening}
      {problem === null ? null : (
        <p className="mt-8 max-w-[58ch] text-sm leading-relaxed text-failed">{t("unavailable", { reason: problem })}</p>
      )}
      <WalletProvider>
        <ResolveConsole resolver={policyResolver} disputes={queue} opening="compact" />
      </WalletProvider>
    </Frame>
  );
}

/**
 * The strip along the foot of the bench: the six drawings and today's page for
 * the one on screen. Laptop only, so it never sits over the phone's tab bar.
 */
function Bench({ page }: { page: OpeningPage }) {
  return (
    <nav
      aria-label="Openings bench"
      className="fixed bottom-4 left-4 z-50 hidden items-center gap-1 rounded-[8px] border border-line-strong bg-bg/90 p-1.5 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur lg:flex"
    >
      {(Object.keys(OPENING_PAGES) as OpeningPage[]).map((name) => (
        <Link
          key={name}
          href={`/lab/openings?p=${name}`}
          className={`rounded-[6px] px-2.5 py-1.5 transition-colors duration-200 ${
            name === page ? "bg-accent-soft text-accent" : "text-text-muted hover:text-text"
          }`}
        >
          {name}
        </Link>
      ))}
      <span aria-hidden className="mx-1 h-4 w-px bg-line-strong" />
      <Link
        href={OPENING_PAGES[page]}
        className="rounded-[6px] px-2.5 py-1.5 text-text-faint transition-colors duration-200 hover:text-accent"
      >
        today
      </Link>
    </nav>
  );
}
