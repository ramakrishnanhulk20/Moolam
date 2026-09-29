import type { Formats } from "next-intl";

/**
 * The two ways the site writes a time of day, each naming its clock. The
 * server renders in UTC, so a reader in India or Berlin would otherwise read a
 * bare "3:45 PM" as their own afternoon.
 *
 * Spelled out field by field because Intl refuses a zone name alongside
 * dateStyle or timeStyle. Callers ask for these by name: next-intl hands an
 * inline options object to Intl untouched, so only a named format picks up
 * the zone.
 */
export const timeFormats = {
  dateTime: {
    moment: {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    },
    time: {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    },
  },
} satisfies Formats;
