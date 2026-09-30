"use client";

/* eslint-disable @next/next/no-img-element -- the print is a blob of the very bytes this browser hashed, which the optimizer cannot fetch */

import { motion, useScroll, useTransform } from "framer-motion";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Picture } from "@/components/passport/Picture";
import { failReason, type CosignModel, type CosignView, type FailReason, type Press } from "@/lib/cosign/flow";
import type { AgentFacts } from "@/lib/cosign/listing";
import { cosignFinished, useCheckoutWindow, useCloseWhenDone } from "@/lib/cosign/popup";
import { pictureSources } from "@/lib/images";
import { CosignCheckout } from "./CosignCheckout";
import { AgentFact, PlatformFact, TermsFact, standingOf } from "./Facts";
import {
  EASE,
  Kicker,
  StateLine,
  StateSwap,
  chainClock,
  shortAddress,
  type Tone,
} from "./Marks";
import { FIELD, GhostSeal, SealStamp } from "./Seal";
import { Actions, Extras, Progress, type Clause, type Words } from "./StateParts";

const TONES: Record<CosignView, Tone> = {
  loading: "wait",
  notFound: "stop",
  signIn: "ask",
  makePasskey: "ask",
  passkeyElsewhere: "ask",
  wrongWallet: "stop",
  waitingAgent: "wait",
  ready: "ask",
  signing: "wait",
  registered: "done",
  expired: "stop",
  failed: "failed",
};

/** The facts every state's words are filled from. */
interface Context {
  platform: string;
  agent: string;
  wallet: string;
  time: string | null;
  holder: string | null;
}

function useWords(model: CosignModel, fail: FailReason | null, context: Context): Words {
  const t = useTranslations("cosign.states");
  const root = useTranslations("cosign");
  const view = model.view;
  const tone = TONES[view];
  switch (view) {
    case "loading":
      return { tone, kicker: t("loading.kicker"), headline: t("loading.headline"), line: t("loading.line") };
    case "notFound":
      return {
        tone,
        kicker: t("notFound.kicker"),
        headline: t("notFound.headline"),
        line: t("notFound.line"),
        note: t("notFound.note"),
      };
    case "signIn":
      return {
        tone,
        kicker: t("signIn.kicker"),
        headline: t("signIn.headline"),
        line: t("signIn.line"),
        primary: t("signIn.primary"),
        note: t("signIn.note"),
      };
    case "makePasskey":
      return {
        tone,
        kicker: t("makePasskey.kicker"),
        headline: t("makePasskey.headline"),
        line: t("makePasskey.line"),
        primary: t("makePasskey.primary"),
        note: t("makePasskey.note"),
      };
    case "passkeyElsewhere":
      return {
        tone,
        kicker: t("passkeyElsewhere.kicker"),
        headline: t("passkeyElsewhere.headline"),
        line: t("passkeyElsewhere.line"),
        primary: t("passkeyElsewhere.primary"),
        secondary: t("passkeyElsewhere.secondary"),
      };
    case "wrongWallet":
      return {
        tone,
        kicker: t("wrongWallet.kicker"),
        headline: t("wrongWallet.headline"),
        line: t("wrongWallet.line", { wallet: context.wallet }),
        secondary: t("wrongWallet.secondary"),
        note: t("wrongWallet.note", { platform: context.platform }),
      };
    case "waitingAgent":
      return {
        tone,
        kicker: t("waitingAgent.kicker"),
        headline: t("waitingAgent.headline", { agent: context.agent }),
        line: t("waitingAgent.line"),
        note: t("waitingAgent.note"),
      };
    case "ready":
      if (model.gate.at !== "passed") {
        return {
          tone: "wait",
          kicker: t("checking.kicker"),
          headline: t("checking.headline"),
          line: t("checking.line"),
          primary: t("checking.primary"),
        };
      }
      return {
        tone,
        kicker: t("ready.kicker"),
        headline: t("ready.headline"),
        line: t("ready.line"),
        primary: t("ready.primary"),
        note: t("ready.note"),
      };
    case "signing":
      return {
        tone,
        kicker: t("signing.kicker"),
        headline:
          model.send.at === "sending"
            ? t("signing.headlineSending")
            : model.send.at === "confirming"
              ? t("signing.headlineConfirming")
              : t("signing.headline"),
        line: t("signing.line"),
      };
    case "registered":
      return {
        tone,
        kicker: t("registered.kicker"),
        headline: t("registered.headline"),
        line: t("registered.line", { agent: context.agent }),
        primary: t("registered.primary"),
        secondary: model.terms.at === "failed" || model.terms.at === "offered" ? root("termsLine.again") : undefined,
      };
    case "expired":
      return {
        tone,
        kicker: t("expired.kicker"),
        headline: context.time === null ? t("expired.headlinePlain") : t("expired.headline", { time: context.time }),
        line: t("expired.line"),
        note: t("expired.note", { platform: context.platform }),
      };
    case "failed":
      switch (fail ?? "mismatch") {
        case "taken":
          return {
            tone,
            kicker: t("failed.taken.kicker"),
            headline: t("failed.taken.headline"),
            line:
              context.holder === null
                ? t("failed.taken.linePlain")
                : t("failed.taken.line", { holder: context.holder }),
            primary: t("failed.taken.primary"),
            note: t("failed.taken.note", { platform: context.platform }),
          };
        case "refused":
          return {
            tone,
            kicker: t("failed.refused.kicker"),
            headline: t("failed.refused.headline"),
            line: t("failed.refused.line"),
            note: t("failed.refused.note", { platform: context.platform }),
          };
        case "unavailable":
          return {
            tone,
            kicker: t("failed.unavailable.kicker"),
            headline: t("failed.unavailable.headline"),
            line: t("failed.unavailable.line"),
            primary: t("failed.unavailable.primary"),
          };
        case "unconfirmed":
          return {
            tone: "wait",
            kicker: t("failed.unconfirmed.kicker"),
            headline: t("failed.unconfirmed.headline"),
            line: t("failed.unconfirmed.line"),
            primary: t("failed.unconfirmed.primary"),
          };
        case "mismatch":
          return {
            tone,
            kicker: t("failed.mismatch.kicker"),
            headline: t("failed.mismatch.headline"),
            line: t("failed.mismatch.line"),
            note: t("failed.mismatch.note", { platform: context.platform }),
          };
      }
  }
}

