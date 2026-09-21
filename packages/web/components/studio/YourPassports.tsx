"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { shortHex } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";
import type { CreatorPassports } from "@/lib/studio/useCreatorPassports";
import { useHeadingLeading } from "./leading";

/**
 * Everything this account has registered, read from the index rather than from
 * anything this session remembers. An account with nothing in it says so in
 * words, and never shows a placeholder row.
 */
export function YourPassports({ passports }: { passports: CreatorPassports }) {
  const t = useTranslations("studio");
  const common = useTranslations("common");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const kinds = useTranslations("kind");
  const format = useFormatter();

  return (
    <section className="mt-24 border-t border-line pt-10 sm:mt-32">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 className={`font-display text-[clamp(1.6rem,3.2vw,2.6rem)] uppercase tracking-[-0.02em] ${leading}`}>
          {t("passports.heading")}
        </h2>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("passports.source")}</p>
      </div>

      {passports.status === "reading" ? (
        <p className="mt-8 text-sm text-text-muted">{t("passports.reading")}</p>
      ) : passports.status === "unreadable" ? (
        <p className="mt-8 max-w-[54ch] text-sm leading-relaxed text-failed">
          {t("passports.unreadable", { reason: passports.error ?? "" })}
        </p>
      ) : passports.passports.length === 0 ? (
        <p className="mt-8 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("passports.empty")}</p>
      ) : (
        <ul className="mt-10 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {passports.passports.map((passport, index) => (
            <motion.li
              key={passport.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.6, delay: Math.min(index, 5) * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="group bg-bg-raised"
            >
              <Link href={`/passport/${passport.id}`} className="block">
                <div className="grain relative aspect-[4/3] overflow-hidden bg-bg-sunken">
                  {passport.imageUrl === undefined ? (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {t("passports.noThumbnail")}
                    </span>
                  ) : (
                    // The pinned thumbnail, the same file a verifier fetches when it re-checks this image.
                    <img
                      src={passport.imageUrl}
                      alt={passport.title ?? common("registeredPicture")}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  )}
                  <div className="scrim pointer-events-none absolute inset-0" />
                </div>

                <div className="p-5">
                  <p className="truncate text-sm text-text transition-colors duration-200 group-hover:text-accent">
                    {passport.title ?? t("passports.untitled")}
                  </p>
                  <p className="mt-2 font-mono text-[11px] text-text-faint">{shortHex(passport.id, 10, 8)}</p>
                  <p className="mt-1 font-mono text-[11px] text-text-faint">
                    {kinds(String(passport.kind))} <span className="mx-1">/</span>
                    {format.dateTime(new Date(Number(passport.registeredAt) * 1000), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                </div>
              </Link>
            </motion.li>
          ))}
        </ul>
      )}
    </section>
  );
}
