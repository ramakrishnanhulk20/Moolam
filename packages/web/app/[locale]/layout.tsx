import type { Metadata, Viewport } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getMessages, getTimeZone, getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense, type ReactNode } from "react";
import { LocaleSwitch, PageAddress } from "@/components/LocaleSwitch";
import { ScriptFace } from "@/components/ScriptFace";
import { ShowGuideAgain } from "@/components/guide/ShowGuideAgain";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BottomBar, IntentLink } from "@/components/shell/BottomBar";
import { LateInsights } from "@/components/shell/LateInsights";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import type { Tab } from "@/components/shell/tabs";
import { IntlProvider } from "@/components/providers/IntlProvider";
import { LenisProvider } from "@/components/providers/LenisProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { StatusPending, SystemStatus } from "@/components/status/SystemStatus";
import { CHAIN_ID, MONAD_EXPLORER, addresses } from "@/lib/chain/client";
import { activeSource } from "@/lib/data/source";
import { hasIndex } from "@/lib/status/read";
import { labPagesOn } from "@/lib/docs/drafts";
import { fontVariables } from "@/lib/fonts";
import { Link, routing } from "@/lib/i18n/routing";
import { siteUrl } from "@/app/robots";
import "@/styles/globals.css";

const SOURCE_URL = "https://github.com/ramakrishnanhulk20/Moolam";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

/**
 * The colour a phone paints its own bar with. Two of them, because the site
 * carries two palettes and the browser picks by the reader's system setting:
 * the same two values --bg holds in globals.css. Without either, the bar stayed
 * grey above a black film and above a cream page alike.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2efe9" },
    { media: "(prefers-color-scheme: dark)", color: "#08080a" },
  ],
};

/**
 * What Open Graph calls each of the ten languages. It wants a language and a
 * territory, where the routes only carry a language, so each one is paired with
 * the country the site's own copy is written for.
 */
