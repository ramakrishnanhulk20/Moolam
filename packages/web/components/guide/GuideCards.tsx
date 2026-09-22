"use client";

import { motion, type Variants } from "framer-motion";
import { useState } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import { GuideGround, type GuideClose, type GuideStage } from "./GuideGround";
import { GuideMarkDrawing } from "./marks";
import { guideSteps, type GuideStep } from "./steps";

/**
 * Drawing A: the three things, on one screen, once.
 *
 * It is laid along the bottom of the window rather than centred in it, so the
 * picture behind stays readable and the guide reads as part of the film instead
 * of a box dropped on top of it. The page keeps playing behind the blur.
 */
export function GuideCards({
  open,
  onClose,
  stage = "window",
  onGo,
}: {
  open: boolean;
  onClose: (reason: GuideClose) => void;
  stage?: GuideStage;
  /** The bench passes this so a press is reported rather than followed. */
  onGo?: (step: GuideStep) => void;
}) {
  const reduced = useIsReducedMotion();

  const panel: Variants = {
    hidden: {},
    shown: { transition: { staggerChildren: reduced ? 0 : 0.07, delayChildren: reduced ? 0 : 0.1 } },
  };

  const rise: Variants = {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 26 },
    shown: { opacity: 1, y: 0, transition: { duration: reduced ? 0.2 : 0.7, ease: [0.16, 1, 0.3, 1] } },
    leaving: { opacity: 0, transition: { duration: 0.2 } },
  };

  return (
    <GuideGround open={open} onClose={onClose} stage={stage} label="What you can do on Moolam">
      {/* One light source behind the row, off to the left. It is the only thing
          in the guide that is not type or a hairline. */}
      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0.2 : 0.9 }}
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[70%] bg-[radial-gradient(60%_80%_at_22%_100%,var(--accent-soft),transparent_70%)]"
      />

      {/* The scroller and the layout are two elements on purpose. A flex column
          that pushes its content to the bottom cuts off its own top once the
          content is taller than the window, which on a short phone is exactly
          where the Skip button lives. min-h-full keeps the bottom anchoring and
          lets the box grow past the window instead. */}
      <motion.div
        variants={panel}
        initial="hidden"
        animate="shown"
        exit="leaving"
        className="pointer-events-auto absolute inset-0 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex min-h-full w-full max-w-[100rem] flex-col justify-end px-5 pb-5 pt-10 sm:px-8 sm:pb-10 sm:pt-16 lg:px-14">
          <motion.div variants={rise} className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
            <div>
              <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-accent sm:text-[11px]">
                <span className="motif h-[9px] w-[9px]" />
                First visit
              </p>
              <h2 className="mt-3 max-w-[15ch] font-display text-[clamp(1.75rem,4.4vw,3.4rem)] font-semibold uppercase leading-[0.9] tracking-[-0.05em] text-[color:var(--text)]">
                What can I do here?
              </h2>
            </div>

            <div className="flex items-center gap-4">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">Shown once</span>
              <button
                type="button"
                onClick={() => onClose("skip")}
                className="tap rounded-[8px] border border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
              >
                Skip
              </button>
            </div>
          </motion.div>

          <motion.p variants={rise} className="mt-3 hidden max-w-[46ch] text-sm leading-relaxed text-text-muted sm:block">
            Three things, and where each one lives. Pick one, or skip and look around.
          </motion.p>

          <ul className="mt-3.5 grid gap-2.5 sm:mt-8 sm:grid-cols-3 sm:gap-4">
            {guideSteps.map((step) => (
              <motion.li key={step.id} variants={rise} className="min-w-0">
                <StepCard step={step} reduced={reduced} onGo={onGo} onClose={onClose} />
              </motion.li>
            ))}
          </ul>
        </div>
      </motion.div>
    </GuideGround>
  );
}

function StepCard({
  step,
  reduced,
  onGo,
  onClose,
}: {
  step: GuideStep;
  reduced: boolean;
  onGo?: (step: GuideStep) => void;
  onClose: (reason: GuideClose) => void;
}) {
  // The drawing moves for a mouse and for a keyboard alike, so the focused card
  // is as alive as the hovered one.
  const [lit, setLit] = useState(false);

  const body = (
    <>
      <div className="flex items-start justify-between gap-4">
        <span className="font-mono text-[10px] tracking-[0.2em] text-accent">{step.number}</span>
        <GuideMarkDrawing mark={step.mark} reduced={reduced} />
      </div>

      <h3 className="mt-2.5 flex max-w-[20ch] items-baseline gap-2 font-display text-[1.05rem] font-semibold leading-[1.1] tracking-[-0.03em] sm:mt-4 sm:max-w-[18ch] sm:text-[1.25rem]">
        {step.title}
        {/* On a phone the whole card is the button, so the arrow rides on the
            title and the row below is not needed. */}
        <span aria-hidden className="text-accent transition-transform duration-200 group-hover:translate-x-1 sm:hidden">
          &rarr;
        </span>
      </h3>
      <p className="mt-1.5 max-w-[38ch] text-[13px] leading-relaxed text-text-muted sm:mt-2 sm:pb-5 sm:text-sm">{step.line}</p>

      <span className="mt-auto hidden items-center gap-2 self-start rounded-[8px] border border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted transition-colors duration-200 group-hover:border-accent group-hover:text-accent group-focus-within:border-accent group-focus-within:text-accent sm:inline-flex">
        {step.action}
        <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
          &rarr;
        </span>
      </span>
    </>
  );

  const shell =
    "group flex h-full flex-col rounded-[8px] border border-line bg-[color:var(--bg-raised)]/75 p-4 backdrop-blur-sm transition-colors duration-200 hover:border-line-strong focus-visible:outline-none sm:p-5";

  return (
    <motion.div
      variants={{
        rest: { y: 0 },
        hover: reduced ? { y: 0 } : { y: -6, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
      }}
      initial="rest"
      animate={lit ? "hover" : "rest"}
      whileHover="hover"
      onFocus={() => setLit(true)}
      onBlur={() => setLit(false)}
      onPointerEnter={() => setLit(true)}
      onPointerLeave={() => setLit(false)}
      className="h-full"
    >
      {onGo === undefined ? (
        <Link href={step.href} prefetch={false} className={shell} onClick={() => onClose("go")}>
          {body}
        </Link>
      ) : (
        <button type="button" className={`${shell} text-left`} onClick={() => onGo(step)}>
          {body}
        </button>
      )}
    </motion.div>
  );
}
