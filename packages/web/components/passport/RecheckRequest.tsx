"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import type { Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { useRouter } from "@/lib/i18n/routing";
import { refreshPassport } from "@/lib/passport/refresh";
import { idleRecheck, type RecheckState } from "@/lib/recheck/state";
import { useRecheckRequest, type RecheckControl } from "@/lib/recheck/useRecheck";
import { WarningMark } from "@/components/WarningMark";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const EASE = [0.16, 1, 0.3, 1] as const;

// The pull that hands the status room back. The phone's room is taller than
// the section's 3.5rem padding there, so only that much is handed back.
export const TUCKED_ROOM = "-mb-[3.5rem] sm:-mb-[3rem]";

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
  sealed = false,
  recheckedOn,
  tuck = false,
}: {
  /**
   * The passport to ask about. The verify card knows it from the answer it is
   * drawing; on the passport page the id is the route's own segment, so it is
   * read from there rather than threaded through a section that has no other
   * use for it.
   */
  passportId?: Hex;
  className?: string;
  /**
   * True on a sealed passport, where the workflow opens Moolam's small private
   * copy rather than fetching a published picture, and the words say so.
   */
  sealed?: boolean;
  /**
   * What the chain holds, from the passport page: the newest re-check's date,
   * or null when there is no re-check on chain. A date puts that date where the
   * button would be (seatOf below). Left out by a screen that does not read the
   * rows, where a finished request still shows as done only after the
   * control's own chain check (lib/recheck/chain.ts).
   */
  recheckedOn?: string | null;
  /**
   * True where the control is the last thing in a section. The room kept for
   * the status sentence then sits inside the section's own bottom padding
   * instead of in front of it, so an idle control leaves no empty band under
   * it and a sentence that arrives still moves nothing below.
   */
  tuck?: boolean;
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
  return <Control key={id} passportId={id} className={className} sealed={sealed} recheckedOn={recheckedOn} tuck={tuck} />;
}

/**
 * What the control's place shows, once the chain has had its say.
 *
 * The queue remembers a finished request for ever, so without this every
 * later visitor read "Done" as if they had just asked. On the passport page a
 * finished request is told by the chain instead: the date of the newest
 * re-check the page holds, or, on a page drawn before that verdict landed, the
 * date the chain confirmed for this request. A done state reaches this screen
 * only once the chain agreed (lib/recheck/state.ts), so it always has a verdict
 * behind it. With no date from either, it is nothing at all and the button
 * again, because a request that left no verdict is not a re-check.
 *
 * A passport page that already holds a verdict, where nobody has asked in this
 * tab, gets its date and no button. The runner closes any request for a
 * picture that already carries a re-check, so a press there could only ever
 * come back refused.
 *
 * `dayOf` writes a chain time in milliseconds the way the page writes its own.
 */
export function seatOf(
  state: RecheckState,
  recheckedOn: string | null | undefined,
  dayOf?: (at: number) => string,
): { state: RecheckState; rechecked?: string } {
  if (recheckedOn === undefined) {
    return { state };
  }
  if (state.kind === "none") {
    return recheckedOn === null ? { state } : { state, rechecked: recheckedOn };
  }
  // The queue remembers a failed request for ever, and the chain's verdict outranks it: the reader
  // gets the date this passport was re-checked, and no button, as if nobody had asked.
  if (state.kind === "failed" && recheckedOn !== null) {
    return { state: idleRecheck, rechecked: recheckedOn };
  }
  if (state.kind !== "done") {
    return { state };
  }
  const rechecked =
    recheckedOn ?? (state.finishedAt === undefined || dayOf === undefined ? undefined : dayOf(state.finishedAt));
  return rechecked === undefined ? { state: idleRecheck } : { state: idleRecheck, rechecked };
}

