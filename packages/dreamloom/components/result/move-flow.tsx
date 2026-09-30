"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { LiveDot, OutArrow, Spinner } from "./bits";
import { CheckoutOverlay } from "./checkout-card";
import { connectLink, moolamOrigin } from "./moolam-links";
import { confirmQuestion, moveStep, type MoveState } from "./move-steps";
import { postMove } from "./picture-api";
import { checkout, sendWindow, takeAnswer } from "./window-flow";

const SUN_BUTTON =
  "group inline-flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-center font-display text-[1.05rem] leading-tight font-bold text-balance text-ink sm:px-7 sm:text-lg transition duration-200 hover:-translate-y-0.5 hover:bg-sun focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-sun disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 sm:w-auto";

const GHOST_BUTTON =
  "inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-full border-2 border-white/20 px-5 py-2.5 text-base font-semibold text-white transition duration-200 hover:border-sun hover:text-sun focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sun";

/**
 * "Claim it into my Moolam account": opens Moolam's connect page in the checkout window, opened
 * inside the click, listens for the one message that page sends, closes the window, asks the visitor
 * to confirm the exact address, and only then asks Dreamloom's server to move the passport.
 */
export function MoveFlow({
  id,
  moolamSite,
  ownOrigin,
  onChanged,
}: {
  id: string;
  moolamSite: string;
  ownOrigin: string;
  onChanged: () => void;
}) {
  const [state, dispatch] = useReducer(moveStep, { kind: "idle" });
  const origin = moolamOrigin(moolamSite);
  const listening = state.kind === "waiting" || state.kind === "confirm";
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!listening) return;
    const hear = (event: MessageEvent) => {
      // The address is here, so Moolam's window has done its job; the steps check the message again.
      if (takeAnswer(event, origin, "share", checkout) !== null) dispatch({ type: "message", event, moolamOrigin: origin });
    };
    window.addEventListener("message", hear);
    return () => window.removeEventListener("message", hear);
  }, [listening, origin]);

  useEffect(() => {
    if (state.kind !== "moving" || sent.current === state.address) return;
    sent.current = state.address;
    void postMove(id, state.address).then((answer) => {
      // After a move that went through, the guard stays set until the page reads the moved state,
      // so no re-render in between can send the same move again.
      if (answer.ok) {
        onChanged();
        return;
      }
      sent.current = null;
      dispatch({ type: "refused", words: answer.refusal.words });
      if (answer.refusal.reload) onChanged();
    });
  }, [state, id, onChanged]);

  function start() {
    const link = connectLink(moolamSite, ownOrigin);
    const target = checkout.open();
    dispatch({ type: "opened", link, blocked: sendWindow(target, link) === "blocked" });
  }

  const reopen = useCallback(() => {
    if (state.kind !== "waiting") return;
    dispatch({ type: "opened", link: state.link, blocked: checkout.reopen(state.link) === "blocked" });
  }, [state]);

  const cancel = useCallback(() => {
    checkout.close();
    dispatch({ type: "cancel" });
  }, []);

  return (
    <>
      <MoveFlowView state={state} onStart={start} onReopen={reopen} onConfirm={() => dispatch({ type: "confirm" })} onCancel={cancel} />
      <CheckoutOverlay
        open={state.kind === "waiting"}
        place="share"
        link={state.kind === "waiting" ? state.link : null}
        blocked={state.kind === "waiting" && state.blocked}
        onReopen={reopen}
        onCancel={cancel}
      />
    </>
  );
}

/** What each move step draws. Kept apart from the listener so every step can be drawn and checked on its own. */
export function MoveFlowView({
  state,
  onStart,
  onReopen,
  onConfirm,
  onCancel,
}: {
  state: MoveState;
  onStart: () => void;
  onReopen: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <p className="font-display text-2xl leading-tight font-extrabold tracking-[-0.02em] text-white">
        Want it in your own account?
      </p>
      <p className="mt-2 max-w-[34rem] text-base text-white/70">
        Moolam asks you to share your address with Dreamloom, then Dreamloom moves the passport to it. You check the
        address before anything moves.
      </p>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={state.kind}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="mt-5"
        >
          {(state.kind === "idle" || state.kind === "problem") && (
            <>
              {state.kind === "problem" && (
                <p role="alert" className="mb-4 rounded-2xl border-2 border-[#ff8a9a]/40 bg-[#ff8a9a]/10 px-4 py-3 text-base font-medium text-[#ffc2ca]">
                  {state.words}
                </p>
              )}
              <button type="button" onClick={onStart} className={SUN_BUTTON}>
                Claim it into my Moolam account
                <OutArrow className="size-5" />
              </button>
            </>
          )}

          {state.kind === "waiting" && (
            <div role="status" aria-live="polite">
              <p className="flex items-center gap-3 text-base font-semibold text-white">
                <LiveDot />
                Waiting for you to share your address on Moolam
              </p>
              <p className="mt-2 text-sm text-white/65">
                Moolam&apos;s connect page is open in its own window. Press share there and this page carries on.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" onClick={onReopen} className={`group ${GHOST_BUTTON}`}>
                  Reopen the Moolam window
                  <OutArrow />
                </button>
                <button type="button" onClick={onCancel} className={GHOST_BUTTON}>
                  Not now
                </button>
              </div>
            </div>
          )}

          {state.kind === "confirm" && <MoveConfirm address={state.address} onConfirm={onConfirm} onCancel={onCancel} />}

          {state.kind === "moving" && (
            <p role="status" aria-live="polite" className="flex items-start gap-3 text-base text-white">
              <Spinner />
              <span>
                <span className="font-semibold">Moving the passport to your account.</span>{" "}
                <span className="text-white/70">The move is written on Monad, which can take up to a minute.</span>
              </span>
            </p>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** The one place the move can be started: the exact address, in full, and a press. */
export function MoveConfirm({
  address,
  onConfirm,
  onCancel,
}: {
  address: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="group" aria-label={confirmQuestion(address)} className="rounded-2xl bg-white/[0.07] p-4 ring-1 ring-white/15 sm:p-5">
      <p className="text-lg leading-relaxed font-semibold text-white">
        Move this passport to{" "}
        <span className="mt-1 block">
          <span className="font-mono text-[0.95rem] break-all text-sun sm:text-base">{address}</span>?
        </span>
      </p>
      <p className="mt-2 text-sm text-white/65">
        This is the address Moolam shared. Check it is yours: once it moves, Dreamloom cannot move it back.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <button type="button" onClick={onConfirm} className={SUN_BUTTON}>
          Yes, move it
        </button>
        <button type="button" onClick={onCancel} className={GHOST_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}
