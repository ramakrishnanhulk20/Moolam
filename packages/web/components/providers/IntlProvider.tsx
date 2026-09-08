"use client";

import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";

/**
 * Client components read their strings from here. The messages are passed down
 * from the server layout, so no message file is bundled twice.
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
    <NextIntlClientProvider locale={locale} timeZone={timeZone} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