const OG_LOCALES: Record<string, string> = {
  en: "en_US",
  ta: "ta_IN",
  hi: "hi_IN",
  zh: "zh_CN",
  ja: "ja_JP",
  ko: "ko_KR",
  es: "es_ES",
  fr: "fr_FR",
  de: "de_DE",
  pt: "pt_BR",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });

  // Every page under here sets its own title and the template adds the brand to
  // it, so a tab never reads "Moolam" for a page that is not the home page.
  //
  // The base is the public domain. Every card on the site names its picture with
  // a path, and without a base Next resolves those against whichever deployment
  // URL answered the crawler, so a link pasted into a chat would point its
  // picture at a preview host that nobody else can read.
  //
  // "./" is Next's way of saying "this page": it resolves the canonical against
  // whatever route is being drawn, so one line here is right on all forty six
  // pages. The hreflang links and the three social lines cannot be written
  // here: a layout is never told which page it is wrapping, and an openGraph
  // block declared at this level would replace the one Next builds from the
  // card file and take the picture with it. PageAddress renders them instead.
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: t("title"), template: t("titleTemplate") },
    description: t("description"),
    alternates: { canonical: "./" },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const messages = await getMessages();
  const timeZone = await getTimeZone();
  const t = await getTranslations({ locale, namespace: "header" });
  const f = await getTranslations({ locale, namespace: "footer" });
  const m = await getTranslations({ locale, namespace: "meta" });
  const mine = await getTranslations({ locale, namespace: "mine" });
  const bar = await getTranslations({ locale, namespace: "shell" });
  const g = await getTranslations({ locale, namespace: "guide" });
  const source = activeSource();

  // Vercel sets VERCEL on its own machines, so nothing is counted on a laptop,
  // in a test or on any other host. A page viewed on the maintainer's own dev
  // server, where the lab flag is on, is not a visit either, so the two
  // conditions are one line. Neither package sets a cookie and neither is
  // given one.
  const counted = process.env.VERCEL === "1" && !labPagesOn();

  // The studio is the one route in this bar that carries the wallet. Left to
  // prefetch, a reader of any other page quietly pulls half a megabyte of a
  // screen they may never open, so that link is fetched when it is clicked.
  //
  // Verify and Explore are fetched on intent, the way the phone's tabs are
  // (see IntentLink): Verify's page carries the whole check, and both landed
  // inside the first seconds of the home page when fetched on sight. Agents and
  // Docs stay as they were: neither was fetched in the home page's first five
  // seconds on a phone.
  //
  // The last two carry the name the first visit guide points at, the same names
  // the phone's tabs carry below. Only one of the two is ever on the screen, so
  // the guide can look for the name and take whichever answers.
  //
  // There is no Home link: the logo is the way home on a laptop. The phone's
  // bar keeps its Home tab, because it has no logo under the thumb.
  const nav = [
    { href: "/explore", label: t("nav.explore"), prefetch: "intent", anchor: undefined },
    { href: "/agents", label: t("nav.agents"), prefetch: undefined, anchor: undefined },
    { href: "/docs", label: t("nav.docs"), prefetch: undefined, anchor: undefined },
    { href: "/verify", label: t("nav.verify"), prefetch: "intent", anchor: "verify" },
    { href: "/studio", label: t("nav.studio"), prefetch: false, anchor: "studio" },
  ] as const;

  // The phone's whole navigation, in the order a thumb reads it: the raised
  // Make sits in the middle.
  // Two of the five are never prefetched because both pages carry the wallet.
  // The last three carry the name the first-visit guide points at.
  const tabs: Tab[] = [
    { key: "home", href: "/", label: bar("tabs.home") },
    { key: "explore", href: "/explore", label: bar("tabs.explore") },
    { key: "make", href: "/studio", label: bar("tabs.make"), prefetch: false, anchor: "studio" },
    { key: "verify", href: "/verify", label: bar("tabs.verify"), anchor: "verify" },
    { key: "mine", href: "/mine", label: bar("tabs.mine"), prefetch: false, anchor: "mine" },
  ];

  return (
    <html lang={locale} className={fontVariables} suppressHydrationWarning>
      <body className="min-h-dvh bg-bg text-text antialiased">
        <ScriptFace locale={locale} />
        <ThemeProvider>
          <IntlProvider locale={locale} timeZone={timeZone} messages={messages as Record<string, unknown>}>
            {/* The ten addresses this page answers at, and its own. React lifts
                these into the head, and they read the route from inside the
                provider, which is where next-intl knows which locale to
                strip. */}
            <PageAddress
              site={siteUrl()}
              siteName={m("title")}
              ogLocale={OG_LOCALES[locale] ?? OG_LOCALES[routing.defaultLocale]}
            />
            <LenisProvider>
              <div className="flex min-h-dvh flex-col">
                {/* Below md the top of the screen is the wordmark and the two
                    chips, and everything the old menu button held is in the tab
                    bar at the bottom instead. It keeps the app-header class, so
                    the rules in globals.css that dress this bar over the film
                    still find it. */}
                <PhoneHeader brand={t("brand")} className="app-header md:hidden" />

                <header className="app-header sticky top-0 z-40 hidden border-b border-line bg-bg/85 backdrop-blur-md md:block">
                  <div className="mx-auto flex h-[55px] w-full max-w-[1400px] items-center gap-x-6 px-5 sm:px-8 md:h-auto md:flex-wrap md:gap-y-3 md:py-4">
                    {/* The lockup files carry clear space on every side, so the box is 63 px
                        tall for 24 px of cap height and the negative margin keeps the bar the
                        height the ink asks for. The theme class picks the variant, and the
                        story pages force the dark one because that bar floats on a dark film.
                        Under the light theme the story bar is the page's own cream, so the two
                        rules in globals.css that watch data-lockup hand the light one back. */}
                    <Link
                      href="/"
                      className="-my-[18px] flex items-center transition-opacity duration-200 hover:opacity-70"
                    >
                      <Image
                        src="/brand/seal-o/lockup-horizontal-dark.svg"
                        alt={t("brand")}
                        width={160}
                        height={63}
                        unoptimized
                        loading="eager"
                        fetchPriority="high"
                        data-lockup="dark"
                        className="hidden dark:block [body:has([data-story])_&]:block"
                      />
                      {/* Only one of the two lockups is ever painted, and the
                          server cannot know which: the theme is a class the
                          browser puts on. So the high priority goes to the
                          dark one, which is the default theme and the one
                          every story page uses. This one still loads with the
                          document, it just no longer competes with the
                          picture the first screen is actually waiting on. */}
                      <Image
                        src="/brand/seal-o/lockup-horizontal-light.svg"
                        alt={t("brand")}
                        width={160}
                        height={63}
                        unoptimized
                        loading="eager"
                        data-lockup="light"
                        className="block dark:hidden [body:has([data-story])_&]:hidden"
                      />
                    </Link>
                    {/* The tagline takes only the room the links leave, and
                        steps out of the way when that is too little, rather
                        than pushing the links and chips to a second row. In
                        French, Spanish, Portuguese and Tamil the second row
                        made the bar 102 px at 1440, which pushed the home
                        page's Make one and its sponsor line below the fold.
                        The empty first item is what lets it drop: a tagline
                        wider than its box wraps to the second line of this
                        one-line box, which is clipped. */}
                    <span className="hidden h-[1lh] min-w-0 grow basis-0 flex-wrap overflow-hidden text-xs uppercase tracking-[0.24em] text-text-faint md:flex">
                      <span aria-hidden className="h-[1lh] w-0" />
                      <span className="whitespace-nowrap">{t("tagline")}</span>
                    </span>
                    {/* gap-4 rather than gap-5: at 20 px between links the
                        language and theme chips dropped to a second row. */}
                    <nav className="ml-auto hidden items-center gap-4 text-sm md:flex">
                      {nav.map((item) =>
                        item.prefetch === "intent" ? (
                          <IntentLink
                            key={item.href}
                            href={item.href}
                            data-guide-anchor={item.anchor}
                            className="tap text-text-muted transition-colors duration-200 hover:text-accent"
                          >
                            {item.label}
                          </IntentLink>
                        ) : (
                          <Link
                            key={item.href}
                            href={item.href}
                            prefetch={item.prefetch}
                            data-guide-anchor={item.anchor}
                            className="tap text-text-muted transition-colors duration-200 hover:text-accent"
                          >
                            {item.label}
                          </Link>
                        ),
                      )}
                      {/* The way back to your own pictures. Everyone gets it,
                          signed in or not: a first visitor should be able to see
                          that the page exists, and pressing it signed out lands
                          on the card that offers the sign in. Not prefetched,
                          because that page carries the wallet. */}
                      <Link
                        href="/mine"
                        prefetch={false}
                        data-guide-anchor="mine"
                        className="tap whitespace-nowrap text-text-muted transition-colors duration-200 hover:text-accent"
                      >
                        {mine("entry")}
                      </Link>
                    </nav>
                    {/* tap-row grows both chips to a 44 px target the same way
                        the phone menu grows them, without moving anything. */}
                    <div className="tap-row hidden items-center gap-2 md:flex">
                      <LocaleSwitch />
                      <ThemeToggle />
                    </div>
                  </div>
                </header>

                <main className="flex-1">{children}</main>

                {/* The room the tab bar asks for, on the last thing in the
                    column rather than on main: the footer comes after main, so
                    main's own padding left the registry line and the three
                    service lights 57 px behind the bar, measured at 375. The
                    room is the bar's 56 px plus whatever the phone keeps for
                    its home indicator, which is --bar-room in globals.css. */}
                <footer className="border-t border-line pb-[var(--bar-room)] md:pb-0">
                  <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-x-8 gap-y-3 px-5 py-6 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-8">
                    <span>{f("network", { chainId: CHAIN_ID })}</span>
                    <a
                      href={`${MONAD_EXPLORER}/address/${addresses.registry}`}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all transition-colors duration-200 hover:text-accent"
                    >
                      {f("registry")} {addresses.registry}
                    </a>
                    <span>{f("index", { source: f(`source${source[0].toUpperCase()}${source.slice(1)}`) })}</span>
                    {/* The one thing a judge on the live URL could not reach from
                        anywhere on the site: the code itself. */}
                    <a
                      href={SOURCE_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="transition-colors duration-200 hover:text-accent"
                    >
                      {f("source")}
                    </a>
                    {/* The docs, and the two pages that say what this site
                        stores and what it promises. Docs are in the desktop bar
                        at the top, which a phone no longer has: the five tabs
                        are the product's own places and the docs are not one of
                        them, so this is where a phone reaches them from. The
                        word is the one the top bar already uses, in all ten
                        languages. Released on 22 September 2026; a page that is
                        still a draft is held back by its flag in docs/nav.json,
                        never by this footer. */}
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <Link href="/docs" className="transition-colors duration-200 hover:text-accent">
                        {t("nav.docs")}
                      </Link>
                      <Link
                        href="/docs/legal/privacy"
                        className="transition-colors duration-200 hover:text-accent"
                      >
                        {f("privacy")}
                      </Link>
                      <Link href="/docs/legal/terms" className="transition-colors duration-200 hover:text-accent">
                        {f("terms")}
                      </Link>
                      {/* The way back to the first visit guide, for anyone who
                          skipped it or wants it again. It forgets the mark on
                          this device and shouts; the home page hears it. */}
                      <ShowGuideAgain label={g("again")} />
                    </span>

                    {/* The three services, read while the page is rendered. The boundary
                        keeps a slow service off the critical path: the rest of the footer
                        is already on screen while the line is still waiting. */}
                    <Suspense
                      fallback={
                        <StatusPending
                          labels={[
                            f("status.verifier"),
                            ...(hasIndex() ? [f("status.index")] : []),
                            f("status.chain"),
                          ]}
                        />
                      }
                    >
                      <SystemStatus />
                    </Suspense>
                  </div>
                </footer>

                {/* The phone's navigation, under the thumb, on every page. It
                    draws itself out of the way while the film on the home page
                    is being scrolled and arrives with the closing card. */}
                <div className="md:hidden">
                  <BottomBar tabs={tabs} label={bar("label")} shape="raised" />
                </div>
              </div>
            </LenisProvider>
          </IntlProvider>
        </ThemeProvider>
        {/* Vercel's counter and Speed Insights, mounted once the page has
            painted and gone idle, with their code in a chunk of its own. */}
        {counted ? <LateInsights /> : null}
      </body>
    </html>
  );
}
