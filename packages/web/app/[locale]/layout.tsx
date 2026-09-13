import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getMessages, getTimeZone, getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense, type ReactNode } from "react";
import { HeaderMenu } from "@/components/HeaderMenu";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { ScriptFace } from "@/components/ScriptFace";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IntlProvider } from "@/components/providers/IntlProvider";
import { LenisProvider } from "@/components/providers/LenisProvider";
import { PrivyProvider } from "@/components/providers/PrivyProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { StatusPending, SystemStatus } from "@/components/status/SystemStatus";
import { CHAIN_ID, MONAD_EXPLORER, addresses } from "@/lib/chain/client";
import { activeSource } from "@/lib/data/source";
import { hasIndex } from "@/lib/status/read";
import { fontVariables } from "@/lib/fonts";
import { Link, routing } from "@/lib/i18n/routing";
import "@/styles/globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: t("title"), description: t("description") };
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
  const source = activeSource();

  const nav = [
    { href: "/", label: t("nav.home") },
    { href: "/docs", label: t("nav.docs") },
    { href: "/verify", label: t("nav.verify") },
    { href: "/studio", label: t("nav.studio") },
  ] as const;

  return (
    <html lang={locale} className={fontVariables} suppressHydrationWarning>
      <body className="min-h-dvh bg-bg text-text antialiased">
        <ScriptFace locale={locale} />
        <ThemeProvider>
          <IntlProvider locale={locale} timeZone={timeZone} messages={messages as Record<string, unknown>}>
            <PrivyProvider>
              <LenisProvider>
                <div className="flex min-h-dvh flex-col">
                  <header className="app-header sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
                    {/* The phone bar is one fixed row so its height is a number the film can
                        pull itself up by, --header-h in globals.css. From md it grows back to
                        the padded bar the rest of the site was measured with. */}
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
                          data-lockup="dark"
                          className="hidden dark:block [body:has([data-story])_&]:block"
                        />
                        <Image
                          src="/brand/seal-o/lockup-horizontal-light.svg"
                          alt={t("brand")}
                          width={160}
                          height={63}
                          unoptimized
                          data-lockup="light"
                          className="block dark:hidden [body:has([data-story])_&]:hidden"
                        />
                      </Link>
                      <span className="hidden text-xs uppercase tracking-[0.24em] text-text-faint md:inline">
                        {t("tagline")}
                      </span>
                      <nav className="ml-auto hidden items-center gap-5 text-sm md:flex">
                        {nav.map((item) => (
                          <Link
                            key={item.href}
                            href={item.href}
                            className="text-text-muted transition-colors duration-200 hover:text-accent"
                          >
                            {item.label}
                          </Link>
                        ))}
                      </nav>
                      <div className="hidden items-center gap-2 md:flex">
                        <LocaleSwitch />
                        <ThemeToggle />
                      </div>
                      {/* Everything above, behind one button, from the width where the row
                          would otherwise wrap into three. */}
                      <HeaderMenu links={nav.map((item) => ({ href: item.href, label: item.label }))} />
                    </div>
                  </header>

                  <main className="flex-1">{children}</main>

                  <footer className="border-t border-line">
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
                </div>
              </LenisProvider>
            </PrivyProvider>
          </IntlProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
