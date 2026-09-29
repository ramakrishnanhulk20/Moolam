"use client";

import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { timeFormats } from "@/lib/i18n/timeFormats";

/**
 * Client components read their strings from here. The messages are passed down
 * from the server layout, so no message file is bundled twice. The time formats
 * are the server's own, so a time reads the same before and after hydration.
 */
export function IntlProvider({
  locale,
  timeZone,
  messages,
  children,
}: {
  locale: string;
  timeZone: string;
  messages: Record<string, unknown>;
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone} formats={timeFormats} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
