import { useFormatter, useTranslations } from "next-intl";
import type { Hex } from "viem";
import { MONAD_EXPLORER, addresses, shortHex } from "@/lib/chain/client";
import type { ConsentEntry, ConsentReading } from "@/lib/chain/consent";
import { NOTHING_STATED, constrainedUses } from "@/lib/chain/consent";
import { ConsentPanel } from "@/components/passport/ConsentPanel";
import { ConsentHistory } from "./History";
import { ConsentLedger } from "./ConsentLedger";
import { ledgerEntry } from "./ledger";
import { UseRows } from "./UseRows";

/**
 * What the holder of this picture has said about AI use, and what they had said
 * before.
 *
 * A file can carry a line saying its creator refuses AI training, and anyone
 * can strip that line out on the way past. This is the same statement read from
 * a register on Monad, where the holder is the only address that can write it
 * and nobody can take it back out.
 *
 * The rule at the top is the whole life of the passport and answers the one
 * question a label in a file never can: what was allowed on the day a picture
 * was used. Everything under it is the statement that stands today, rendered on
 * the server from the same held reads as the rest of the page.
 */
export interface ConsentRecord {
  reading: ConsentReading;
  history: ConsentEntry[];
  /** The vocabulary, read from the contract rather than written into the page. */
  standard: string;
  /** How long the register makes the same wallet wait before it writes again, in seconds. */
  minInterval: number;
  /** The chain's own clock when this page rendered, in whole seconds. */
  now: number;
}

export function ConsentSection({
  id,
  owner,
  registeredAt,
  record,
}: {
  id: Hex;
  /** Who the registry says holds this passport, so the control knows whose it is. */
  owner: Hex | null;
  /** When the picture was registered, in whole seconds. */
  registeredAt: number;
  /** Null when the register could not be read, which is said out loud rather than drawn as silence. */
  record: ConsentRecord | null;
}) {
  const t = useTranslations("passport.consent");
  const format = useFormatter();

  if (record === null) {
    return (
      <section data-consent className="border-y border-line bg-bg">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-14 sm:px-8 sm:py-20">
          <p className="rise font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("kicker")}</p>
          <h2 className="rise mt-6 max-w-[15ch] font-display text-[clamp(1.8rem,4vw,3.2rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
            {t("heading")}
          </h2>
          <p className="rise mt-6 max-w-[52ch] border-s-2 border-line ps-5 text-sm leading-relaxed text-text-muted">
            {t("unavailable")}
          </p>
        </div>
      </section>
    );
  }

  const { reading, history, standard, minInterval, now } = record;
  const entry = reading.entry;
  const consent = entry?.consent ?? NOTHING_STATED;
  const conditions = entry !== null && entry.constraintInfo.length > 0 ? entry.constraintInfo : null;
  const conditional = constrainedUses(consent);

  return (
    <section data-consent className="border-y border-line bg-bg">
      <div className="mx-auto w-full max-w-[1400px] px-5 py-14 sm:px-8 sm:py-20">
        <div className="rise flex flex-wrap items-baseline justify-between gap-x-10 gap-y-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("kicker")}</p>
          <a
            href={`${MONAD_EXPLORER}/address/${addresses.consent}`}
            target="_blank"
            rel="noreferrer"
            className="tap font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:text-accent"
          >
            {standard}
          </a>
        </div>

        <div className="rise mt-6 grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
          <h2 className="max-w-[15ch] font-display text-[clamp(1.8rem,4vw,3.2rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
            {t("heading")}
          </h2>
          <p className="max-w-[54ch] text-sm leading-relaxed text-text-muted lg:mt-3">{t("lede")}</p>
        </div>

        <ConsentLedger
          id={id}
          registeredAt={registeredAt}
          now={now}
          entries={history.map(ledgerEntry)}
          standing={{
            stated: reading.stated,
            entry: entry === null ? null : ledgerEntry(entry),
          }}
          className="rise mt-14 border-t border-line pt-10"
        />

        {/* The rows and the history hang off the rule rather than sitting in a
            box of their own, and the second column starts lower than the
            first, so the block reads as one record and not as two cards. */}
        <div className="mt-20 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
          <div className="rise min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("fourUses")}</p>
            <p className="mt-3 max-w-[40ch] text-xs leading-relaxed text-text-faint">{t("fourUsesNote")}</p>
            <UseRows consent={consent} className="mt-5" />
          </div>

          <div className="rise min-w-0 lg:mt-12" style={{ animationDelay: "90ms" }}>
            {entry === null ? (
              <div className="max-w-[52ch] border-s-2 border-line ps-5">
                <p className="text-sm leading-relaxed text-text-muted">{t("empty.body")}</p>
                <p className="mt-4 text-sm leading-relaxed text-text-faint">{t("empty.holder")}</p>
              </div>
            ) : (
              <>
                {conditions === null ? null : (
                  <div className="border-s-2 border-accent/50 ps-5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {t("conditionsLabel")}
                    </p>
                    <p className="mt-2.5 max-w-[56ch] break-words text-base leading-relaxed text-text">{conditions}</p>
                    {conditional.length === 0 ? null : (
                      <p className="mt-2.5 max-w-[56ch] text-xs leading-relaxed text-text-faint">
                        {t("conditionsApplyTo", {
                          uses: conditional.map((field) => t(`uses.${field}`)).join(", "),
                        })}
                      </p>
                    )}
                  </div>
                )}

                <dl
                  className={`grid gap-x-8 gap-y-5 border-t border-line pt-6 sm:grid-cols-2 ${
                    conditions === null ? "" : "mt-10"
                  }`}
                >
                  <Field
                    label={t("statedBy")}
                    value={shortHex(entry.writer)}
                    href={`${MONAD_EXPLORER}/address/${entry.writer}`}
                  />
                  <Field
                    label={t("writtenLabel")}
                    value={format.dateTime(new Date(Number(entry.at) * 1000), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  />
                </dl>
              </>
            )}
          </div>
        </div>

        <div className="mt-20 grid gap-8 border-t border-line pt-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-20">
          <p className="rise font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">
            {t("historyCount", { count: history.length })}
          </p>
          <ConsentHistory entries={history} className="rise" />
        </div>

        {/* Only the wallet that holds this passport ever sees anything here. The
            statement goes down as whole numbers: a bigint cannot cross into a
            browser component at all. */}
        <ConsentPanel
          passportId={id}
          owner={owner}
          standing={{ stated: reading.stated, entry: entry === null ? null : ledgerEntry(entry) }}
          minInterval={minInterval}
        />
      </div>
    </section>
  );
}

function Field({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="tap-row mt-1.5 break-all font-mono text-sm">
        {href === undefined ? (
          value
        ) : (
          <a href={href} target="_blank" rel="noreferrer" className="transition-colors duration-200 hover:text-accent">
            {value}
          </a>
        )}
      </dd>
    </div>
  );
}
