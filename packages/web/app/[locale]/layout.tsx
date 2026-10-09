import type { Metadata, Viewport } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getMessages, getTimeZone, getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense, type CSSProperties, type ReactNode } from "react";
import { LocaleSwitch, PageAddress } from "@/components/LocaleSwitch";
import { ScriptFace } from "@/components/ScriptFace";
import { ShowGuideAgain } from "@/components/guide/ShowGuideAgain";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BottomBar } from "@/components/shell/BottomBar";
import { MenuBar } from "@/components/menu/MenuBar";
import { ItemMark } from "@/components/menu/marks";
import { PhoneMenu } from "@/components/menu/PhoneMenu";
import { LateInsights } from "@/components/shell/LateInsights";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { ThemeColor } from "@/components/shell/ThemeColor";
import { PHONE_ROOM, type BarItem } from "@/components/shell/tabs";
import { IntlProvider } from "@/components/providers/IntlProvider";
import { LenisProvider } from "@/components/providers/LenisProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { WalletHost } from "@/components/providers/WalletProvider";
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
 * The colour a phone paints its own bar with: each theme's --bg from
 * globals.css, one tag per device setting, because a first visit is shown the
 * theme the device is set to and a page with no script follows it too.
 * ThemeColor rewrites both tags before the first paint for a reader whose
 * switch disagrees with the device, and again whenever the switch is pressed.
 * Written out rather than imported: a value exported from a client module
 * arrives here as a reference, not as the string.
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
  const menu = await getTranslations({ locale, namespace: "menu" });
  const bar = await getTranslations({ locale, namespace: "shell" });
  const g = await getTranslations({ locale, namespace: "guide" });
  const source = activeSource();

  // Vercel sets VERCEL on its own machines, so nothing is counted on a laptop,
  // in a test or on any other host. A page viewed on the maintainer's own dev
  // server, where the lab flag is on, is not a visit either, so the two
  // conditions are one line. Neither package sets a cookie and neither is
  // given one.
  const counted = process.env.VERCEL === "1" && !labPagesOn();

  // The phone's whole navigation, in the order a thumb reads it: the raised
  // Make sits in the middle. Menu opens the sheet with the two sides, and
  // Explore lives in it under For personal.
  // Two of the five are never prefetched because both pages carry the wallet.
  // The last three carry the name the first-visit guide points at.
  const tabs: BarItem[] = [
    { key: "home", href: "/", label: bar("tabs.home") },
    { key: "menu", label: menu("label") },
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
            {/* The browser's own bar follows the theme in use, which the
                head's one tag cannot know for a reader who chose dark. */}
            <ThemeColor />
            <LenisProvider>
              {/* --bar-room is the phone's whole bottom room, the tab bar and
                  the Make disc above it (PHONE_ROOM in tabs.ts). Set
                  here, it reaches everything that keeps clear of the bottom:
                  the footer, the film's captions, the framed film and the
                  full-screen pages. Every reader of it is a phone-only rule,
                  so a laptop is unaffected. */}
              <div className="flex min-h-dvh flex-col" style={{ "--bar-room": PHONE_ROOM } as CSSProperties}>
                {/* Below md the top of the screen is the wordmark and the two
                    chips, and everything the old menu button held is in the tab
                    bar at the bottom instead. It keeps the app-header class, so
                    the rules in globals.css that dress this bar over the film
                    still find it. */}
                <PhoneHeader brand={t("brand")} className="app-header md:hidden" />

                <header className="app-header sticky top-0 z-40 hidden border-b border-line bg-bg/85 backdrop-blur-md md:block">
                  {/* Two sides, For personal and For business, each opening a
                      panel of its pages under the bar. The wordmark is the way
                      home on a laptop; the phone keeps a Home tab instead. */}
                  <MenuBar
                    tagline={t("tagline")}
                    home={
                      <>
                        {/* The lockup files carry clear space on every side, so the box is 63 px
                            tall for 24 px of cap height and the negative margin keeps the bar the
                            height the ink asks for. The theme class picks the variant. */}
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
                            data-lockup="dark"
                            className="hidden dark:block"
                          />
                          {/* Only one of the two lockups is ever painted, and the
                              server cannot know which: the theme is a class the
                              browser puts on, from the device setting or the
                              reader's own choice. So the high priority is a
                              guess and goes to the light one. The dark one
                              still loads with the document, it just does not
                              compete with the picture the first screen is
                              actually waiting on. */}
                          <Image
                            src="/brand/kolam/lockup-horizontal-light.svg"
                            alt={t("brand")}
                            width={160}
                            height={63}
                            unoptimized
                            loading="eager"
                            fetchPriority="high"
                            data-lockup="light"
                            className="block dark:hidden"
                          />
                        </Link>
                      </>
                    }
                    right={
                      // tap-row grows the account and both chips to a 44 px
                      // target without moving anything. My pictures is shown
                      // to everyone, signed in or not: pressed signed out it
                      // lands on the card that offers the sign in. Never
                      // prefetched, because that page carries the wallet.
                      <div className="tap-row flex items-center gap-2">
                        <Link
                          href="/mine"
                          prefetch={false}
                          data-guide-anchor="mine"
                          className="flex items-center gap-2 whitespace-nowrap rounded-[8px] border border-line px-3 py-1.5 text-xs tracking-[0.06em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
                        >
                          <ItemMark name="mine" size={14} />
                          <span className="max-lg:sr-only">{menu("account")}</span>
                        </Link>
                        <LocaleSwitch />
                        <ThemeToggle />
                      </div>
                    }
                  />
                </header>

                <main className="flex-1"><WalletHost>{children}</WalletHost></main>

                {/* The room the bar asks for, on the last thing in the
                    column rather than on main: the footer comes after main, so
                    main's own padding left the registry line and the three
                    service lights 57 px behind the bar, measured at 375. The
                    room is --bar-room, set on the column above. */}
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
                    are one tap away at every scroll position. The menu's
                    sheet holds the bar so its Menu tab can open it. */}
                <div className="md:hidden">
                  <PhoneMenu>
                    <BottomBar tabs={tabs} label={bar("label")} shape="raised" />
                  </PhoneMenu>
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