function Control({
  passportId,
  className,
  sealed,
  recheckedOn,
  tuck,
}: {
  passportId: Hex;
  className: string;
  sealed: boolean;
  recheckedOn?: string | null;
  tuck: boolean;
}) {
  const t = useTranslations("recheck");
  const format = useFormatter();
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

  // The same day style the page writes its own newest re-check in.
  const seat = seatOf(recheck.state, recheckedOn, (at) => format.dateTime(new Date(at), { dateStyle: "medium" }));
  const { state } = seat;
  const press = seat.rechecked === undefined ? pressFor({ ...recheck, state }) : null;

  return (
    <motion.div
      initial={calm ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      data-recheck
      data-recheck-state={seat.rechecked === undefined ? state.kind : "rechecked"}
      className={`max-w-[54ch] ${className}`}
    >
      {/* The row keeps its height whether it holds a button, a stamp, or both,
          so a request that lands while the reader is looking does not lift the
          page under their eyes. */}
      <div className="flex min-h-[2.75rem] flex-wrap items-center gap-x-5 gap-y-3">
        {seat.rechecked === undefined ? (
          <Stamp state={state} calm={calm} />
        ) : (
          <p className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.22em] text-verified">
            <span aria-hidden className="h-[7px] w-[7px] bg-verified" />
            {t("recheckedOn", { date: seat.rechecked })}
          </p>
        )}

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

      {/* The note is the button's promise, so it goes wherever the button does. */}
      {seat.rechecked === undefined ? (
        <p className="mt-3 text-xs leading-relaxed text-text-faint">{t(sealed ? "notePrivate" : "note")}</p>
      ) : null}

      {/* Room for the longest sentence any state has, kept whether one is
          showing or not. Tucked, the same room is handed back below by an
          equal pull, so it lies in the padding of the section it ends. */}
      <div
        data-recheck-room={tuck ? "tucked" : "kept"}
        className={`mt-3 min-h-[4.25rem] sm:min-h-[3rem] ${tuck ? TUCKED_ROOM : ""}`}
      >
        <AnimatePresence mode="wait" initial={false}>
          <Sentence key={state.kind} state={state} spent={recheck.spent} calm={calm} sealed={sealed} />
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
      {stamp.tone === "text-failed" ? (
        <WarningMark className="h-[11px] w-[11px]" />
      ) : (
        <span
          aria-hidden
          className={`h-[7px] w-[7px] ${stamp.mark} ${stamp.moving && !calm ? "animate-pulse" : ""}`}
        />
      )}
      {t(stamp.key)}
    </p>
  );
}

function Sentence({
  state,
  spent,
  calm,
  sealed,
}: {
  state: RecheckState;
  spent: boolean;
  calm: boolean;
  sealed: boolean;
}) {
  const t = useTranslations("recheck");
  const rows = useTranslations("passport.attestations");
  const format = useFormatter();

  const when = (at?: number): string =>
    at === undefined || at === 0 ? "" : format.dateTime(new Date(at), "moment");

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
        return t(sealed ? "runningPrivate" : "running");
      case "confirming":
        return t("confirming");
      case "done":
        // Reached only once the chain agreed, so the date is the chain's. A
        // report transaction is still here only when its receipt was read and
        // confirmed, so it is named the way the page names every verdict's
        // transaction rather than as the queue's claim.
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
                  {rows("openTx", { hash: shortHex(state.reportTx) })}
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
      <p className={`text-sm leading-relaxed ${tone} ${tone === "text-failed" ? "flex items-start gap-2.5" : ""}`}>
        {tone === "text-failed" ? <WarningMark className="mt-[3px]" /> : null}
        {tone === "text-failed" ? <span>{body}</span> : body}
      </p>

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

export function stampFor(state: RecheckState): { key: string; tone: string; mark: string; moving: boolean } | null {
  switch (state.kind) {
    case "none":
      return null;
    case "sending":
      return { key: "stamp.sending", tone: "text-pending", mark: "bg-pending", moving: true };
    case "queued":
      return { key: "stamp.queued", tone: "text-pending", mark: "border border-pending", moving: false };
    case "running":
      return { key: "stamp.running", tone: "text-pending", mark: "bg-pending", moving: true };
    case "confirming":
      return { key: "stamp.pending", tone: "text-pending", mark: "bg-pending", moving: true };
    case "done":
      return { key: "stamp.done", tone: "text-verified", mark: "bg-verified", moving: false };
    case "failed":
      return { key: "stamp.failed", tone: "text-failed", mark: "bg-failed", moving: false };
    case "refused":
      return state.canRetry ? null : { key: "stamp.failed", tone: "text-failed", mark: "bg-failed", moving: false };
  }
}
