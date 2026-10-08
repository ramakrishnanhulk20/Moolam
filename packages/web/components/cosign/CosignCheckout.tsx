"use client";

/* eslint-disable @next/next/no-img-element -- the print is a blob of the very bytes this browser hashed, which the optimizer cannot fetch */

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode, type RefObject } from "react";
import type { Hex } from "viem";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { plainStatement } from "@/lib/chain/consent";
import { failReason, type CosignModel, type Press } from "@/lib/cosign/flow";
import type { AgentFacts } from "@/lib/cosign/listing";
import type { Closing } from "@/lib/cosign/popup";
import { Link } from "@/lib/i18n/routing";
import { CHECKOUT_COLUMN, CHECKOUT_DOCK, CHECKOUT_SHELL, CheckoutBar, DoneLine, QUIET } from "./Checkout";
import { EASE, Kicker, StateLine, StateSwap, shortAddress } from "./Marks";
import { GhostSeal, SealStamp } from "./Seal";
import { Actions, Extras, Progress, type Clause, type Words } from "./StateParts";

export interface CosignCheckoutProps {
  pageRef: RefObject<HTMLElement | null>;
  model: CosignModel;
  agent: AgentFacts | null;
  wallet: Hex | null;
  balance: bigint | null;
  onPress: (press: Press) => void;
  words: Words;
  /** The same six clauses the full page numbers, folded away until asked for. */
  clauses: Clause[];
  kicker: string;
  title: string | null;
  printLine: string;
  /** The platform's name when Moolam lists it and vouches for the pairing, else null. */
  platform: string | null;
  closing: Closing;
}

/**
 * The co-sign page as a checkout window: who is asking in the bar, the
 * picture as a small print with its title, the six clauses folded into the
 * three a person decides on, and the state and its one button docked at the
 * bottom so they are always in view. It draws from the same model, words and
 * presses as the full sheet, so the gate that opens the passkey button there
 * opens it here and nothing else does.
 */