export interface CosignSheetProps {
  model: CosignModel;
  /** The account's own MON, read once Privy refused to pay a fee. Null until then. */
  balance?: bigint | null;
  agent: AgentFacts | null;
  /** The signed-in wallet, checksummed. */
  wallet: Hex | null;
  onPress: (press: Press) => void;
  /** True once the page has told its opener the passport landed, which a checkout window waits for before it shuts. */
  reported?: boolean;
  /** Draws the checkout window whatever the window is. Left out, the window itself decides. */
  checkout?: boolean;
}

/**
 * Drawing E, the sheet with the stamp, as Ram picked it on the lab page: the
 * print pinned on the left with the kolam seal landing on it once the passport
 * is registered, and six numbered clauses on the right, each with one label
 * that says how far Moolam vouches for what is under it. On a phone the print
 * comes first at full width, then the title, the clauses and the button. In
 * a small window a platform opened, the same model draws as CosignCheckout.
 *
 * Every word is the person's own language and every fact is the record's:
 * before the picture is pinned the print is an empty frame and a waiting line,
 * never a stand-in picture.
 */
export function CosignSheet({ model, agent, wallet, balance = null, onPress, reported = false, checkout }: CosignSheetProps) {
  const t = useTranslations("cosign");
  const inWindow = useCheckoutWindow();
  const compact = checkout ?? inWindow;
  const closing = useCloseWhenDone(compact, cosignFinished(model, reported));
  const reduced = useIsReducedMotion();
  const page = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: page, offset: ["start end", "end start"] });
  const drift = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [50, -50]);

  const view = model.view;
  const fail = failReason(model);
  const record = model.record;
  const exactHash = record?.exactHash ?? model.named?.exactHash ?? null;
  const agentId = record?.agentId ?? model.named?.agentId ?? null;
  const deadline = record?.passport.deadline === undefined ? null : Number(record.passport.deadline);
  const standing = standingOf(agent);
  const platform = standing === "listed" && agent?.listing !== null && agent?.listing !== undefined ? agent.listing.name : t("sender");
  const words = useWords(model, fail, {
    platform,
    agent: agentId ?? "",
    wallet: wallet === null ? "" : shortAddress(wallet),
    time: deadline === null ? null : chainClock(deadline),
    holder: model.taken?.holder === null || model.taken === null ? null : shortAddress(model.taken.holder),
  });
  const signedOut = view === "signIn" || view === "loading" || view === "notFound";
  const title = model.drawn?.title ?? null;
  const passportId = model.send.at === "registered" ? model.send.passportId : null;
  const digest = model.gate.at === "passed" ? model.gate.digest : null;

  const kicker =
    exactHash === null
      ? t("kickerSignedOut")
      : standing === "listed"
        ? t("kickerNamed", { platform, id: shortAddress(exactHash) })
        : t("kickerPlain", { id: shortAddress(exactHash) });

  const pending = <p className="text-base leading-relaxed text-text-muted">{t("signedOut")}</p>;
  const clauses: Clause[] = [
    {
      key: "picture",
      label: t("clauses.picture.label"),
      mark: "none",
      body:
        exactHash === null ? (
          pending
        ) : (
          <>
            <p className="text-base leading-relaxed text-text">{t("clauses.picture.body")}</p>
            <p className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-text-muted">
              {t("clauses.picture.hash", { hash: exactHash })}
            </p>
          </>
        ),
    },
    {
      key: "agent",
      label: t("clauses.agent.label"),
      mark: "dashed",
      body: agentId === null ? pending : <AgentFact agentId={agentId} facts={agent} />,
    },
    {
      key: "platform",
      label: agent === null ? t("clauses.platform.label") : t(`clauses.platform.${standing}`),
      mark: agent !== null && standing === "listed" ? "solid" : "none",
      body:
        agentId === null ? (
          pending
        ) : agent === null ? (
          <p className="text-base leading-relaxed text-text-muted">{t("clauses.platform.reading")}</p>
        ) : (
          <PlatformFact agentId={agentId} facts={agent} />
        ),
    },
    {
      key: "terms",
      label: t("clauses.terms.label"),
      mark: "none",
      body: signedOut ? (
        pending
      ) : model.drawn === null ? (
        <p className="text-base leading-relaxed text-text-muted">{t("clauses.terms.pending")}</p>
      ) : (
        <TermsFact terms={model.drawn.terms} />
      ),
    },
    {
      key: "creator",
      label: t("clauses.creator.label"),
      mark: "none",
      body:
        view === "wrongWallet" ? (
          <p className="text-base leading-relaxed text-text">{t("clauses.creator.other")}</p>
        ) : signedOut || wallet === null ? (
          <p className="text-base leading-relaxed text-text">{t("clauses.creator.unset")}</p>
        ) : (
          <>
            <p className="text-base leading-relaxed text-text">{t("clauses.creator.set")}</p>
            <p className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-text-muted">{wallet}</p>
          </>
        ),
    },
    {
      key: "until",
      label: t("clauses.until.label"),
      mark: "none",
      body: (
        <p className="text-base leading-relaxed text-text">
          {deadline === null ? t("clauses.until.unset") : t("clauses.until.body", { time: chainClock(deadline) })}
        </p>
      ),
    },
  ];

  const printLine =
    view === "signIn" || view === "loading"
      ? t("print.signedOut")
      : model.gate.at === "failed" && (model.gate.what === "picture" || model.gate.what === "metadata")
        ? t("print.withheld")
        : view === "notFound" || view === "wrongWallet" || view === "expired" || view === "failed"
          ? t("print.none")
          : t("print.waiting");

  if (compact) {
    return (
      <CosignCheckout
        pageRef={page}
        model={model}
        agent={agent}
        wallet={wallet}
        balance={balance}
        onPress={onPress}
        words={words}
        clauses={clauses}
        kicker={kicker}
        title={title}
        printLine={printLine}
        platform={standing === "listed" ? platform : null}
        closing={closing}
      />
    );
  }

  return (
    <article
      ref={page}
      data-cosign-state={view}
      data-fail={fail ?? undefined}
      className="@container relative bg-bg text-text"
    >
      <div className="grid grid-cols-[minmax(0,1fr)] @5xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="relative border-b border-line bg-bg-sunken @5xl:border-b-0 @5xl:border-e">
          <div
            data-stamp-stage
            className="@container/stage grain relative isolate flex items-center justify-center overflow-clip px-5 pb-14 pt-[18cqw] @5xl:sticky @5xl:top-[var(--header-h)] @5xl:h-[calc(100svh-var(--header-h))] @5xl:min-h-[38rem] @5xl:px-6 @5xl:py-12"
          >
            <motion.div aria-hidden style={{ y: drift }} className="pointer-events-none absolute -inset-y-12 inset-x-0 -z-10">
              {agent === null || agent.field.length === 0
                ? null
                : FIELD.map((plate, index) => (
                    <span
                      key={index}
                      className="absolute overflow-hidden border border-line [.light_&]:mix-blend-multiply"
                      style={{
                        left: `${plate.left}%`,
                        top: `${plate.top}%`,
                        width: `${plate.size * 1.6}%`,
                        aspectRatio: "1",
                        opacity: 0.1 + plate.depth * 0.2,
                        filter: plate.depth < 0.4 ? "blur(2px)" : undefined,
                        transform: `rotate(${plate.turn}deg)`,
                      }}
                    >
                      <Picture
                        sources={pictureSources(agent.field[index % agent.field.length])}
                        sizes="120px"
                        className="object-cover"
                      />
                    </span>
                  ))}
              <span className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_48%,var(--accent-soft),transparent_65%)]" />
            </motion.div>

            <OutlineWord word={t("outline")} />

            <div className="relative w-full -rotate-[1.5deg] @lg/stage:w-[78%] @lg/stage:max-w-[30rem] @lg/stage:-rotate-3">
              <motion.figure
                initial={reduced ? false : { opacity: 0, y: 36 }}
                animate={{ opacity: 1, y: 0 }}
                transition={reduced ? { duration: 0 } : { duration: 1.1, ease: EASE }}
                className="relative bg-bg-raised p-2.5 shadow-[0_60px_120px_-50px_rgba(0,0,0,0.85)] ring-1 ring-line-strong @lg/stage:p-4"
              >
                <div data-print className="grain relative aspect-square overflow-hidden bg-bg">
                  {model.drawn === null ? (
                    <div className="absolute inset-0 flex items-end border border-dashed border-line-strong p-5">
                      <p
                        data-print-waiting
                        className="max-w-[26ch] font-mono text-[11px] uppercase leading-relaxed tracking-[0.18em] text-text-faint"
                      >
                        {printLine}
                      </p>
                    </div>
                  ) : (
                    <img
                      src={model.drawn.picture}
                      alt={title ?? t("untitled")}
                      className="absolute inset-0 h-full w-full object-contain"
                    />
                  )}
                </div>
                <figcaption className="mt-2.5 flex items-baseline justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint @lg/stage:mt-3">
                  <span className="min-w-0 truncate">{title ?? t("untitled")}</span>
                  {agentId === null ? null : (
                    <span className="hidden shrink-0 @lg/stage:inline">{t("caption.agent", { id: agentId })}</span>
                  )}
                </figcaption>
              </motion.figure>

              <div className="absolute -bottom-8 -end-3 h-24 w-24 @lg/stage:-bottom-12 @lg/stage:-end-10 @lg/stage:h-40 @lg/stage:w-40">
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
            </div>
          </div>
        </div>

        <div className="min-w-0 px-5 py-9 @3xl:px-10 @3xl:py-12 @6xl:px-14">
          <motion.p
            initial={reduced ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.6, ease: EASE }}
            className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent"
          >
            <span className="motif h-[10px] w-[10px]" />
            <span className="min-w-0 truncate">{kicker}</span>
          </motion.p>
          <motion.h1
            initial={reduced ? false : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.8, ease: EASE, delay: 0.06 }}
            className="mt-4 max-w-[16ch] break-words font-display text-[clamp(2.2rem,4.8cqw,4.4rem)] font-semibold uppercase leading-[0.92] tracking-[-0.045em]"
          >
            {title ?? t("untitled")}
          </motion.h1>

          {view === "notFound" ? null : (
            <>
              <h2 className="mt-8 font-display text-[clamp(1.25rem,1.9cqw,1.7rem)] font-semibold leading-tight tracking-[-0.02em] text-text-muted">
                {t("heading")}
              </h2>
              <ol className="mt-5 border-t border-line-strong">
                {clauses.map((clause, index) => (
                  <motion.li
                    key={clause.key}
                    data-clause={clause.key}
                    initial={reduced ? false : { opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={reduced ? { duration: 0 } : { duration: 0.55, ease: EASE, delay: 0.05 * index }}
                    className="grid grid-cols-[3.2rem_minmax(0,1fr)] gap-x-4 border-b border-line py-5 @3xl:grid-cols-[4.5rem_minmax(0,1fr)] @3xl:gap-x-6"
                  >
                    <span
                      aria-hidden
                      className="font-display text-[2.4rem] font-semibold leading-[0.85] tracking-[-0.06em] text-transparent [-webkit-text-stroke:1px_var(--accent)] @3xl:text-[3.2rem]"
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0">
                      <p className="mb-2.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
                        {clause.mark === "solid" ? <span aria-hidden className="motif h-[8px] w-[8px]" /> : null}
                        {clause.mark === "dashed" ? (
                          <span aria-hidden className="h-[8px] w-[8px] border border-dashed border-text-muted" />
                        ) : null}
                        {clause.label}
                      </p>
                      {clause.body}
                    </div>
                  </motion.li>
                ))}
              </ol>
            </>
          )}

          <div className="relative mt-10">
            <StateSwap state={`${view}-${fail ?? ""}-${model.gate.at}`}>
              <Kicker tone={words.tone}>{words.kicker}</Kicker>
              <h2 className="mt-4 max-w-[24ch] font-display text-[clamp(1.5rem,2.6cqw,2.2rem)] font-semibold leading-[1.04] tracking-[-0.03em]">
                {words.headline}
              </h2>
              <StateLine tone={words.tone} className="mt-3 max-w-[58ch]">
                {words.line}
              </StateLine>
              <div className="mt-5 empty:hidden">
                <Extras model={model} />
              </div>
              {words.note === undefined ? null : (
                <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-text-faint">{words.note}</p>
              )}
            </StateSwap>

            <Actions model={model} words={words} exactHash={exactHash} onPress={onPress} />
            <Progress model={model} balance={balance} onPress={onPress} />
            {view === "notFound" ? null : (
            <div className="mt-3 flex items-center gap-4 border-t border-line-strong pt-2.5">
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
                {t("signHere")}
              </span>
              <span className="min-w-0 truncate font-mono text-[10px] tracking-[0.06em] text-text-faint" title={digest ?? undefined}>
                {digest === null ? t("passkeyWaits") : t("passkeySigns", { digest: shortAddress(digest) })}
              </span>
            </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** The outline word's share of the stage's width once it has been fitted. */
const OUTLINE_SHARE = 0.94;
/** Its full size, in the stage's width units, which a short word like "Co-sign" keeps. */
const OUTLINE_SIZE = 22;

/**
 * How much to scale the outline word so it sits whole in its column. Both widths
 * in the same unit; a word that already fits keeps its full size.
 */
export function outlineFit(natural: number, available: number): number {
  if (!(natural > 0) || !(available > 0)) return 1;
  return Math.min(1, available / natural);
}

/** Only Latin letters take the tight poster tracking; it runs Devanagari and Tamil strokes into each other. */
export function tracksTight(word: string): boolean {
  return /^[\p{Script=Latin}\p{P}\p{Zs}]+$/u.test(word);
}

/**
 * The giant outline word behind the print. "Co-sign" fits the stage at a fifth of
 * its width, but the same word in Tamil or German runs three times as long, and a
 * fixed size cut it mid-letter. So the browser measures the word once its fonts
 * are in and shrinks it to the column; until then it stays unseen, so a long word
 * never flashes at full size first.
 */
function OutlineWord({ word }: { word: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [fit, setFit] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    const stage = node?.parentElement;
    if (!node || !stage) return;
    let live = true;
    const measure = () => {
      if (!live) return;
      const drawn = parseFloat(getComputedStyle(node).fontSize);
      const full = (stage.clientWidth * OUTLINE_SIZE) / 100;
      if (!(drawn > 0) || !(full > 0)) return;
      const range = document.createRange();
      // An engine without Range geometry keeps the word at its CSS size rather than failing the page.
      if (typeof range.getBoundingClientRect !== "function") return;
      range.selectNodeContents(node);
      const natural = (range.getBoundingClientRect().width * full) / drawn;
      setFit(outlineFit(natural, stage.clientWidth * OUTLINE_SHARE));
    };
    measure();
    // Without ResizeObserver the word still refits when the window changes size.
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (watch === null) {
      window.addEventListener("resize", measure);
    } else {
      watch.observe(stage);
    }
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
      if (watch === null) {
        window.removeEventListener("resize", measure);
      } else {
        watch.disconnect();
      }
    };
  }, [word]);

  const scale = fit ?? 1;
  return (
    <p
      ref={ref}
      aria-hidden
      data-outline-word
      style={{ fontSize: `calc(${OUTLINE_SIZE}cqw * ${scale})`, insetInlineStart: `calc(-3cqw * ${scale})` }}
      className={`pointer-events-none absolute top-[2cqw] -z-10 select-none whitespace-nowrap font-display font-semibold uppercase leading-[0.8] text-transparent transition-opacity duration-700 motion-reduce:transition-none [-webkit-text-stroke:1px_var(--accent)] ${
        tracksTight(word) ? "tracking-[-0.07em]" : "tracking-normal"
      } ${fit === null ? "opacity-0" : "opacity-60"}`}
    >
      {word}
    </p>
  );
}
