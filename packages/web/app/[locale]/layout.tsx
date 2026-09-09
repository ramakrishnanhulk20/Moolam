import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getMessages, getTimeZone, getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IntlProvider } from "@/components/providers/IntlProvider";
import { LenisProvider } from "@/components/providers/LenisProvider";
import { PrivyProvider } from "@/components/providers/PrivyProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { CHAIN_ID, MONAD_EXPLORER, addresses } from "@/lib/chain/client";
import { activeSource } from "@/lib/data/source";
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
    { href: "/verify", label: t("nav.verify") },
    { href: "/studio", label: t("nav.studio") },
  ] as const;

  return (
    <html lang={locale} className={fontVariables} suppressHydrationWarning>
      <body className="min-h-dvh bg-bg text-text antialiased">
        <ThemeProvider>
          <IntlProvider locale={locale} timeZone={timeZone} messages={messages as Record<string, unknown>}>
            <PrivyProvider>
              <LenisProvider>
                <div className="flex min-h-dvh flex-col">
                  <header className="app-header sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
                    <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 sm:px-8">
                      <Link
                        href="/"
                        className="font-display text-2xl uppercase leading-none tracking-[0.06em] transition-colors duration-200 hover:text-accent"
                      >
                        {t("brand")}
                      </Link>
                      <span className="hidden text-xs uppercase tracking-[0.24em] text-text-faint md:inline">
                        {t("tagline")}
                      </span>
                      <nav className="ml-auto flex items-center gap-5 text-sm">
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
                      <div className="flex items-center gap-2">
                        <LocaleSwitch />
                        <ThemeToggle />
                      </div>
                    </div>
                  </header>

                  <main className="flex-1">{children}</main>

                  <footer className="border-t border-line">
                    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-2 px-5 py-6 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint sm:flex-row sm:items-center sm:justify-between sm:px-8">
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