export function CosignCheckout({
  pageRef,
  model,
  agent,
  wallet,
  balance,
  onPress,
  words,
  clauses,
  kicker,
  title,
  printLine,
  platform,
  closing,
}: CosignCheckoutProps) {
  const t = useTranslations("cosign");
  const windowWords = useTranslations("checkout");
  const reduced = useIsReducedMotion();
  const view = model.view;
  const fail = failReason(model);
  const exactHash = model.record?.exactHash ?? model.named?.exactHash ?? null;
  const passportId = model.send.at === "registered" ? model.send.passportId : null;
  const digest = model.gate.at === "passed" ? model.gate.digest : null;
  const rise = (delay: number) =>
    reduced
      ? { initial: false as const, animate: { opacity: 1, y: 0 }, transition: { duration: 0 } }
      : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: EASE, delay } };

  const lock = agent === null ? null : platform === null ? windowWords("lockUnnamed") : windowWords("lockListed", { platform });

  return (
    <article
      ref={pageRef}
      data-cosign-state={view}
      data-fail={fail ?? undefined}
      data-checkout
      data-lenis-prevent
      className={CHECKOUT_SHELL}
    >
      <CheckoutBar lock={lock} listed={platform !== null} />

      <div className="relative isolate flex-1 overflow-x-clip">
        <span
          aria-hidden
          className="pointer-events-none absolute -end-28 -top-32 -z-10 h-80 w-80 rounded-full bg-[radial-gradient(circle,var(--accent-soft),transparent_65%)]"
        />
        <div className={`${CHECKOUT_COLUMN} pb-6 pt-6`}>
          <div className="flex items-center gap-8">
            <motion.div {...rise(0)} className="relative shrink-0">
              <figure className="relative -rotate-2 bg-bg-raised p-1.5 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.85)] ring-1 ring-line-strong">
                <div data-print className="grain relative h-[6.75rem] w-[6.75rem] overflow-hidden bg-bg">
                  {model.drawn === null ? (
                    <div className="absolute inset-0 flex items-center justify-center border border-dashed border-line-strong">
                      <span aria-hidden className="motif h-5 w-5 opacity-40" />
                    </div>
                  ) : (
                    <img
                      src={model.drawn.picture}
                      alt={title ?? t("untitled")}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  )}
                </div>
              </figure>
              <div className="absolute -bottom-5 -end-6 h-[4.25rem] w-[4.25rem]">
                {passportId !== null ? (
                  <SealStamp
                    label={t("sealLabel", { id: passportId })}
                    ring={t("sealRing", { id: shortAddress(passportId) })}
                    className="absolute inset-0"
                  />
                ) : (
                  <GhostSeal
                    pressing={view === "signing"}
                    idle={view === "expired" || view === "failed" || view === "wrongWallet" || view === "notFound"}
                  />
                )}
              </div>
            </motion.div>

            <div className="min-w-0">
              <motion.p
                {...rise(0.05)}
                className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-accent"
              >
                <span className="motif h-[8px] w-[8px] shrink-0" />
                <span className="min-w-0 truncate">{kicker}</span>
              </motion.p>
              <motion.h1
                {...rise(0.1)}
                className="mt-2 line-clamp-3 break-words font-display text-[clamp(1.55rem,6.4vw,2.2rem)] font-semibold uppercase leading-[0.92] tracking-[-0.04em]"
              >
                {title ?? t("untitled")}
              </motion.h1>
              {model.drawn === null ? (
                <p data-print-waiting className="mt-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-text-faint">
                  {printLine}
                </p>
              ) : null}
            </div>
          </div>

          {view === "notFound" ? null : (
            <motion.div {...rise(0.16)} className="mt-9">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">{t("heading")}</p>
              <FoldLines model={model} agent={agent} wallet={wallet} />
              <Unfold clauses={clauses} />
            </motion.div>
          )}
        </div>
      </div>

      <div className={CHECKOUT_DOCK}>
        <div className={CHECKOUT_COLUMN}>
          <StateSwap state={`${view}-${fail ?? ""}-${model.gate.at}-${closing}`}>
            <Kicker tone={words.tone}>{words.kicker}</Kicker>
            {closing === "idle" ? (
              <>
                <h2 className="mt-2.5 font-display text-[1.4rem] font-semibold leading-[1.08] tracking-[-0.025em]">
                  {words.headline}
                </h2>
                <StateLine tone={words.tone} className="mt-2">
                  {words.line}
                </StateLine>
              </>
            ) : (
              <div className="mt-2.5">
                <DoneLine closing={closing} platform={platform} />
              </div>
            )}
            <div className="mt-3 empty:hidden">
              <Extras model={model} />
            </div>
            {words.note === undefined || closing !== "idle" ? null : (
              <p className="mt-2 text-base leading-relaxed text-text-faint">{words.note}</p>
            )}
          </StateSwap>

          <div className="mt-4 empty:hidden">
            <Progress model={model} balance={balance} onPress={onPress} />
            {closing === "idle" ? (
              <Actions model={model} words={words} exactHash={exactHash} onPress={onPress} checkout />
            ) : closing === "stuck" && passportId !== null && words.primary !== undefined ? (
              <div className="flex justify-center">
                <Link href={`/passport/${passportId}`} prefetch={false} className={QUIET}>
                  {words.primary}
                </Link>
              </div>
            ) : null}
          </div>

          {digest === null || closing !== "idle" ? null : (
            <p className="mt-3 flex min-w-0 items-center gap-3 border-t border-line pt-2.5 font-mono text-[10px] tracking-[0.06em] text-text-faint">
              <span className="shrink-0 uppercase tracking-[0.24em]">{t("signHere")}</span>
              <span className="min-w-0 truncate" title={digest}>
                {t("passkeySigns", { digest: shortAddress(digest) })}
              </span>
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * The three clauses a person decides on, one short line each: who drew it,
 * whose name it goes under, and the AI-use terms. The platform is in the bar
 * above; the rest waits behind the toggle.
 */
function FoldLines({ model, agent, wallet }: { model: CosignModel; agent: AgentFacts | null; wallet: Hex | null }) {
  const t = useTranslations("cosign");
  const summary = useTranslations("cosign.terms");
  const view = model.view;
  const agentId = model.record?.agentId ?? model.named?.agentId ?? null;
  const signedOut = view === "signIn" || view === "loading" || view === "notFound";
  const muted = (text: string) => <span className="text-text-muted">{text}</span>;

  const drawnBy: ReactNode =
    agentId === null ? (
      muted(t("signedOut"))
    ) : (
      <>
        {agent === null ? null : agent.name === null ? muted(t("agent.noName")) : <>&ldquo;{agent.name}&rdquo;</>}
        <span className={`font-mono text-[11px] text-text-muted ${agent === null ? "" : "ms-2"}`}>{t("agent.id", { id: agentId })}</span>
      </>
    );

  const creator: ReactNode =
    view === "wrongWallet" ? (
      t("clauses.creator.other")
    ) : signedOut || wallet === null ? (
      muted(t("signedOut"))
    ) : (
      <span className="font-mono text-[0.95rem] tracking-[0.02em]" title={wallet}>
        {shortAddress(wallet)}
      </span>
    );

  const consent = model.drawn?.terms?.consent ?? null;
  const terms: ReactNode = signedOut
    ? muted(t("signedOut"))
    : model.drawn === null
      ? muted(t("clauses.terms.pending"))
      : summary(consent === null ? "none" : plainStatement(consent));

  const lines = [
    { key: "agent", label: t("clauses.agent.label"), value: drawnBy },
    { key: "creator", label: t("clauses.creator.label"), value: creator },
    { key: "terms", label: t("clauses.terms.label"), value: terms },
  ];

  return (
    <ul className="mt-3 border-t border-line-strong">
      {lines.map((line) => (
        <li key={line.key} data-fold-line={line.key} className="border-b border-line py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{line.label}</p>
          <p className="mt-1 min-w-0 truncate text-base leading-snug text-text">{line.value}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * "See everything you are signing": the full six clauses, word for word as
 * the full page has them. They are always in the page, so a reader or a test
 * finds every one; closed, they take no room and no focus.
 */
function Unfold({ clauses }: { clauses: Clause[] }) {
  const t = useTranslations("checkout");
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        data-fold-toggle
        onClick={() => setOpen((was) => !was)}
        className="group flex w-full items-center justify-between gap-3 rounded-[8px] py-3 text-start font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="underline decoration-line-strong underline-offset-4 transition-colors duration-200 group-hover:decoration-accent">
          {t("more")}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 transition-transform duration-300 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>
      <div
        id={id}
        data-unfold={open ? "open" : "closed"}
        inert={!open}
        className={`grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <ol className="min-h-0 overflow-hidden">
          {clauses.map((clause, index) => (
            <li
              key={clause.key}
              data-clause={clause.key}
              className="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-x-3 border-b border-line py-4 first:border-t first:border-line-strong"
            >
              <span
                aria-hidden
                className="font-display text-[1.9rem] font-semibold leading-[0.85] tracking-[-0.06em] text-transparent [-webkit-text-stroke:1px_var(--accent)]"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <p className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
                  {clause.mark === "solid" ? <span aria-hidden className="motif h-[8px] w-[8px]" /> : null}
                  {clause.mark === "dashed" ? (
                    <span aria-hidden className="h-[8px] w-[8px] border border-dashed border-text-muted" />
                  ) : null}
                  {clause.label}
                </p>
                {clause.body}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
