"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { formatEther, type Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { Link, useRouter } from "@/lib/i18n/routing";
import type { OpenDispute } from "@/lib/disputes/queue";
import { useResolveDisputes, type ResolveDisputes } from "@/lib/disputes/useResolveDisputes";
import { Mono } from "@/components/passport/Mono";

/**
 * The resolver's desk: every challenge still waiting, and the two buttons that
 * end one.
 *
 * Anyone may read this page, because who settles disputes and what is waiting
 * on them is not a secret. Only the address the policy names sees the buttons,
 * since the registry refuses everybody else and a button that always reverts
 * would be a lie.
 */
export function ResolveConsole({ resolver, disputes }: { resolver: Hex; disputes: OpenDispute[] }) {
  const t = useTranslations("resolve");
  const router = useRouter();
  // The queue above is rendered on the server from the index and the chain, so a
  // settled dispute asks the page to read itself again rather than being patched here.
  const desk = useResolveDisputes({ resolver, onSettled: () => router.refresh() });

  return (
    <div className="mt-14">
      <Standing desk={desk} resolver={resolver} />

      {disputes.length === 0 ? (
        <p className="mt-14 max-w-[46ch] border-t border-line pt-10 font-display text-[clamp(1.4rem,3vw,2.4rem)] leading-[1.06] tracking-[-0.03em] text-text-muted">
          {t("empty")}
        </p>
      ) : (
        <ol className="mt-14 border-t border-line">
          {disputes.map((dispute, index) => (
            <Row key={dispute.passportId} dispute={dispute} index={index} desk={desk} />
          ))}
        </ol>
      )}

      {desk.failure === null ? null : <FailureLine desk={desk} />}
    </div>
  );
}

/** The one thing that went wrong, wherever on this page it happened. */
function FailureLine({ desk }: { desk: ResolveDisputes }) {
  const t = useTranslations("resolve");
  const failure = desk.failure;
  if (failure === null) {
    return null;
  }

  // A send that is still out is not a send that failed, so it keeps the muted ink
  // and the status role rather than the alarm.
  const pending = failure.key === "confirmPending";
  const key = t.has(`failure.${failure.key}`) ? failure.key : "unknown";

  return (
    <motion.p
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      role={pending ? "status" : "alert"}
      data-tone={pending ? "pending" : "failed"}
      className={`mt-10 max-w-[58ch] border-s-2 py-3 ps-4 text-sm leading-relaxed ${
        pending ? "border-text-muted bg-text-muted/5 text-text-muted" : "border-failed bg-failed/10 text-failed"
      }`}
    >
      {t(`failure.${key}`)}
      {failure.reason === undefined ? null : (
        <span className="mt-2 block break-words font-mono text-[11px] text-text-faint">{failure.reason}</span>
      )}
    </motion.p>
  );
}

