"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import type { Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { useRouter } from "@/lib/i18n/routing";
import { refreshPassport } from "@/lib/passport/refresh";
import type { RecheckState } from "@/lib/recheck/state";
import { useRecheckRequest, type RecheckControl } from "@/lib/recheck/useRecheck";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Ask for a second opinion, from either screen that shows one.
 *
 * Everywhere else in this app, a control that writes something needs a wallet,
 * an account and gas. This one needs none of them: the press puts a line in the
 * verify service's queue, and the Chainlink workflow that answers it runs on a
 * machine of its own and pays for itself. So the button is offered to everyone
 * who can see the record, including a stranger who has never signed in, and it
 * says so.
 *
 * Nothing here moves when the state changes. The row that holds the button, and
 * the line that says where the request stands, both keep their height whatever
 * is in them, because this control sits in the middle of a page somebody is
 * reading.
 */
export function RecheckRequest({
  passportId,
  className = "",
}: {
  /**
   * The passport to ask about. The verify card knows it from the answer it is
   * drawing; on the passport page the id is the route's own segment, so it is
   * read from there rather than threaded through a section that has no other
   * use for it.
   */
  passportId?: Hex;
  className?: string;
}) {
  const params = useParams();
  const fromRoute = typeof params?.id === "string" && ID_PATTERN.test(params.id) ? (params.id as Hex) : undefined;
  const id = passportId ?? fromRoute;

  if (id === undefined) {
    return null;
  }

  // Keyed by the passport, so a card that answers about a second picture draws
  // a control with a state of its own rather than one still showing where the
  // last passport sat in the queue.
  return <Control key={id} passportId={id} className={className} />;
}

