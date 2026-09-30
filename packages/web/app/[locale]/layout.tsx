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
import { BottomBar } from "@/components/shell/BottomBar";
import { HeaderNav } from "@/components/shell/HeaderNav";
import { LateInsights } from "@/components/shell/LateInsights";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { ThemeColor } from "@/components/shell/ThemeColor";
import type { Tab } from "@/components/shell/tabs";
import { IntlProvider } from "@/components/providers/IntlProvider";
import { LenisProvider } from "@/components/providers/LenisProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { StatusPending, SystemStatus } from "@/components/status/SystemStatus";
import { CHAIN_ID, MONAD_EXPLORER, addresses, shortHex } from "@/lib/chain/client";
import { activeSource } from "@/lib/data/source";
import { hasIndex } from "@/lib/status/read";
import { labPagesOn } from "@/lib/docs/drafts";
import { fontVariables } from "@/lib/fonts";
import { Link, routing } from "@/lib/i18n/routing";
import { siteUrl } from "@/app/robots";
import "@/styles/globals.css";

const SOURCE_URL = "https://github.com/ramakrishnanhulk20/Moolam";

/** One footer row: 44 px tall, which is the tap pad every footer link carries. */
const FOOTER_ROW = "inline-flex min-h-11 items-center";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

/**
 * The colour a phone paints its own bar with. Two of them, because the site
 * carries two palettes and the browser picks by the reader's system setting:
 * the same two values --bg holds in globals.css. Without either, the bar stayed
 * grey above a black film and above a cream page alike. These are what a page
 * paints with before its script runs; ThemeColor then rewrites both to the
 * theme the reader actually chose.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e4ddd0" },
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

  // The studio and My pictures carry the wallet. Left to prefetch, a reader of
  // any other page quietly pulls half a megabyte of a screen they may never
  // open, so those two are fetched when they are clicked.
  //
  // Verify and Explore are fetched on intent, the way the phone's tabs are
  // (see IntentLink): Verify's page carries the whole check, and both landed
  // inside the first seconds of the home page when fetched on sight. Agents and
  // Docs stay as they were: neither was fetched in the home page's first five
  // seconds on a phone.
  //
  // The last three carry the name the first visit guide points at, the same names
  // the phone's tabs carry below. Only one of each pair is ever on the screen,
  // so the guide can look for the name and take whichever answers.
  //
  // There is no Home link: the logo is the way home on a laptop. The phone's
  // bar keeps its Home tab, because it has no logo under the thumb.
  //
  // My pictures is last and shown to everyone, signed in or not: a first
  // visitor should see that the page exists, and pressing it signed out lands
  // on the card that offers the sign in. Not prefetched, because that page
  // carries the wallet.
  const nav = [
    { href: "/explore", label: t("nav.explore"), prefetch: "intent", anchor: undefined },
    { href: "/agents", label: t("nav.agents"), prefetch: undefined, anchor: undefined },
    { href: "/docs", label: t("nav.docs"), prefetch: undefined, anchor: undefined },
    { href: "/verify", label: t("nav.verify"), prefetch: "intent", anchor: "verify" },
    { href: "/studio", label: t("nav.studio"), prefetch: false, anchor: "studio" },
    { href: "/mine", label: mine("entry"), prefetch: false, anchor: "mine" },
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
            {/* The browser's own bar follows the theme the reader picked,
                not only the system setting the head's two tags choose by. */}
            <ThemeColor />
            <LenisProvider>
              <div className="flex min-h-dvh flex-col">
                {/* Below md the top of the screen is the wordmark and the two
                    chips, and everything the old menu button held is in the tab
                    bar at the bottom instead. It keeps the app-header class, so
                    the rules in globals.css that dress this bar over the film
                    still find it. */}
                <PhoneHeader brand={t("brand")} className="app-header md:hidden" />

                <header className="app-header sticky top-0 z-40 hidden border-b border-line bg-bg/85 backdrop-blur-md md:block">
                  <div className="mx-auto flex h-[55px] w-full max-w-[1400px] items-center gap-x-6 px-5 sm:px-8 md:h-auto md:flex-wrap md:gap-x-4 md:gap-y-5 md:py-3 lg:gap-y-3 lg:py-4 xl:gap-x-6">
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
                        src="/brand/kolam/lockup-horizontal-dark.svg"
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
                        src="/brand/kolam/lockup-horizontal-light.svg"
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
                    <span className="hidden h-[1lh] min-w-0 grow basis-0 flex-wrap overflow-hidden text-xs uppercase tracking-[0.24em] text-text-faint lg:flex">
                      <span aria-hidden className="h-[1lh] w-0" />
                      <span className="whitespace-nowrap">{t("tagline")}</span>
                    </span>
                    {/* The page being read is lit the way the phone bar lights
                        its tab. The words come from here, so the client part
                        carries no messages of its own.

                        Between md and lg the bar is two rows by design: the
                        wordmark and the two chips on top, the links on a row
                        of their own under them. Left to wrap where they fell,
                        the links, the chips and the tagline took three rows
                        and 130 px at 768, and German took three at every
                        width below a laptop. The tagline waits for lg. The 20
                        px between the rows keeps the chips' 44 px tap pads
                        off the links below them. Up to xl the gaps stay
                        tight, so English holds one row at 1024 with a
                        scrollbar taking 15 px of it. */}
                    <HeaderNav links={nav} label={bar("label")} />
                    {/* tap-row grows both chips to a 44 px target the same way
                        the phone menu grows them, without moving anything. */}
                    <div className="tap-row ml-auto hidden items-center gap-2 md:flex lg:ml-0">
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
                  {/* Every row is 44 px tall, the same as the invisible pad
                      globals.css hangs on each footer link, so a pad ends
                      where its row does. With rows the height of their text,
                      the pad of Show the guide again reached up over Docs,
                      Privacy and Terms on a phone, and a thumb on Privacy
                      opened the guide. items-start keeps each link as wide as
                      its words rather than the whole column. */}
                  <div className="mx-auto flex w-full max-w-[1400px] flex-col items-start gap-x-8 px-5 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-y-1 sm:px-8">
                    <span className={FOOTER_ROW}>{f("network", { chainId: CHAIN_ID })}</span>
                    <a
                      href={`${MONAD_EXPLORER}/address/${addresses.registry}`}
                      target="_blank"
                      rel="noreferrer"
                      title={addresses.registry}
                      aria-label={`${f("registry")} ${addresses.registry}`}
                      className={`${FOOTER_ROW} gap-[0.6em] transition-colors duration-200 hover:text-accent`}
                    >
                      {/* The row is set in capitals, which turned the address
                          into 0X and a run of capital hex that reads as a
                          different string from the one an explorer shows. A
                          short lowercase id is enough to recognise it; the
                          full address is in the title and the link's name. */}
                      {f("registry")}
                      <span className="normal-case">{shortHex(addresses.registry.toLowerCase())}</span>
                    </a>
                    <span className={FOOTER_ROW}>{f("index", { source: f(`source${source[0].toUpperCase()}${source.slice(1)}`) })}</span>
                    {/* The one thing a judge on the live URL could not reach from
                        anywhere on the site: the code itself. */}
                    <a
                      href={SOURCE_URL}
                      target="_blank"
                      rel="noreferrer"
                      className={`${FOOTER_ROW} transition-colors duration-200 hover:text-accent`}
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
                    <span className="flex flex-wrap items-center gap-x-4">
                      <Link href="/docs" className={`${FOOTER_ROW} transition-colors duration-200 hover:text-accent`}>
                        {t("nav.docs")}
                      </Link>
                      <Link
                        href="/docs/legal/privacy"
                        className={`${FOOTER_ROW} transition-colors duration-200 hover:text-accent`}
                      >
                        {f("privacy")}
                      </Link>
                      <Link href="/docs/legal/terms" className={`${FOOTER_ROW} transition-colors duration-200 hover:text-accent`}>
                        {f("terms")}
                      </Link>
                      {/* The way back to the first visit guide, for anyone who
                          skipped it or wants it again. It forgets the mark on
                          this device and shouts; the home page hears it. It
                          is a button, and a button does not take the row's
                          capitals, so it asks for them itself. */}
                      <ShowGuideAgain label={g("again")} className={`${FOOTER_ROW} uppercase`} />
                    </span>

                    {/* The three services, read while the page is rendered. The boundary
                        keeps a slow service off the critical path: the rest of the footer
                        is already on screen while the line is still waiting. */}
                    <div className={FOOTER_ROW}>
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
                  </div>
                </footer>

                {/* The phone's navigation, under the thumb, on every page and
                    through the whole film on the home page, which leaves the
                    bar its room rather than hiding it, so Mine and the rest
                    are one tap away at every scroll position. */}
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
