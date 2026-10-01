"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { SIGNIN_WORDS, postSignOut, signInHref, signInOutcome, type AccountView, type SignInOutcome } from "./account-api";
import { setAccount, useAccount, type AccountRead } from "./use-account";

/**
 * The corner's row on phones: one fixed height whether the session answer is still on its way or
 * says signed in or signed out, so nothing under the header moves when the answer lands. From sm up
 * it sits inline beside the wordmark at its own height.
 */
export const CORNER_ROW = "relative order-last flex h-11 w-full justify-end sm:order-none sm:ml-auto sm:h-auto sm:w-auto";

/**
 * The header's account corner. Signed out: "Sign in with Google" inside the same turning daybreak
 * ring the prompt box wears. Signed in: the masked address and "Sign out". When Google sign-in is
 * not set up on the server, or the server does not answer, nothing is drawn at all.
 *
 * On phones it takes its own row under the wordmark, so the address is never squeezed out.
 */
export function AccountChip() {
  const read = useAccount();
  const [href, setHref] = useState("/api/auth/signin/google?from=%2F");
  const [outcome, setOutcome] = useState<SignInOutcome | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setHref(signInHref(window.location.pathname));
    const word = signInOutcome(window.location.search);
    if (word !== null) {
      setOutcome(word);
      // The word has been read; the address bar goes back to the page's own address.
      const url = new URL(window.location.href);
      url.searchParams.delete("signin");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  async function signOut() {
    if (leaving) return;
    setLeaving(true);
    const view = await postSignOut();
    setLeaving(false);
    if (view !== null) setAccount(view);
  }

  return (
    <AccountCorner
      read={read}
      href={href}
      leaving={leaving}
      outcome={outcome}
      onSignOut={() => void signOut()}
      onCloseOutcome={() => setOutcome(null)}
    />
  );
}

/**
 * The whole corner for one session answer, apart from its requests, so each state can be drawn and
 * checked on its own. While the answer is on its way, phones keep the row empty at the chip's
 * height; once the answer says sign-in is not offered, or never comes, the row goes. From sm up
 * nothing is held, as before.
 */
export function AccountCorner({
  read,
  href,
  leaving,
  outcome,
  onSignOut,
  onCloseOutcome,
}: {
  read: AccountRead;
  href: string;
  leaving: boolean;
  outcome: SignInOutcome | null;
  onSignOut: () => void;
  onCloseOutcome: () => void;
}) {
  if (read.kind === "loading") return <div aria-hidden data-corner="held" className={`${CORNER_ROW} sm:hidden`} />;
  const account = read.view;
  if (account === null || !account.available) return null;

  return (
    <div className={CORNER_ROW}>
      <AccountChipView account={account} href={href} leaving={leaving} onSignOut={onSignOut} />
      <AnimatePresence>
        {outcome !== null && !account.signedIn && (
          <motion.p
            key={outcome}
            role="status"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="absolute top-full right-0 z-20 mt-2 w-[min(22rem,100%)] rounded-2xl border-2 border-alert/20 bg-card px-4 py-3 text-sm font-medium text-alert shadow-[0_18px_40px_-24px_rgba(23,18,43,0.55)] sm:w-[22rem]"
          >
            {SIGNIN_WORDS[outcome]}
            <button
              type="button"
              onClick={onCloseOutcome}
              className="ml-2 cursor-pointer font-semibold text-ink underline decoration-ink/30 underline-offset-4 transition hover:text-violet hover:decoration-violet"
            >
              Close
            </button>
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

/** What the corner draws for a given sign-in, apart from its requests, so each state can be drawn and checked on its own. */
export function AccountChipView({
  account,
  href,
  leaving,
  onSignOut,
}: {
  account: Extract<AccountView, { available: true }>;
  href: string;
  leaving: boolean;
  onSignOut: () => void;
}) {
  return (
    <AnimatePresence mode="wait" initial={true}>
      {account.signedIn ? (
        <motion.div
          key="in"
          initial={{ opacity: 0, y: -10, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.96 }}
          transition={{ type: "spring", stiffness: 260, damping: 22 }}
          className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-full border-2 border-ink/10 bg-card/80 py-0.5 pr-0.5 pl-0.5 backdrop-blur sm:w-auto"
        >
          <span
            aria-hidden
            className="bg-daybreak inline-flex size-8 shrink-0 items-center justify-center rounded-full font-display text-sm font-extrabold text-white uppercase"
          >
            {[...account.email][0]}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={account.email}>
            <span className="sr-only">Signed in as </span>
            {account.email}
          </span>
          <button
            type="button"
            onClick={onSignOut}
            disabled={leaving}
            className="inline-flex min-h-9 shrink-0 cursor-pointer items-center rounded-full bg-ink px-3.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-violet focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-not-allowed disabled:opacity-60"
          >
            {leaving ? "Signing out" : "Sign out"}
          </button>
        </motion.div>
      ) : (
        <motion.a
          key="out"
          href={href}
          initial={{ opacity: 0, y: -10, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.96 }}
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.97 }}
          transition={{ type: "spring", stiffness: 260, damping: 22 }}
          className="weave-ring group inline-flex rounded-full p-[2px] shadow-[0_10px_26px_-14px_rgba(90,59,255,0.7)] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-violet"
        >
          <span className="inline-flex min-h-10 items-center gap-2.5 rounded-full bg-card px-4 text-sm font-bold text-ink transition-colors group-hover:bg-mist">
            <GoogleMark />
            Sign in with Google
          </span>
        </motion.a>
      )}
    </AnimatePresence>
  );
}

/** Google's four-colour G, drawn by hand so the button needs no outside image. */
function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" className="size-[18px] shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