function Control({ passportId, className }: { passportId: Hex; className: string }) {
  const t = useTranslations("recheck");
  const calm = useReducedMotion() === true;
  const router = useRouter();

  // A verdict that has just been written is on chain, and every screen above
  // this one was rendered before it existed. What the site holds about this
  // passport goes first, then the page is asked to read itself again, so the
  // new re-check appears where the reader is standing instead of after a reload.
  const recheck = useRecheckRequest({
    passportId,
    onDone: async () => {
      await refreshPassport(passportId);
      router.refresh();
    },
  });

  const { state } = recheck;
  const press = pressFor(recheck);

  return (
    <motion.div
      initial={calm ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      data-recheck
      data-recheck-state={state.kind}
      className={`max-w-[54ch] ${className}`}
    >
      {/* The row keeps its height whether it holds a button, a stamp, or both,
          so a request that lands while the reader is looking does not lift the
          page under their eyes. */}
      <div className="flex min-h-[2.75rem] flex-wrap items-center gap-x-5 gap-y-3">
        <Stamp state={state} calm={calm} />

        {press === null ? null : (
          <button
            type="button"
            onClick={press.act}
            disabled={press.busy}
            className="tap rounded-[8px] border border-line-strong px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:cursor-wait disabled:border-line disabled:text-text-faint"
          >
            {t(press.label)}
          </button>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-text-faint">{t("note")}</p>

      {/* Room for the longest sentence any state has, kept whether one is
          showing or not. */}
      <div className="mt-3 min-h-[4.25rem] sm:min-h-[3rem]">
        <AnimatePresence mode="wait" initial={false}>
          <Sentence key={state.kind} state={state} spent={recheck.spent} calm={calm} />
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/** The state in one mono word, the way every other standing on these pages is stamped. */
function Stamp({ state, calm }: { state: RecheckState; calm: boolean }) {
  const t = useTranslations("recheck");
  const stamp = stampFor(state);
  if (stamp === null) {
    return null;
  }

  return (
    <p className={`flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.22em] ${stamp.tone}`}>
      <span
        aria-hidden
        className={`h-[7px] w-[7px] ${stamp.mark} ${stamp.moving && !calm ? "animate-pulse" : ""}`}
      />
      {t(stamp.key)}
    </p>
  );
}

function Sentence({ state, spent, calm }: { state: RecheckState; spent: boolean; calm: boolean }) {
  const t = useTranslations("recheck");
  const format = useFormatter();

  const when = (at?: number): string =>
    at === undefined || at === 0 ? "" : format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "short" });

  const body = ((): React.ReactNode => {
    switch (state.kind) {
      case "none":
        return null;
      case "sending":
        return t("sending");
      case "queued": {
        const at = when(state.requestedAt);
        if (state.position === undefined) {
          return t(state.already ? "alreadyWaiting" : "queuedWaiting", { at });
        }
        return t(state.already ? "already" : "queued", { at, position: state.position });
      }
      case "running":
        return t("running");
      case "done":
        return (
          <>
            {state.finishedAt === undefined ? t("doneNoTime") : t("done", { at: when(state.finishedAt) })}
            {state.reportTx === undefined ? null : (
              <>
                {" "}
                <a
                  href={`${MONAD_EXPLORER}/tx/${state.reportTx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="tap underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
                >
                  {t("openTx", { hash: shortHex(state.reportTx) })}
                </a>
              </>
            )}
          </>
        );
      case "failed":
        return state.reason === undefined ? t("failedNoReason") : t("failed", { reason: state.reason });
      case "refused":
        return t(`failure.${state.key}`);
    }
  })();

  if (body === null) {
    return null;
  }

  const tone =
    state.kind === "failed" || (state.kind === "refused" && !state.canRetry)
      ? "text-failed"
      : state.kind === "done"
        ? "text-text"
        : "text-text-muted";

  return (
    <motion.div
      initial={calm ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={calm ? { opacity: 0 } : { opacity: 0, y: -6 }}
      transition={{ duration: 0.28, ease: EASE }}
      role="status"
    >
      <p className={`text-sm leading-relaxed ${tone}`}>{body}</p>

      {/* Said only when the control has given up watching, so a reader who left
          the tab open for an afternoon knows why nothing is moving. */}
      {spent ? <p className="mt-2 text-xs leading-relaxed text-text-faint">{t("stopped")}</p> : null}

      {state.kind === "refused" && state.reason !== undefined ? (
        <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-text-faint">{state.reason}</p>
      ) : null}
    </motion.div>
  );
}

/** The one thing worth pressing in each state, or nothing at all. */
function pressFor(recheck: RecheckControl): { label: string; act: () => void; busy: boolean } | null {
  const { state } = recheck;

  if (state.kind === "sending") {
    return { label: "button", act: () => undefined, busy: true };
  }
  if (state.kind === "none") {
    return { label: "button", act: recheck.actions.request, busy: false };
  }
  if (state.kind === "failed") {
    return { label: "again", act: recheck.actions.request, busy: false };
  }
  if (state.kind === "refused") {
    return state.canRetry ? { label: "again", act: recheck.actions.request, busy: false } : null;
  }
  // A request that is still in flight has nothing to press until the control
  // has stopped watching it, and then the only honest offer is to look again.
  if (recheck.spent) {
    return { label: "checkNow", act: recheck.actions.check, busy: recheck.checking };
  }
  return null;
}

function stampFor(state: RecheckState): { key: string; tone: string; mark: string; moving: boolean } | null {
  switch (state.kind) {
    case "none":
      return null;
    case "sending":
      return { key: "stamp.sending", tone: "text-accent", mark: "bg-accent", moving: true };
    case "queued":
      return { key: "stamp.queued", tone: "text-accent", mark: "motif", moving: false };
    case "running":
      return { key: "stamp.running", tone: "text-accent", mark: "bg-accent", moving: true };
    case "done":
      return { key: "stamp.done", tone: "text-verified", mark: "bg-verified", moving: false };
    case "failed":
      return { key: "stamp.failed", tone: "text-failed", mark: "bg-failed", moving: false };
    case "refused":
      return state.canRetry ? null : { key: "stamp.failed", tone: "text-failed", mark: "bg-failed", moving: false };
  }
}
