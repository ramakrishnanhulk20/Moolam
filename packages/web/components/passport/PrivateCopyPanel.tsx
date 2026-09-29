"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useCallback, useReducer, useRef } from "react";
import type { Hex } from "viem";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import { reason as oneLine } from "@/lib/chain/client";
import { useRouter } from "@/lib/i18n/routing";
import { ownsPassport } from "@/lib/passport/owner";
import { refreshPassport } from "@/lib/passport/refresh";
import { VerifierError, forgetPrivateCopy, type SealedCopyLookup } from "@/lib/verifier/client";
import { WarningMark } from "@/components/WarningMark";

const EASE = [0.16, 1, 0.3, 1] as const;

/** One refusal, in the words the panel prints, and whether signing in is the way out. */
export interface PrivateCopyFailure {
  /** A string under "passport.privateCopy.failure". */
  key: string;
  /** The service's own words, printed under the sentence when they add anything. */
  reason?: string;
  next?: "signIn";
}

export interface PrivateCopyState {
  step: "idle" | "confirming" | "sending" | "done";
  failure: PrivateCopyFailure | null;
}

export type PrivateCopyAction =
  | { type: "ask" }
  | { type: "keep" }
  | { type: "sending" }
  | { type: "done" }
  | { type: "failed"; failure: PrivateCopyFailure };

export const initialPrivateCopyState: PrivateCopyState = { step: "idle", failure: null };

export function privateCopyReducer(state: PrivateCopyState, action: PrivateCopyAction): PrivateCopyState {
  switch (action.type) {
    case "ask":
      return state.step === "done" ? state : { step: "confirming", failure: null };
    case "keep":
      return state.step === "sending" || state.step === "done" ? state : initialPrivateCopyState;
    case "sending":
      return { step: "sending", failure: null };
    case "done":
      return { step: "done", failure: null };
    case "failed":
      // Back to the question the holder just answered, with the reason under
      // it, so Delete is still where their finger was.
      return { step: "confirming", failure: action.failure };
  }
}

/**
 * Which sentence each answer gets, read off the service's own word first,
 * because /sealed/forget answers 404 for two different reasons and 503 for
 * three.
 */
const SERVICE_KEYS: Record<string, PrivateCopyFailure> = {
  unauthorized: { key: "signedOut", next: "signIn" },
  "not-holder": { key: "notHolder" },
  "no-passport": { key: "noPassport" },
  "nothing-kept": { key: "nothingKept" },
  "delete-failed": { key: "deleteFailed" },
  "privy-unavailable": { key: "dependencyDown" },
  "chain-unavailable": { key: "dependencyDown" },
  "metadata-unavailable": { key: "dependencyDown" },
  "lookup-unavailable": { key: "dependencyDown" },
  "rate-limited": { key: "rateLimited" },
  "bad-request": { key: "badRequest" },
  offline: { key: "offline" },
  "bad-response": { key: "badResponse" },
};

export function describeForgetFailure(error: unknown): PrivateCopyFailure {
  if (error instanceof VerifierError) {
    const mapped = SERVICE_KEYS[error.serviceCode ?? ""] ?? SERVICE_KEYS[error.code] ?? { key: "badResponse" };
    // Most refusals name only their word, and printing it under the sentence
    // would repeat the code back at the reader.
    return error.message === error.serviceCode ? mapped : { ...mapped, reason: error.message };
  }
  return { key: "unknown", reason: error instanceof Error ? error.message : String(error) };
}

/**
 * The delete, from the confirmed press to the page reading itself again.
 *
 * Kept apart from the component so the order is plain and testable: nothing is
 * sent without a token, the panel says deleted before the page is asked to
 * read itself again, and a refusal lands back on the question that was asked.
 */
export async function runForget({
  passportId,
  getAccessToken,
  dispatch,
  onDeleted,
}: {
  passportId: Hex;
  getAccessToken: () => Promise<string | null>;
  dispatch: (action: PrivateCopyAction) => void;
  onDeleted?: () => Promise<void> | void;
}): Promise<void> {
  dispatch({ type: "sending" });
  try {
    const token = await getAccessToken();
    if (token === null) {
      throw new VerifierError("unauthorized", 401, "unauthorized", undefined, { serviceCode: "unauthorized" });
    }
    await forgetPrivateCopy({ passportId, accessToken: token });
  } catch (error) {
    dispatch({ type: "failed", failure: describeForgetFailure(error) });
    return;
  }
  dispatch({ type: "done" });
  await onDeleted?.();
}

interface HolderProps {
  passportId: Hex;
  owner: Hex | null;
  kept: boolean;
}

// The wallet SDK is pulled in here and nowhere else in this file, so a reader
// who never signs in gets a sealed passport page without any of it, the same
// way the publish panel beside this one keeps it out.
const Holder = dynamic(
  () =>
    import("@privy-io/react-auth").then(({ usePrivy, useWallets }) => {
      function PrivyHolder({ passportId, owner, kept }: HolderProps) {
        const { ready, authenticated, login, getAccessToken } = usePrivy();
        const { wallets } = useWallets();
        const wallet = wallets.find((entry) => entry.walletClientType === "privy")?.address;

        if (!ready || !authenticated || !ownsPassport(owner, wallet)) {
          return null;
        }
        return <PrivateCopy passportId={passportId} kept={kept} getAccessToken={getAccessToken} signIn={login} />;
      }
      return PrivyHolder;
    }),
  { ssr: false, loading: () => null },
);

/**
 * The holder's delete for the small private copy Moolam keeps of a sealed
 * picture whose creator asked for the private re-check.
 *
 * Drawn for one reader only, the wallet the registry says holds the passport,
 * and only while the copy is kept. Everyone else gets no markup at all, because
 * the one thing this panel does cannot be undone.
 */
