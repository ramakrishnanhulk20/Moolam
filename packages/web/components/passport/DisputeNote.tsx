import { getFormatter, getTranslations } from "next-intl/server";
import { formatEther } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { DisputeStatus, type Dispute } from "@/lib/chain/registry";

const STATUS_NAMES: Record<number, string> = {
  [DisputeStatus.Open]: "open",
  [DisputeStatus.Upheld]: "upheld",
  [DisputeStatus.Rejected]: "rejected",
};

/**
 * A challenge against this passport, with the bond behind it.
 *
 * Only shown when there is one: a passport nobody has challenged says nothing
 * here rather than printing an empty dispute box, which would read like an
 * accusation on every page.
 */
export async function DisputeNote({ dispute, locale }: { dispute: Dispute; locale: string }) {
  const t = await getTranslations("passport.dispute");
  const format = await getFormatter({ locale });
  const status = STATUS_NAMES[dispute.status] ?? "open";

  return (
    <section className="border-s-2 border-failed bg-failed/5 p-6 sm:p-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-failed">{t("kicker")}</p>
      <h2 className="mt-4 max-w-[24ch] font-display text-[clamp(1.3rem,2.4vw,1.9rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
        {t(`status.${status}`)}
      </h2>
      <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-text-muted">{t("body")}</p>

      <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("challenger")}</dt>
          <dd className="mt-1.5 break-all font-mono text-sm">
            <a
              href={`${MONAD_EXPLORER}/address/${dispute.challenger}`}
              target="_blank"
              rel="noreferrer"
              className="transition-colors duration-200 hover:text-accent"
            >
              {shortHex(dispute.challenger)}
            </a>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("bond")}</dt>
          <dd className="mt-1.5 font-mono text-sm">{t("mon", { amount: formatEther(dispute.bond) })}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("openedAt")}</dt>
          <dd className="mt-1.5 font-mono text-sm">
            {format.dateTime(new Date(Number(dispute.openedAt) * 1000), { dateStyle: "medium", timeStyle: "short" })}
          </dd>
        </div>
      </dl>

      <p className="mt-6 break-all font-mono text-[11px] text-text-faint">
        {t("evidence")} {dispute.evidenceHash}
      </p>
    </section>
  );
}
