"use client";

import { MotionConfig, motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, type ReactNode } from "react";
import { formatEther, type Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { Link, useRouter } from "@/lib/i18n/routing";
import type { OpenDispute } from "@/lib/disputes/queue";
import { useResolveDisputes, type ResolveDisputes } from "@/lib/disputes/useResolveDisputes";
import { refreshPassport } from "@/lib/passport/refresh";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import { Mono } from "@/components/passport/Mono";
import { IndexRetry } from "@/components/IndexRetry";
import { FailureDetails } from "@/components/studio/FailureDetails";
import { WarningMark } from "@/components/WarningMark";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import { isPrivyConfigured } from "@/lib/env";

const NOTHING = () => undefined;
const NOTHING_YET = async () => undefined;

/** The desk before the wallet SDK is in the tree: what the hook itself answers until Privy is up. */
const WAITING: ResolveDisputes = {
  ready: false,
  authenticated: false,
  wallet: undefined,
  isResolver: false,
  credit: null,
  busy: null,
  confirming: false,
  settled: {},
  failure: null,
  withdrawing: false,
  withdrawn: false,
  actions: { settle: NOTHING_YET, withdraw: NOTHING_YET, recheck: NOTHING_YET, signIn: NOTHING },
};

/**
 * The resolver's desk: every challenge still waiting, and the two buttons that
 * end one.
 *
 * Anyone may read this page, because who settles disputes and what is waiting
 * on them is not a secret. Only the address the policy names sees the buttons,
 * since the registry refuses everybody else and a button that always reverts
 * would be a lie.
 *
 * The hook waits for the wallet's own provider. Privy's hooks warn into the
 * console on every render that happens without it, so until it is up the queue
 * is drawn from the same standing the hook would report: nothing read yet.
 */
export function ResolveConsole({
  resolver,
  disputes,
  listError = null,
}: {
  resolver: Hex;
  disputes: OpenDispute[];
  /** Why the index would not give the open disputes, or null when it did. */
  listError?: string | null;
}) {
  const mounted = useWalletMounted();

  return mounted ? (
    <Console resolver={resolver} disputes={disputes} listError={listError} />
  ) : (
    <Desk desk={WAITING} resolver={resolver} disputes={disputes} listError={listError} />
  );
}

function Console({
  resolver,
  disputes,
  listError,
}: {
  resolver: Hex;
  disputes: OpenDispute[];
  listError: string | null;
}) {
  const router = useRouter();
  // Which passport the settle that is out belongs to. The hook reports the busy
  // one and sets it before the wallet is even asked, so by the time a settle
  // lands this is the record whose page has to be dropped.
  const settling = useRef<Hex | null>(null);
  // The queue above is rendered on the server from the index and the chain, so a
  // settled dispute asks the page to read itself again rather than being patched
  // here. That passport's own page is held for a minute, and it is what the
  // resolver looks at next, so it is dropped before the re-read.
  const desk = useResolveDisputes({
    resolver,
    onSettled: async () => {
      await refreshPassport(settling.current ?? "");
      router.refresh();
    },
  });

  // The hook reports the busy passport for as long as the write is out, which
  // is from before the wallet is asked until after it lands.
  useEffect(() => {
    if (desk.busy !== null) {
      settling.current = desk.busy;
    }
  }, [desk.busy]);

  return <Desk desk={desk} resolver={resolver} disputes={disputes} listError={listError} />;
}

function Desk({
  desk,
  resolver,
  disputes,
  listError,
}: {
  desk: ResolveDisputes;
  resolver: Hex;
  disputes: OpenDispute[];
  listError: string | null;
}) {
  const t = useTranslations("resolve");

  // The two cards start just under the page's short opening, inside the first
  // screen of a laptop. "Nothing is waiting" is only said after the index
  // answered: under a failed read it would contradict the line above it.
  // MotionConfig carries a reader's ask for less motion to every Framer
  // animation on the desk, the failure line included, which the site's CSS rule
  // cannot reach.
  return (
    <MotionConfig reducedMotion="user">
      <div data-resolve-desk className="mt-7 sm:mt-8">
        <Standing desk={desk} resolver={resolver} />

        {listError !== null ? (
          <div data-queue-unread className="mt-14 max-w-[58ch] border-t border-line pt-10">
            <p className="flex items-start gap-2.5 text-base leading-relaxed text-failed">
              <WarningMark className="mt-[3px]" />
              <span className="min-w-0">{t("unavailable")}</span>
            </p>
            <FailureDetails reason={listError} className="ms-[24px] mt-2" />
            <IndexRetry said={listError} />
          </div>
        ) : disputes.length === 0 ? (
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
    </MotionConfig>
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
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      role={pending ? "status" : "alert"}
      data-tone={pending ? "pending" : "failed"}
      className={`mt-10 max-w-[54ch] border-s-2 py-3 ps-4 text-base leading-relaxed ${
        pending ? "border-text-muted bg-text-muted/5 text-text-muted" : "border-failed bg-failed/10 text-failed"
      }`}
    >
      <span className="flex items-start gap-2.5">
        {pending ? null : <WarningMark className="mt-[3px]" />}
        <span className="min-w-0">{t(`failure.${key}`)}</span>
      </span>
      {failure.reason === undefined ? null : (
        <span className="mt-2 block break-words font-mono text-[11px] text-text-faint">{failure.reason}</span>
      )}

      {failure.address === undefined ? null : (
        <a
          href={`${MONAD_EXPLORER}/address/${failure.address}`}
          target="_blank"
          rel="noreferrer"
          className="mt-4 block font-mono text-[11px] text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
        >
          {withHex(t("actions.openAddress", { wallet: HEX_MARK }), shortHex(failure.address))}
        </a>
      )}

      {/* A write that is out is never sent again from here. The only offer is
          another look at what Monad holds. */}
      {failure.next !== "recheck" ? null : (
        <button
          type="button"
          onClick={() => void desk.actions.recheck()}
          className="mt-4 block rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t("actions.recheck")}
        </button>
      )}
    </motion.div>
  );
}

/**
 * Stands in for an address inside a translated sentence, so the address is drawn
 * in its own normal-case span whatever case the words around it are set in. A
 * private-use character, so no language's sentence contains it.
 */
const HEX_MARK = "\uE000";

function withHex(sentence: string, hex: string): ReactNode {
  const [before, after = ""] = sentence.split(HEX_MARK);
  return (
    <>
      {before}
      <span data-hex className="normal-case">
        {hex}
      </span>
      {after}
    </>
  );
}

/** Whether a write from this desk is out and unconfirmed, which locks every button that could repeat it. */
function pendingWrite(desk: ResolveDisputes): boolean {
  return desk.failure !== null && desk.failure.key === "confirmPending";
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
          <Mono value={resolver} className="text-base normal-case" />
        </a>
        <p className="mt-4 max-w-[46ch] text-base leading-relaxed text-text-muted">{t("policyNote")}</p>

        {!desk.ready ? (
          // The sign-in block holds its place, unseen and inert, until the
          // wallet says who is here. The desk sits in the first screen, and
          // most readers are signed out, so for them nothing under it moves.
          isPrivyConfigured ? (
            <div data-sign-in-held aria-hidden className="invisible mt-5">
              <p className="max-w-[46ch] text-base leading-relaxed">{t("signedOut")}</p>
              <button type="button" disabled tabIndex={-1} className="mt-4 rounded-[8px] border px-5 py-3 text-[11px] uppercase tracking-[0.18em]">
                {t("signIn")}
              </button>
            </div>
          ) : null
        ) : desk.isResolver ? (
          <p className="mt-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-verified">
            <span aria-hidden className="h-2 w-2 bg-verified" />
            {t("youAre")}
          </p>
        ) : desk.authenticated ? (
          <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-text-muted">
            {t("stranger")}{" "}
            <span className="text-text-faint">
              {withHex(t("strangerBody", { wallet: HEX_MARK }), desk.wallet === undefined ? "" : shortHex(desk.wallet))}
            </span>
          </p>
        ) : (
          <div className="mt-5">
            <p className="max-w-[46ch] text-base leading-relaxed text-text-muted">{t("signedOut")}</p>
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
        {/* Until the registry has been asked there is no figure, and a status
            is said as a status: small, in the label's ink. The headline slot is
            kept for the amount itself once it is read. */}
        {owed === null ? (
          <p data-credit-unread className="mt-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
            <span aria-hidden className="h-1.5 w-1.5 bg-line-strong" />
            {t("creditUnread")}
          </p>
        ) : (
          <p
            data-credit-amount
            className="mt-2 font-display text-[clamp(1.8rem,4vw,3rem)] font-semibold leading-[0.95] tracking-[-0.04em] tabular-nums"
          >
            {t("mon", { amount: formatEther(owed) })}
          </p>
        )}
        <p className="mt-4 max-w-[46ch] text-base leading-relaxed text-text-muted">{t("creditBody")}</p>

        {owed !== null && owed > 0n && desk.authenticated ? (
          <button
            type="button"
            onClick={() => void desk.actions.withdraw()}
            disabled={desk.withdrawing || pendingWrite(desk)}
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
  // One unconfirmed write locks every settle button on the page, its own row and
  // the others: nothing is sent again while Monad may already hold it.
  const locked = desk.busy !== null || pendingWrite(desk) || outcome !== undefined;

  const seal = (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
      <span className="motif h-6 w-6 opacity-70" />
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("noPicture")}</span>
    </span>
  );

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
            seal
          ) : (
            <>
              {/* The pinned picture the challenge is about, through the same
                  optimizer and gateway list as every other plate, so a gateway
                  miss leaves the seal rather than a broken image. */}
              <Picture
                sources={pictureSources(dispute.thumbnailUrl)}
                alt=""
                sizes="(min-width: 1024px) 26vw, 80vw"
                className="object-cover"
                fallback={seal}
              />
              {/* Nothing is written over the thumbnail, so light, where the
                  scrim is cream, draws none and the picture reads as it is. */}
              <span data-scrim="dark" className="scrim pointer-events-none absolute inset-0 [.light_&]:hidden" />
            </>
          )}
        </div>
      </div>

      <div className="min-w-0">
        {/* The resolver recognises a dispute by its picture, so the title leads
            and the id is only there to tell two same-named pictures apart. The
            full id is one click away on the passport itself. */}
        <Link data-dispute-head href={`/passport/${dispute.passportId}`} className="group block min-w-0">
          {dispute.title === null ? null : (
            <span className="block max-w-[32ch] font-display text-[clamp(1.2rem,2.2vw,1.7rem)] leading-[1.08] tracking-[-0.03em] transition-colors duration-200 group-hover:text-accent">
              {dispute.title}
            </span>
          )}
          <span
            className={`flex flex-wrap items-baseline gap-x-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint ${
              dispute.title === null ? "" : "mt-2.5"
            }`}
          >
            <span>{t("passport")}</span>
            <span data-hex className="text-sm normal-case tracking-normal transition-colors duration-200 group-hover:text-accent">
              {shortHex(dispute.passportId)}
            </span>
          </span>
        </Link>

        {dispute.reason === null ? (
          <p className="mt-6 max-w-[54ch] text-base leading-relaxed text-text-faint">
            {dispute.verified ? t("noReason", { uri: dispute.evidenceURI ?? "" }) : t("unverified")}
          </p>
        ) : (
          <figure className="mt-6 max-w-[58ch] border-s-2 border-disputed ps-5">
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
                <span data-hex className="normal-case">
                  {shortHex(dispute.challenger)}
                </span>
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
              {format.dateTime(new Date(dispute.openedAt * 1000), "moment")}
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
                className="rounded-[8px] bg-disputed px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-bg transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
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
            <p className="mt-4 max-w-[54ch] text-base leading-relaxed text-text-faint">
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
