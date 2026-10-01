"use client";

import { motion } from "framer-motion";
import { useId, useState } from "react";
import type { AccountView } from "@/components/account/account-api";
import { useAccount } from "@/components/account/use-account";
import { INK_BUTTON, PRIMARY_BUTTON, ProblemNote, Spinner, Arrow, useSecondsSince } from "./bits";
import { cosignLink } from "./moolam-links";
import { CLAIM_SNAG, PAGE_WORDS, postClaim, postCosign, postForget, postRegister, readRemembered, type TermsChoice } from "./picture-api";
import { DEFAULT_TERMS, TERMS_OPTIONS } from "./terms-choices";
import { TITLE_MAX, TITLE_WORDS, defaultTitle, titleProblem } from "./title-rule";
import { checkout, sendWindow } from "./window-flow";

type Pending = { kind: "cosign" | "register" | "claim"; since: number } | null;

const rise = { hidden: { opacity: 0, y: 24 }, shown: { opacity: 1, y: 0 } };

/**
 * Before a passport: the public title, the AI-use terms, and the two ways to a passport. Both
 * choices are locked while either request is out, so one picture never asks for both. For a session
 * that asked Dreamloom to remember its Moolam address, the second way registers the picture and
 * hands its passport straight to that address in one press.
 */
export function ChoosePanel({
  id,
  prompt,
  moolamSite,
  remembered,
  onRemembered,
  onCosignOpened,
  onClaimSnag,
  onChanged,
}: {
  id: string;
  prompt: string;
  moolamSite: string;
  remembered: string | null;
  onRemembered: (address: string | null) => void;
  onCosignOpened: (blocked: boolean) => void;
  onClaimSnag: (words: string) => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(() => defaultTitle(prompt));
  const [terms, setTerms] = useState<TermsChoice>(DEFAULT_TERMS);
  const [pending, setPending] = useState<Pending>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const read = useAccount();
  const account = read.kind === "done" ? read.view : null;
  const titleId = useId();
  const noteId = useId();
  const issue = titleProblem(title);
  const locked = pending !== null;

  async function cosign() {
    if (locked || issue !== null) return;
    // Opened inside the click, before the request, so no popup blocker stops it.
    const target = checkout.open();
    setProblem(null);
    setPending({ kind: "cosign", since: Date.now() });
    const answer = await postCosign(id, terms, title.trim());
    if (!answer.ok) {
      checkout.close();
      setPending(null);
      setProblem(answer.refusal.words);
      if (answer.refusal.reload) onChanged();
      return;
    }
    const link = cosignLink(answer.value.cosignUrl, moolamSite);
    if (link === null) {
      checkout.close();
      setPending(null);
      setProblem(PAGE_WORDS.unexpected);
      onChanged();
      return;
    }
    onCosignOpened(sendWindow(target, link) === "blocked");
    onChanged();
  }

  async function register() {
    if (locked || issue !== null) return;
    setProblem(null);
    setPending({ kind: "register", since: Date.now() });
    const answer = await postRegister(id, terms, title.trim());
    if (!answer.ok) {
      setPending(null);
      setProblem(answer.refusal.words);
      if (answer.refusal.reload) onChanged();
      return;
    }
    onChanged();
  }

  async function claim() {
    if (locked || issue !== null) return;
    setProblem(null);
    setPending({ kind: "claim", since: Date.now() });
    const answer = await postClaim(id, terms, title.trim());
    if (!answer.ok) {
      setPending(null);
      setProblem(answer.refusal.words);
      // The address may have been forgotten in another tab, which is one reason a claim is refused.
      onRemembered(await readRemembered());
      if (answer.refusal.reload) onChanged();
      return;
    }
    if (answer.value.claim !== undefined) onClaimSnag(CLAIM_SNAG);
    onChanged();
  }

  async function forget() {
    if (locked) return;
    setProblem(null);
    const answer = await postForget();
    if (answer.ok) onRemembered(answer.value.address);
    else setProblem(answer.refusal.words);
  }

  return (
    <motion.div
      initial="hidden"
      animate="shown"
      transition={{ staggerChildren: 0.09, delayChildren: 0.15 }}
      className="rounded-[2rem] bg-card/95 p-5 shadow-[0_30px_70px_-40px_rgba(23,18,43,0.45)] ring-1 ring-ink/5 sm:p-8"
    >
      <motion.div variants={rise}>
        <StepLabel number={1}>Name it</StepLabel>
        <label htmlFor={titleId} className="sr-only">
          Title
        </label>
        <input
          id={titleId}
          type="text"
          value={title}
          readOnly={locked}
          onChange={(event) => {
            setTitle(event.target.value);
            setProblem(null);
          }}
          aria-invalid={issue !== null}
          aria-describedby={noteId}
          className={`mt-3 block min-h-14 w-full rounded-2xl border-2 bg-card px-4 py-3 font-display text-xl font-bold tracking-[-0.02em] text-ink transition focus:outline-none read-only:text-ink-soft ${issue === null ? "border-ink/10 hover:border-ink/20 focus:border-violet" : "border-alert/50 focus:border-alert"}`}
        />
        <div id={noteId} className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-1 text-sm">
          <span className={issue === null ? "text-ink-soft" : "font-semibold text-alert"} aria-live="polite">
            {issue === null ? "This title becomes public with the picture's passport." : TITLE_WORDS[issue]}
          </span>
          <span className={`tabular-nums ${title.trim().length > TITLE_MAX ? "font-semibold text-alert" : "text-ink-soft"}`}>
            {title.trim().length} / {TITLE_MAX}
          </span>
        </div>
      </motion.div>

      <motion.fieldset variants={rise} className="mt-8" disabled={locked}>
        <legend>
          <StepLabel number={2}>How may AI use it?</StepLabel>
        </legend>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
          {TERMS_OPTIONS.map((option) => {
            const chosen = option.value === terms;
            return (
              <label
                key={option.value}
                className={`group relative flex min-h-14 cursor-pointer flex-col rounded-2xl border-2 px-4 py-3.5 transition duration-200 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet has-[:disabled]:cursor-not-allowed ${chosen ? "border-violet bg-mist/70 shadow-[0_10px_24px_-16px_rgba(90,59,255,0.8)]" : "border-ink/10 bg-card hover:-translate-y-0.5 hover:border-tangerine hover:bg-sun/15"}`}
              >
                <input
                  type="radio"
                  name="terms"
                  value={option.value}
                  checked={chosen}
                  onChange={() => setTerms(option.value)}
                  className="sr-only"
                />
                <span className="flex items-center gap-2 font-display text-lg leading-tight font-bold text-ink">
                  <span
                    aria-hidden
                    className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition ${chosen ? "border-violet bg-violet" : "border-ink/25"}`}
                  >
                    {chosen && <span className="size-1.5 rounded-full bg-white" />}
                  </span>
                  {option.name}
                </span>
                <span className="mt-1.5 text-sm leading-snug text-ink-soft">{option.line}</span>
              </label>
            );
          })}
        </div>
      </motion.fieldset>

      <motion.div variants={rise} className="mt-8">
        <StepLabel number={3}>Give it a passport</StepLabel>
        <div className="mt-3 grid gap-4 md:grid-cols-2 md:grid-rows-[auto_auto] md:gap-y-2.5">
          <div className="flex flex-col gap-2.5 md:row-span-2 md:grid md:grid-rows-subgrid">
            <button
              type="button"
              onClick={cosign}
              disabled={locked || issue !== null}
              className={PRIMARY_BUTTON}
            >
              {pending?.kind === "cosign" ? "Preparing" : "Sign it as the creator"}
              {pending?.kind === "cosign" ? <Spinner /> : <Arrow />}
            </button>
            <p className="px-2 text-sm leading-snug text-ink-soft">
              Your own passkey signs it on Moolam, so the passport credits you from the first block.
            </p>
          </div>
          {remembered === null ? (
            <div className="flex flex-col gap-2.5 md:row-span-2 md:grid md:grid-rows-subgrid">
              <button
                type="button"
                onClick={register}
                disabled={locked || issue !== null}
                className={INK_BUTTON}
              >
                {pending?.kind === "register" ? "Registering" : "Let Dreamloom hold it for me"}
                {pending?.kind === "register" ? <Spinner /> : <Arrow />}
              </button>
              <HoldHint account={account} />
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 md:row-span-2 md:grid md:grid-rows-subgrid">
              <button type="button" onClick={claim} disabled={locked || issue !== null} className={INK_BUTTON}>
                {pending?.kind === "claim" ? "Putting it in your account" : "Put it in my Moolam account"}
                {pending?.kind === "claim" ? <Spinner /> : <Arrow />}
              </button>
              <p className="px-2 text-sm leading-snug text-ink-soft">
                Dreamloom registers it and hands the passport straight to{" "}
                <span className="font-mono text-[0.8rem] break-all text-ink">{remembered}</span>.{" "}
                <button
                  type="button"
                  onClick={() => void forget()}
                  disabled={locked}
                  className="cursor-pointer font-semibold whitespace-nowrap text-violet underline decoration-violet/30 underline-offset-4 transition hover:text-tangerine hover:decoration-tangerine disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Forget my address
                </button>
              </p>
            </div>
          )}
        </div>
      </motion.div>

      <div role="status" aria-live="polite" className="mt-5 empty:hidden">
        {pending !== null && <PendingNote pending={pending} />}
        {pending === null && problem !== null && <ProblemNote>{problem}</ProblemNote>}
      </div>
    </motion.div>
  );
}

/**
 * What "Let Dreamloom hold it for me" means for this visitor. Signed in with Google, the passport is
 * left waiting at Moolam under their address, shown only as the mask the session answer gives.
 */
export function HoldHint({ account }: { account: AccountView | null }) {
  return (
    <p className="px-2 text-sm leading-snug text-ink-soft">
      {account?.available === true && account.signedIn ? (
        <>
          Dreamloom registers it now, and it waits for you at Moolam under{" "}
          <span className="font-mono text-[0.8rem] font-semibold break-all text-ink">{account.email}</span>. Claim it there
          with this Google account.
        </>
      ) : (
        "Dreamloom registers it now and holds it until you claim it into your own Moolam account."
      )}
    </p>
  );
}

function StepLabel({ number, children }: { number: number; children: string }) {
  return (
    <span className="flex items-center gap-2.5 font-display text-xl font-extrabold tracking-[-0.02em] text-ink sm:text-2xl">
      <span className="bg-daybreak inline-flex size-7 shrink-0 items-center justify-center rounded-full font-sans text-sm font-bold text-white">
        {number}
      </span>
      {children}
    </span>
  );
}

const PENDING_LINES: Record<NonNullable<Pending>["kind"], { lead: string; line: string }> = {
  cosign: {
    lead: "Preparing your picture on Moolam.",
    line: "Moolam signs and fingerprints it first, which can take several seconds.",
  },
  register: {
    lead: "Dreamloom is registering your picture on Monad.",
    line: "Moolam signs it, then the passport is written on chain. This can take up to a minute.",
  },
  claim: {
    lead: "Dreamloom is registering your picture and handing it to your Moolam account.",
    line: "The passport is written on chain, then moved to your address. This can take up to two minutes.",
  },
};

/** Every request here can take a while: the picture is signed and fingerprinted, and a register waits for the chain. */
function PendingNote({ pending }: { pending: NonNullable<Pending> }) {
  const seconds = useSecondsSince(pending.since);
  return (
    <p className="px-1 text-base text-ink">
      <span className="font-semibold">
        {PENDING_LINES[pending.kind].lead}
      </span>{" "}
      <span className="text-ink-soft">
        {PENDING_LINES[pending.kind].line}{" "}
        <span className="tabular-nums">{seconds} s</span> so far.
      </span>
    </p>
  );
}
