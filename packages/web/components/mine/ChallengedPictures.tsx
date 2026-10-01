"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { AnswerShown } from "@/components/challenge/AnswerShown";
import { HolderAnswer } from "@/components/challenge/HolderAnswer";
import { shortHex } from "@/lib/chain/client";
import { heldChallenges, type HeldChallenge } from "@/lib/disputes/heldChallenges";
import { Link } from "@/lib/i18n/routing";

/**
 * The challenges against pictures this wallet holds, at the top of My pictures,
 * because each one has a clock on it. Silent while it reads, when there are
 * none, and when the index will not answer: the grid under it already reads the
 * same index and says so in words.
 */
export function ChallengedPictures({ wallet }: { wallet: Hex }) {
  const [answer, setAnswer] = useState<{ wallet: Hex; rows: HeldChallenge[] } | null>(null);

  useEffect(() => {
    let live = true;
    void heldChallenges(wallet)
      .then((rows) => {
        if (live) {
          setAnswer({ wallet, rows });
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet]);

  const rows = answer !== null && answer.wallet === wallet ? answer.rows : [];
  return rows.length === 0 ? null : <ChallengedList rows={rows} />;
}

/** The list itself, apart from its reads, so a test can draw it from fixture rows. */
export function ChallengedList({ rows }: { rows: HeldChallenge[] }) {
  const t = useTranslations("challenge.held");
  const claimWord = useTranslations("passport.dispute");
  const studio = useTranslations("studio");
  const format = useFormatter();

  return (
    <section
      data-mine-challenged
      aria-labelledby="mine-challenged-heading"
      className="mb-16 border-s-2 border-disputed bg-disputed/5 p-6 sm:p-8"
    >
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-disputed">
        <span aria-hidden className="motif h-2 w-2 motion-safe:animate-pulse bg-disputed" />
        {claimWord("kicker")}
      </p>
      <h2
        id="mine-challenged-heading"
        className="mt-4 max-w-[26ch] font-display text-[clamp(1.6rem,3.2vw,2.6rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]"
      >
        {t("heading", { count: rows.length })}
      </h2>

      <ol className="mt-8 border-t border-line">
        {rows.map((row, index) => (
          <motion.li
            key={row.passportId}
            data-challenged={row.passportId}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: 0.6, delay: Math.min(index, 4) * 0.06, ease: [0.16, 1, 0.3, 1] }}
            className="grid gap-8 border-b border-line py-9 lg:grid-cols-[minmax(0,0.34fr)_minmax(0,1fr)] lg:gap-12"
          >
            <Link href={`/passport/${row.passportId}`} className="group block min-w-0">
              <div className="grain relative aspect-[4/3] overflow-hidden border border-line bg-bg-sunken">
                {row.imageUrl === undefined ? (
                  <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                    {studio("passports.noThumbnail")}
                  </span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- the pinned thumbnail, drawn as the grids under it draw theirs
                  <img
                    src={row.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                )}
                <div className="scrim pointer-events-none absolute inset-0" />
              </div>
              <p className="mt-4 truncate text-sm text-text transition-colors duration-200 group-hover:text-accent">
                {row.title ?? studio("passports.untitled")}
              </p>
              <p className="mt-1.5 font-mono text-[11px] text-text-faint">{shortHex(row.passportId, 10, 8)}</p>
              <p className="mt-1 font-mono text-[11px] text-text-faint">
                {t("opened", { date: format.dateTime(new Date(row.openedAt * 1000), { dateStyle: "medium" }) })}
              </p>
            </Link>

            <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] xl:gap-10">
              {row.reason === null ? null : (
                <figure data-claim className="min-w-0">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{claimWord("reason")}</p>
                  <blockquote className="mt-2.5 whitespace-pre-line break-words text-base leading-relaxed text-text">
                    {row.reason}
                  </blockquote>
                </figure>
              )}
              <div className={`min-w-0 ${row.reason === null ? "xl:col-span-2" : "xl:border-s xl:border-line xl:ps-10"}`}>
                {row.answer.kind === "waiting" ? (
                  <HolderAnswer
                    passportId={row.passportId}
                    dispute={{ challenger: row.challenger, openedAt: row.openedAt }}
                    until={row.answer.until}
                    fallback={<AnswerShown standing={row.answer} />}
                  />
                ) : (
                  <AnswerShown standing={row.answer} />
                )}
              </div>
            </div>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}
