import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { OpeningProvider } from "@/components/studio/opening";
import { StudioIntro } from "@/components/studio/StudioIntro";
import { StudioScreen } from "@/components/studio/StudioScreen";
import { WideFixture, type WideFixtureName } from "@/components/studio/WideFixture";
import { initialRegisterState, type Mode } from "@/lib/studio/flow";
import { Link } from "@/lib/i18n/routing";

// The live studio reads the account on the request, the way /studio does.
export const dynamic = "force-dynamic";

const FIXTURES: readonly WideFixtureName[] = ["upload", "generate", "done"];

/**
 * The signed in studio across a laptop's width, for Ram to compare with today's.
 * It is the real studio: the same screen, the same wallet and the same sign in
 * as /studio, told to lay itself out wide. The real route is unchanged until he
 * says yes.
 *
 * ?fixture=upload|generate|done draws the same layout from stubbed state with
 * no wallet and no network, for measuring on a machine that cannot sign in.
 * Only this page reads that parameter. Nothing links here and the flag that
 * opens it is only set on this machine, so the route is a 404 everywhere else.
 */
export default async function StudioWideLabPage({
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
  const fixture = fixtureAsked(asked.fixture);

  return (
    <>
      <div className="relative mx-auto w-full max-w-[1400px] px-5 pb-16 pt-7 sm:px-8 sm:pb-24 sm:pt-9">
        <StudioIntro locale={locale} opening="compact" lineUnder />
        <div className="mt-7 sm:mt-8">
          <OpeningProvider opening="compact">
            {fixture === null ? (
              <WalletProvider>
                <StudioScreen initialMode={modeFrom(asked.mode)} layout="wide" />
              </WalletProvider>
            ) : (
              <WideFixture name={fixture} />
            )}
          </OpeningProvider>
        </div>
      </div>
      <Bench fixture={fixture} />
    </>
  );
}

function fixtureAsked(value: string | string[] | undefined): WideFixtureName | null {
  return typeof value === "string" && (FIXTURES as readonly string[]).includes(value) ? (value as WideFixtureName) : null;
}

/** The same reading of ?mode as /studio, so a link into the live drawing opens the same panel. */
function modeFrom(asked: string | string[] | undefined): Mode {
  if (asked === "generate") {
    return "generate";
  }
  if (asked === "register") {
    return "upload";
  }
  return initialRegisterState.mode;
}

/**
 * The strip along the foot of the bench: the live drawing, the three fixtures
 * and today's studio. Laptop only, so it never sits over the phone's tab bar.
 */
async function Bench({ fixture }: { fixture: WideFixtureName | null }) {
  const t = await getTranslations("studio.wide");
  const links: { label: string; href: string; on: boolean }[] = [
    { label: t("live"), href: "/lab/studio-wide", on: fixture === null },
    ...FIXTURES.map((name) => ({ label: t(name), href: `/lab/studio-wide?fixture=${name}`, on: fixture === name })),
  ];

  return (
    <nav
      aria-label={t("bench")}
      className="fixed bottom-4 left-4 z-50 hidden items-center gap-1 rounded-[8px] border border-line-strong bg-bg/90 p-1.5 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur lg:flex"
    >
      {links.map((link) => (
        <Link
          key={link.label}
          href={link.href}
          className={`rounded-[6px] px-2.5 py-1.5 transition-colors duration-200 ${
            link.on ? "bg-accent-soft text-accent" : "text-text-muted hover:text-text"
          }`}
        >
          {link.label}
        </Link>
      ))}
      <span aria-hidden className="mx-1 h-4 w-px bg-line-strong" />
      <Link href="/studio" className="rounded-[6px] px-2.5 py-1.5 text-text-faint transition-colors duration-200 hover:text-accent">
        {t("today")}
      </Link>
      {fixture === null ? null : (
        <span className="px-2.5 normal-case tracking-normal text-text-faint">{t("fixtureNote")}</span>
      )}
    </nav>
  );
}