/** Who the policy trusts, who is signed in, and what the registry owes them. */
function Standing({ desk, resolver }: { desk: ResolveDisputes; resolver: Hex }) {
  const t = useTranslations("resolve");
  const owed = desk.credit;

  return (
    <section className="grid gap-10 border-s-2 border-accent bg-bg-raised p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-16">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("resolverLabel")}</p>
        <a
          href={`${MONAD_EXPLORER}/address/${resolver}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block min-w-0 transition-colors duration-200 hover:text-accent"
        >
          <Mono value={resolver} className="text-base" />
        </a>
        <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("policyNote")}</p>

        {!desk.ready ? null : desk.isResolver ? (
          <p className="mt-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-verified">
            <span aria-hidden className="h-2 w-2 bg-verified" />
            {t("youAre")}
          </p>
        ) : desk.authenticated ? (
          <p className="mt-5 max-w-[46ch] text-sm leading-relaxed text-text-muted">
            {t("stranger")}{" "}
            <span className="text-text-faint">
              {t("strangerBody", { wallet: desk.wallet === undefined ? "" : shortHex(desk.wallet) })}
            </span>
          </p>
        ) : (
          <div className="mt-5">
            <p className="max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("signedOut")}</p>
            <button
              type="button"
              onClick={desk.actions.signIn}
              className="mt-4 rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("signIn")}
            </button>
          </div>
        )}
      </div>

      <div className="lg:border-s lg:border-line lg:ps-12">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("creditLabel")}</p>
        <p className="mt-2 font-display text-[clamp(1.8rem,4vw,3rem)] font-semibold leading-[0.95] tracking-[-0.04em] tabular-nums">
          {owed === null ? t("creditUnread") : t("mon", { amount: formatEther(owed) })}
        </p>
        <p className="mt-4 max-w-[40ch] text-sm leading-relaxed text-text-muted">{t("creditBody")}</p>

        {owed !== null && owed > 0n && desk.authenticated ? (
          <button
            type="button"
            onClick={() => void desk.actions.withdraw()}
            disabled={desk.withdrawing}
            className="mt-6 rounded-[8px] bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60"
          >
            {desk.withdrawing ? t("withdrawing") : t("withdraw", { amount: formatEther(owed) })}
          </button>
        ) : null}

        {desk.withdrawn ? (
          <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-verified">{t("withdrawn")}</p>
        ) : null}
      </div>
    </section>
  );
}

function Row({ dispute, index, desk }: { dispute: OpenDispute; index: number; desk: ResolveDisputes }) {
  const t = useTranslations("resolve");
  const format = useFormatter();
  const calm = useReducedMotion() === true;

  const outcome = desk.settled[dispute.passportId.toLowerCase()];
  const busy = desk.busy !== null && desk.busy.toLowerCase() === dispute.passportId.toLowerCase();
  const locked = desk.busy !== null || outcome !== undefined;

  return (
    <motion.li
      initial={calm ? false : { opacity: 0, y: 28 }}
      whileInView={calm ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, delay: Math.min(index, 4) * 0.06, ease: [0.16, 1, 0.3, 1] }}
      className="grid gap-8 border-b border-line py-10 lg:grid-cols-[minmax(0,0.42fr)_minmax(0,1fr)] lg:gap-14"
    >
      <div className="flex items-start gap-5">
        <span className="font-mono text-[11px] tabular-nums text-text-faint">{String(index + 1).padStart(2, "0")}</span>
        <div className="grain relative aspect-[4/3] w-full overflow-hidden border border-line bg-bg-raised">
          {dispute.thumbnailUrl === null ? (
            <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
              {t("noPicture")}
            </span>
          ) : (
            <>
              {/* The pinned picture the challenge is about, read through the gateway. */}
              <img src={dispute.thumbnailUrl} alt="" className="h-full w-full object-cover" />
              <span className="scrim pointer-events-none absolute inset-0" />
            </>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("passport")}</p>
        <Link
          href={`/passport/${dispute.passportId}`}
          className="mt-1.5 block min-w-0 transition-colors duration-200 hover:text-accent"
        >
          <Mono value={dispute.passportId} className="text-sm" />
        </Link>
        {dispute.title === null ? null : (
          <p className="mt-3 max-w-[32ch] font-display text-[clamp(1.2rem,2.2vw,1.7rem)] leading-[1.08] tracking-[-0.03em]">
            {dispute.title}
          </p>
        )}

        {dispute.reason === null ? (
          <p className="mt-6 max-w-[54ch] text-sm leading-relaxed text-text-faint">
            {dispute.verified ? t("noReason", { uri: dispute.evidenceURI ?? "" }) : t("unverified")}
          </p>
        ) : (
          <figure className="mt-6 max-w-[58ch] border-s-2 border-failed ps-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("claim")}</p>
            <blockquote className="mt-2.5 text-base leading-relaxed text-text">{dispute.reason}</blockquote>
          </figure>
        )}

        <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("challenger")}</dt>
            <dd className="mt-1.5 font-mono text-sm">
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
            <dd className="mt-1.5 font-mono text-sm tabular-nums">
              {t("mon", { amount: formatEther(BigInt(dispute.bond)) })}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("openedAt")}</dt>
            <dd className="mt-1.5 font-mono text-sm">
              {format.dateTime(new Date(dispute.openedAt * 1000), { dateStyle: "medium", timeStyle: "short" })}
            </dd>
          </div>
        </dl>

        {outcome !== undefined ? (
          <p className="mt-7 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-verified">
            <span aria-hidden className="h-2 w-2 bg-verified" />
            {t(outcome === "upheld" ? "settledUpheld" : "settledRejected")}
          </p>
        ) : desk.isResolver ? (
          <div className="mt-7">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void desk.actions.settle(dispute.passportId, true)}
                disabled={locked}
                className="rounded-[8px] bg-failed px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-bg transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
              >
                {t("uphold")}
              </button>
              <button
                type="button"
                onClick={() => void desk.actions.settle(dispute.passportId, false)}
                disabled={locked}
                className="rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {t("reject")}
              </button>
            </div>
            <p className="mt-4 max-w-[54ch] text-xs leading-relaxed text-text-faint">
              {t("upholdWhat")} {t("rejectWhat")}
            </p>

            {busy ? (
              <p className="mt-4 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                <span aria-hidden className="inline-block h-2 w-2 animate-pulse bg-accent" />
                {desk.confirming ? t("watching") : t("sending")}
              </p>
            ) : null}
          </div>
        ) : null}

      </div>
    </motion.li>
  );
}