export function PrivateCopyPanel({
  passportId,
  owner,
  sealed,
  privateCopy,
}: {
  passportId: Hex;
  owner: Hex | null;
  sealed: boolean;
  /** Where the copy stands, or nothing when the document never asked for one. */
  privateCopy?: SealedCopyLookup["state"];
}) {
  if (!sealed || privateCopy === undefined) {
    return null;
  }
  return <Gate passportId={passportId} owner={owner} kept={privateCopy === "kept"} />;
}

function Gate(props: HolderProps) {
  return useWalletMounted() ? <Holder {...props} /> : null;
}

/**
 * The holder's panel with its own state. It stays up after a delete even
 * though the page then reads the copy as gone, so the answer is read where the
 * press was.
 */
export function PrivateCopy({
  passportId,
  kept,
  getAccessToken,
  signIn,
}: {
  passportId: Hex;
  kept: boolean;
  getAccessToken: () => Promise<string | null>;
  signIn: () => void;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(privateCopyReducer, initialPrivateCopyState);
  // Two presses of Delete must never send two requests, and a flag read
  // straight after a dispatch is a stale one.
  const busy = useRef(false);

  const forget = useCallback(async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    try {
      await runForget({
        passportId,
        getAccessToken,
        dispatch,
        onDeleted: async () => {
          await refreshPassport(passportId);
          router.refresh();
        },
      });
    } finally {
      busy.current = false;
    }
  }, [getAccessToken, passportId, router]);

  if (!kept && state.step !== "done") {
    return null;
  }

  return (
    <PrivateCopyCard
      state={state}
      actions={{
        ask: () => dispatch({ type: "ask" }),
        keep: () => dispatch({ type: "keep" }),
        forget: () => void forget(),
        signIn,
      }}
    />
  );
}

export interface PrivateCopyActions {
  ask: () => void;
  keep: () => void;
  forget: () => void;
  signIn: () => void;
}

/** What the holder sees, in the publish panel's own shape and light. */
export function PrivateCopyCard({ state, actions }: { state: PrivateCopyState; actions: PrivateCopyActions }) {
  const t = useTranslations("passport.privateCopy");
  const calm = useReducedMotion() === true;
  const sending = state.step === "sending";

  return (
    <motion.section
      initial={calm ? false : { opacity: 0, y: 28 }}
      whileInView={calm ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, ease: EASE }}
      data-private-copy-panel
      data-step={state.step}
      className="relative mt-14 overflow-hidden border border-s-2 border-line border-s-accent bg-bg-raised p-6 sm:p-8"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -end-24 -top-24 h-64 w-64 rounded-full opacity-[0.16]"
        style={{ background: "radial-gradient(circle, var(--accent) 0%, transparent 70%)" }}
      />

      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("kicker")}
      </p>
      <h2 className="mt-5 max-w-[18ch] font-display text-[clamp(1.5rem,3vw,2.3rem)] font-semibold uppercase leading-[1.02] tracking-[-0.03em]">
        {t("heading")}
      </h2>

      <AnimatePresence mode="wait" initial={false}>
        {state.step === "done" ? (
          <motion.p
            key="done"
            initial={calm ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            role="status"
            className="mt-6 max-w-[52ch] border-s-2 border-verified bg-verified/5 py-3 ps-4 text-base leading-relaxed text-text"
          >
            {t("done")}
          </motion.p>
        ) : state.step === "idle" ? (
          <motion.div
            key="idle"
            initial={calm ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={calm ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="mt-5"
          >
            <p className="max-w-[52ch] text-base leading-relaxed text-text-muted">{t("body")}</p>
            <button
              type="button"
              onClick={actions.ask}
              className="mt-7 rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-failed hover:text-failed"
            >
              {t("delete")}
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="confirming"
            initial={calm ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={calm ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="mt-5"
          >
            <p className="max-w-[52ch] border-s-2 border-failed/60 ps-4 text-base leading-relaxed text-text">
              {t("confirm")}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={actions.forget}
                disabled={sending}
                data-confirm-delete
                className="rounded-[8px] bg-failed px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-bg transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
              >
                {t("confirmDelete")}
              </button>
              <button
                type="button"
                onClick={actions.keep}
                disabled={sending}
                className="rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {t("keep")}
              </button>
            </div>

            {sending ? (
              <p
                role="status"
                className="mt-6 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-pending"
              >
                <span aria-hidden className={`inline-block h-2 w-2 bg-pending ${calm ? "" : "animate-pulse"}`} />
                {t("sending")}
              </p>
            ) : null}

            {state.failure === null ? null : <FailureLine failure={state.failure} signIn={actions.signIn} />}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

/** One refusal, in the same shape the publish panel prints its own. */
function FailureLine({ failure, signIn }: { failure: PrivateCopyFailure; signIn: () => void }) {
  const t = useTranslations("passport.privateCopy");

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      role="alert"
      data-failure={failure.key}
      className="mt-6 border-s-2 border-failed bg-failed/5 py-3 ps-4"
    >
      <p className="flex max-w-[52ch] items-start gap-2.5 text-base leading-relaxed text-failed">
        <WarningMark className="mt-[5px]" />
        {t(`failure.${failure.key}`)}
      </p>
      {failure.reason === undefined ? null : (
        <p className="mt-2 max-w-[52ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
          {oneLine(failure.reason)}
        </p>
      )}
      {failure.next === "signIn" ? (
        <button
          type="button"
          onClick={signIn}
          className="mt-4 rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t("actions.signIn")}
        </button>
      ) : null}
    </motion.div>
  );
}
