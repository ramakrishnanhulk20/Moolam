import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";
import { timeFormats } from "./timeFormats";

/**
 * Loads the message file for the locale in the URL. An unknown locale falls
 * back to English rather than rendering a page with no words on it.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    // Times are shown in UTC everywhere. A passport's timestamp is a chain fact,
    // and rendering it in the server's zone and then the visitor's would make the
    // markup disagree with itself. The named formats print the zone beside
    // every time of day, so nobody reads UTC as their own clock.
    timeZone: "UTC",
    formats: timeFormats,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
