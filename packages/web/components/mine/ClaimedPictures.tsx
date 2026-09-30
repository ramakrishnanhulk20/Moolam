"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { shortHex } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";
import type { ClaimedPassport } from "./held";

/**
 * The pictures a listed platform registered for this person and then handed
 * to them. The credit rule names them as the person who imagined each one, so
 * these are drawn as their own work, straight under their own grid and in its
 * card, and the one line on each says where it was drawn and how it arrived.
 * They are never hidden: hiding is for things a wallet was sent, not its own.
 */
export function ClaimedPictures({ rows }: { rows: ClaimedPassport[] }) {
  const t = useTranslations("mine");
  const studio = useTranslations("studio");
  const common = useTranslations("common");
  const kinds = useTranslations("kind");
  const format = useFormatter();

  if (rows.length === 0) {
    return null;
  }

  return (
    <ul data-mine-claimed className="mt-8 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((row, index) => (
        <motion.li
          key={row.id}
          data-claimed={row.id}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, delay: Math.min(index, 5) * 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="group bg-bg-raised"
        >
          <Link href={`/passport/${row.id}`} className="block">
            <div className="grain relative aspect-[4/3] overflow-hidden bg-bg-sunken">
              {row.imageUrl === undefined ? (
                <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                  {studio("passports.noThumbnail")}
                </span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- drawn exactly as the own grid above draws its pinned thumbnails, so the two read as one
                <img
                  src={row.imageUrl}
                  alt={row.title ?? common("registeredPicture")}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                />
              )}
              <div className="scrim pointer-events-none absolute inset-0" />
            </div>

            <div className="min-w-0 p-5">
              <p className="truncate text-sm text-text transition-colors duration-200 group-hover:text-accent">
                {row.title ?? studio("passports.untitled")}
              </p>
              <p className="mt-2 font-mono text-[11px] text-text-faint">{shortHex(row.id, 10, 8)}</p>
              <p className="mt-1 font-mono text-[11px] text-text-faint">
                {kinds(String(row.kind))} <span className="mx-1">/</span>
                {format.dateTime(new Date(Number(row.registeredAt) * 1000), "moment")}
              </p>
              <p data-claimed-line className="mt-3 flex items-start gap-2 text-sm leading-snug text-text-muted">
                <span aria-hidden className="motif mt-[5px] h-[6px] w-[6px] shrink-0" />
                <span className="min-w-0">{t("claimedLine", { platform: row.platform })}</span>
              </p>
            </div>
          </Link>
        </motion.li>
      ))}
    </ul>
  );
}
