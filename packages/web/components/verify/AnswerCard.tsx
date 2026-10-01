"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { reason as oneLine, shortHex } from "@/lib/chain/client";
import { ConsentStamp } from "@/components/consent/ConsentStamp";
import { withoutDoubleStop } from "@/lib/i18n/sentence";
import { pictureSources } from "@/lib/images";
import { Mono } from "@/components/passport/Mono";
import { Picture } from "@/components/passport/Picture";
import { sealedBits } from "@/components/passport/sealed";
import { SealedSketch } from "@/components/sealed/Sketch";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import { RecheckRequest } from "@/components/passport/RecheckRequest";
import { WarningMark } from "@/components/WarningMark";
import { plainStatement } from "@/lib/chain/consent";
import type { MatchConsent } from "@/lib/verifier/client";
import { CompareSlider } from "./CompareSlider";
import { DisputeLine } from "./DisputeLine";
import { StaleIndex } from "./StaleIndex";
import { SecondOpinion, hasSecondOpinion } from "./SecondOpinion";
import { ShareAnswer } from "./ShareAnswer";
import { agentChipId, daysLater, percent, upheldAncestor, type Answer, type Problem } from "./answer";
import type { FirstRegistration, MatchedPassport } from "./lookup";

/** What the card is showing right now. The first two are its front, the last two its back. */
export type Stage =
  | { kind: "idle" }
  | { kind: "checking"; name: string }
  | {
      kind: "answer";
      answer: Answer;
      passport: MatchedPassport | null;
      /** The earlier registration the answer leads with, when the service named one and the registry handed it over. */
      first?: FirstRegistration | null;
    }
  | { kind: "problem"; problem: Problem };

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The answer, on a card that turns over.
 *
 * A verify run takes a few seconds, so the wait is a face of its own with an
 * honest label on it, and the result arrives by turning the card rather than by
 * swapping text in place. Anyone who has asked for less motion gets a fade
 * between the same two faces.
 */
export function AnswerCard({
  stage,
  copy,
  sampleId,
  onCheckAgain,
  onChooseAnother,
}: {
  stage: Stage;
  /**
   * The reader's own file as a blob address, handed over only when the answer
   * is about a file they chose, dropped or pasted. On a match it turns the
   * picture into a wipe between their copy and the registered one.
   */
  copy?: string;
  /** The offered picture this answer is about, which gives the answer a link of its own. */
  sampleId?: string;
  /** Sends the file still in hand again, offered on a failed check. */
  onCheckAgain?: () => void;
  /**
   * Opens the page's own file chooser for the next check. A phone scrolls the
   * answer up to meet the reader, so the way to the next picture is put under
   * the verdict rather than two screens down at the card's foot.
   */
  onChooseAnother?: () => void;
}) {
  const reduced = useIsReducedMotion();
  const flipped = stage.kind === "answer" || stage.kind === "problem";

  return (
    <div style={{ perspective: 2000 }} className="w-full">
      <motion.div
        animate={reduced ? {} : { rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.95, ease: EASE }}
        style={{ transformStyle: "preserve-3d", display: "grid" }}
        className="w-full"
      >
        <motion.div
          animate={reduced ? { opacity: flipped ? 0 : 1 } : {}}
          transition={{ duration: 0.3 }}
          style={{ gridArea: "1 / 1", backfaceVisibility: "hidden", pointerEvents: flipped ? "none" : "auto" }}
        >
          {stage.kind === "checking" ? <Checking name={stage.name} /> : <Idle />}
        </motion.div>

        <motion.div
          animate={reduced ? { opacity: flipped ? 1 : 0 } : {}}
          transition={{ duration: 0.3 }}
          style={{
            gridArea: "1 / 1",
            backfaceVisibility: "hidden",
            transform: reduced ? undefined : "rotateY(180deg)",
            pointerEvents: flipped ? "auto" : "none",
          }}
        >
          {stage.kind === "problem" ? (
            <Refused problem={stage.problem} onCheckAgain={onCheckAgain} />
          ) : stage.kind === "answer" ? (
            <Result
              answer={stage.answer}
              passport={stage.passport}
              first={stage.first ?? null}
              copy={copy}
              sampleId={sampleId}
              onChooseAnother={onChooseAnother}
            />
          ) : (
            <Plate />
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}

function Plate({ children, tone = "line" }: { children?: React.ReactNode; tone?: "line" | "verified" | "failed" }) {
  const edge = tone === "verified" ? "border-verified/40" : tone === "failed" ? "border-failed/40" : "border-line";
  return (
    <section className={`grain relative min-h-[24rem] overflow-hidden border ${edge} bg-bg-raised`}>{children}</section>
  );
}

function Idle() {
  const t = useTranslations("verify");
  const steps = ["fingerprint", "rotate", "search"] as const;

  return (
    <Plate>
      <div className="p-7 sm:p-9">
        <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-text-faint">
          <span className="motif h-[9px] w-[9px] opacity-40" />
          {t("idleHeading")}
        </p>
        <p className="mt-5 max-w-[30ch] font-display text-[clamp(1.4rem,2.4vw,2rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-text-muted">
          {t("idleBody")}
        </p>

        <ol className="mt-9 border-t border-line">
          {steps.map((step, index) => (
            <li key={step} className="flex items-start gap-5 border-b border-line py-4">
              <span className="mt-0.5 font-mono text-[11px] tabular-nums text-text-faint">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-base leading-relaxed text-text-muted">{t(`steps.${step}`)}</span>
            </li>
          ))}
        </ol>
      </div>
    </Plate>
  );
}

/** After this long a check is slower than the service's usual one to four seconds, and the card says so. */
export const SLOW_AFTER_SECONDS = 10;

/**
 * Whole seconds since the component mounted, read off the clock on every tick
 * rather than counted, so a tab the browser slowed down in the background still
 * shows the true wait when the reader comes back to it.
 */
function useSecondsWaited(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, []);
  return seconds;
}

/**
 * The wait, as it happens.
 *
 * The three steps are what the verify service does with every file, listed as
 * a plain description and never ticked off: the page sends one request and
 * gets one answer, so it cannot see which step the service is on, and a tick
 * on a timer would be a guess dressed as progress. The clock is the one thing
 * the page does know, so it counts, and past ten seconds the card says the
 * check is slow and how long the page will keep waiting.
 */
function Checking({ name }: { name: string }) {
  const t = useTranslations("verify");
  const reduced = useIsReducedMotion();
  const seconds = useSecondsWaited();
  const steps = ["fingerprint", "turns", "search"] as const;

  return (
    <Plate>
      {reduced ? null : (
        <motion.span
          aria-hidden
          initial={{ top: "0%" }}
          animate={{ top: ["0%", "100%"] }}
          transition={{ duration: 1.9, repeat: Infinity, ease: "easeInOut", repeatType: "reverse" }}
          className="pointer-events-none absolute inset-x-0 h-px bg-accent/70"
        />
      )}
      <div className="relative p-7 sm:p-9">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span className="motif h-2 w-2 bg-accent motion-safe:animate-pulse" />
            {t("pending")}
          </p>
          <p
            role="timer"
            data-wait-seconds={seconds}
            className="font-mono text-[11px] uppercase tabular-nums tracking-[0.2em] text-text-muted"
          >
            {t("wait.seconds", { seconds })}
          </p>
        </div>
        <p className="mt-6 max-w-[26ch] font-display text-[clamp(1.6rem,3vw,2.4rem)] font-semibold leading-[1.02] tracking-[-0.035em]">
          {t("checkingHeading")}
        </p>

        <ol data-wait-steps className="mt-7 border-t border-line">
          {steps.map((step, index) => (
            <li key={step} className="flex items-baseline gap-5 border-b border-line py-3.5">
              <span className="font-mono text-[11px] tabular-nums text-accent/80">{String(index + 1).padStart(2, "0")}</span>
              <span className="text-base leading-relaxed text-text-muted">{t(`wait.${step}`)}</span>
            </li>
          ))}
        </ol>

        <div aria-live="polite">
          {seconds >= SLOW_AFTER_SECONDS ? (
            <p data-wait-slow className="mt-5 max-w-[60ch] border-s-2 border-pending/60 ps-4 text-base leading-relaxed text-text">
              {t("wait.slow")}
            </p>
          ) : null}
        </div>
        <p className="mt-7 break-words font-mono text-[11px] text-text-faint">{name}</p>
      </div>
    </Plate>
  );
}

function Result({
  answer,
  passport,
  first,
  copy,
  sampleId,
  onChooseAnother,
}: {
  answer: Answer;
  passport: MatchedPassport | null;
  first: FirstRegistration | null;
  copy?: string;
  sampleId?: string;
  onChooseAnother?: () => void;
}) {
  const t = useTranslations("verify");
  const format = useFormatter();
  const agentId = agentChipId(passport);
  const sealed = passport?.sealed === true;
  const title = passport?.title ?? t("untitled");

  if (answer.kind === "miss") {
    return (
      <Plate tone="failed">
        <div className="p-7 sm:p-9">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-failed">{t("noMatchLabel")}</p>
          <p className="mt-5 max-w-[18ch] font-display text-[clamp(2rem,4.4vw,3.2rem)] font-semibold uppercase leading-[0.92] tracking-[-0.04em]">
            {t("none")}
          </p>
          <ChooseAnother onPress={onChooseAnother} />
          <StaleIndex minutes={answer.staleMinutes} />
          <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-text-muted">{t("noneHint")}</p>

          <Link
            href="/studio"
            className="mt-8 inline-block rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            {t("registerCta")}
          </Link>
          {sampleId === undefined ? null : <div className="mt-4"><ShareAnswer sampleId={sampleId} /></div>}

          <Measured answer={answer} />
        </div>
      </Plate>
    );
  }

  const firstRegisteredId = answer.firstRegisteredId;
  // The lead is drawn only for the passport the service named, read back
  // from the registry. Without it the plain line further down keeps the link.
  const leading = first !== null && firstRegisteredId !== undefined && first.id.toLowerCase() === firstRegisteredId.toLowerCase() ? first : null;
  const inheritedAncestor = upheldAncestor(answer.inheritedDispute);
  const manifestLine =
    answer.manifestCheck === "invalid"
      ? "manifestInvalid"
      : answer.manifestCheck === "unreadable"
        ? "manifestUnreadable"
        : answer.manifest
          ? "manifestPresent"
          : "manifestMissing";

  return (
    <Plate tone="verified">
      <Still passport={passport} exact={answer.kind === "exact"} copy={copy} />

      <div className="p-7 sm:p-9">
        {/* A copy can sit closer to a later registration than to the original.
            When the service names an earlier registration, that one leads:
            who registered this picture first, who holds it, what they allow,
            and then the closest match and how much later it came. */}
        {leading === null ? null : <FirstRegistered first={leading} closest={passport} consent={answer.firstConsent} />}

        {/* The plain answer first, in the same words the passport page's drop
            gives. The confidence and the two distances are the working under it,
            not the verdict. */}
        {/* A title that ends a sentence of its own would otherwise get the
            template's stop after it ("gods.."). */}
        <p className="max-w-[24ch] font-display text-[clamp(1.5rem,3vw,2.3rem)] font-semibold leading-[1.04] tracking-[-0.035em] text-verified">
          {withoutDoubleStop(t(answer.kind === "exact" ? "verdictExact" : "verdict", { title }), title)}
        </p>
        <ChooseAnother onPress={onChooseAnother} />
        <StaleIndex minutes={answer.staleMinutes} />

        <div className="mt-7 flex flex-wrap items-end gap-x-6 gap-y-2">
          <p className="font-display text-[clamp(3.4rem,9vw,6rem)] font-semibold leading-[0.8] tracking-[-0.05em] tabular-nums text-accent">
            {percent(answer.confidence)}
            <span className="ps-1 align-top text-[0.28em] tracking-normal">%</span>
          </p>
          <p className="pb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">{t("confidence")}</p>
        </div>

        {/* A file the service could not decode was matched by its bytes alone. Nothing about
            its look was compared, so there are no distances to print, not zeros. */}
        {answer.pixelsUnread ? (
          <p data-pixels-unread className="mt-8 max-w-[60ch] border-t border-line pt-7 text-base leading-relaxed text-text-muted">
            {t("pixelsUnread")}
          </p>
        ) : (
          <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-line pt-7 sm:grid-cols-3">
            <Readout label={t("phashDistance")} value={t("bits", { count: answer.phashDistance, of: 64 })} />
            <Readout label={t("blockhashDistance")} value={t("bits", { count: answer.blockhashDistance, of: 256 })} />
            <Readout label={t("variant")} value={t(`orientation.${answer.variant}`)} />
          </dl>
        )}

        {answer.others === 0 ? null : (
          <p className="mt-6 max-w-[60ch] text-base leading-relaxed text-text-muted">{t("others", { count: answer.others })}</p>
        )}

        {/* The closest match leads, but a near-copy registered later can sit closer than the
            original. The service always keeps the first registration in the answer, and this is
            where the reader is told it is a different passport from the one on the card. */}
        {firstRegisteredId === undefined || leading !== null ? null : (
          <p data-first-registered className="mt-6 max-w-[60ch] border-s-2 border-accent/50 ps-4 text-base leading-relaxed text-text">
            {t.rich("firstRegistered", {
              link: (chunks) => (
                <Link
                  href={`/passport/${firstRegisteredId}`}
                  className="text-accent underline decoration-accent/40 underline-offset-4 transition-colors duration-200 hover:decoration-accent"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}
        {/* A later copy's holder can say "allowed" over an original whose holder said no. When
            the two statements differ, the first registration's is drawn under the line that names
            it, so the reader sees both words before trusting the one on the card. */}
        {firstRegisteredId === undefined || answer.firstRegisteredConsent === undefined ? null : (
          <div data-first-registered-consent className="mt-3 border-s-2 border-accent/50 ps-4">
            <ConsentStamp consent={answer.firstRegisteredConsent} />
          </div>
        )}
        {answer.laterSameFingerprint === undefined ? null : (
          <p data-later-copies className="mt-3 max-w-[60ch] text-base leading-relaxed text-text-faint">
            {t("laterSameFingerprint", { count: answer.laterSameFingerprint })}
          </p>
        )}

        {/* The match is real and the picture behind it is not there to look at.
            That is said here, right under the verdict, rather than left to the
            reader to work out from an empty frame. */}
        {sealed ? (
          <p className="mt-6 max-w-[60ch] border-s-2 border-accent/50 ps-4 text-base leading-relaxed text-text">
            {t("sealed.matched")}
          </p>
        ) : passport?.unsealedAt === undefined ? null : (
          // The picture is here to look at, and one thing about it is worth
          // saying: it was registered with nothing published and its holder
          // published it later, which is why the copy in hand matches a
          // passport older than the picture's own address.
          <p className="mt-6 max-w-[60ch] border-s-2 border-accent/50 ps-4 text-base leading-relaxed text-text">
            {t("unsealed.matched", { date: format.dateTime(new Date(passport.unsealedAt), { dateStyle: "medium" }) })}
          </p>
        )}

        <p data-manifest-line className="mt-6 max-w-[60ch] text-base leading-relaxed text-text-muted">
          {t(manifestLine)}
        </p>
        {/* Moolam signs with no trusted timestamp, so a certificate that expires later makes the
            C2PA library fail a file nobody touched. The record is still intact, and this line
            says what changed without calling the file tampered. */}
        {answer.manifestCredential === undefined ? null : (
          <p data-manifest-credential className="mt-2 max-w-[60ch] text-base leading-relaxed text-text-faint">
            {t(answer.manifestCredential === "expired" ? "manifestCredentialExpired" : "manifestCredentialUntrusted")}
          </p>
        )}

        {/* Proving the picture is registered is half the answer. This is the
            other half, three facts that are read together: what the holder said
            about AI use, whether anybody has challenged the record that word
            rests on, and what an independent workflow found when it fetched the
            picture and hashed it again. */}
        <ConsentStamp consent={answer.consent} className="mt-8" />
        <DisputeLine dispute={answer.dispute} className="mt-4" />
        {/* The registry marks only the passport a challenge named, so an edit of a picture that
            lost one reads clean on the line above. This is where the reader learns otherwise. */}
        {inheritedAncestor === null ? null : (
          <p data-inherited-dispute className="mt-2 max-w-[60ch] text-base leading-relaxed text-disputed">
            {t.rich("dispute.inherited", {
              link: (chunks) => (
                <Link
                  href={`/passport/${inheritedAncestor}`}
                  className="underline decoration-disputed/40 underline-offset-4 transition-colors duration-200 hover:decoration-disputed"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}
        {/* A re-check works by fetching the registered picture from its own
            address. A sealed passport has none, so the block says that instead
            of reporting a re-check that will never come as "not yet". */}
        {sealed ? (
          <div data-second-opinion className="mt-6 border-s-2 border-line ps-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">{t("recheck.label")}</p>
            <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-text-muted">{t("sealed.recheck")}</p>
          </div>
        ) : hasSecondOpinion(answer.recheck) ? (
          <SecondOpinion recheck={answer.recheck} id={answer.id} standing={passport?.verdict} className="mt-6" />
        ) : (
          // The service could not say what anyone else has found, which is no
          // reason to take away the one thing a reader can do about that.
          <RecheckRequest passportId={answer.id} className="mt-6 border-s-2 border-line ps-5" />
        )}

        {/* Said under every match and never under a miss: a match is the one
            answer a reader might take for more than it is. */}
        <div data-verify-limits className="mt-8 border-s-2 border-line ps-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">{t("limits.label")}</p>
          <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-text-muted">{t("limits.line")}</p>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href={`/passport/${answer.id}`}
            className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            {t("openPassport")}
          </Link>
          {agentId === null ? null : (
            <Link
              href={`/agent/${agentId}`}
              className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("openAgent", { id: agentId })}
            </Link>
          )}
          {sampleId === undefined ? null : <ShareAnswer sampleId={sampleId} />}
        </div>

        <p className="mt-6 font-mono text-[11px] text-text-faint">
          <Mono value={answer.id} />
        </p>
        {passport === null ? <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-text-muted">{t("lookupFailed")}</p> : null}

        <Measured answer={answer} />
      </div>
    </Plate>
  );
}

/**
 * The earlier registration, leading the answer. Its title and date are the
 * line a reader takes away; the holder and the AI-use word are read from the
 * registry and the register beside it, and a fact that did not come back is
 * left out rather than guessed.
 */
function FirstRegistered({
  first,
  closest,
  consent,
}: {
  first: FirstRegistration;
  closest: MatchedPassport | null;
  consent?: MatchConsent;
}) {
  const t = useTranslations("verify");
  const summaries = useTranslations("passport.consent.summary");
  const format = useFormatter();
  const terms =
    consent === undefined || consent.source === "unavailable"
      ? null
      : summaries(consent.stated ? plainStatement(consent) : "none");

  return (
    <motion.div
      data-first-lead
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.35, ease: EASE }}
      className="mb-9 border-b border-line pb-8"
    >
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span aria-hidden className="motif h-[9px] w-[9px]" />
        {t("first.heading")}
      </p>
      <p className="mt-4 max-w-[22ch] font-display text-[clamp(1.6rem,3.4vw,2.6rem)] font-semibold leading-[1.02] tracking-[-0.035em] text-text">
        {t("first.lead", {
          title: first.title ?? t("untitled"),
          date: format.dateTime(new Date(Number(first.registeredAt) * 1000), { dateStyle: "medium" }),
        })}
      </p>
      {first.holder === null && terms === null ? null : (
        <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px] tracking-[0.06em] text-text-muted">
          {first.holder === null ? null : <li data-first-holder>{t("first.held", { holder: shortHex(first.holder) })}</li>}
          {terms === null ? null : <li data-first-terms>{t("first.aiUse", { terms })}</li>}
        </ul>
      )}
      <Link
        href={`/passport/${first.id}`}
        className="mt-6 inline-flex items-center gap-2.5 rounded-[8px] bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
      >
        {t("first.open")}
      </Link>
      {closest === null ? null : (
        <p data-first-closest className="mt-6 max-w-[60ch] text-base leading-relaxed text-text-muted">
          {t("first.closest", { title: closest.title ?? t("untitled"), days: daysLater(first, closest) })}
        </p>
      )}
    </motion.div>
  );
}

/**
 * The matched passport as a film still: the picture, the block hash when the
 * picture was never published, or the seal when IPFS will not hand it over.
 */
function Still({ passport, exact, copy }: { passport: MatchedPassport | null; exact: boolean; copy?: string }) {
  const t = useTranslations("verify");
  const format = useFormatter();
  const kinds = useTranslations("kind");
  const sealed = passport?.sealed === true;

  const seal = (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-3">
      <span className="motif h-5 w-5" />
      <span className="max-w-[28ch] px-6 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
        {t("noPicture")}
      </span>
    </span>
  );

  // The reader's own file against the registered picture, when there is one of
  // each to lay side by side. A sample press sent the registered file itself,
  // so both sides would be the same picture, and it never gets here.
  if (copy !== undefined && !sealed && passport?.thumbnailUrl !== undefined) {
    return (
      <CompareSlider
        copy={copy}
        registered={passport.thumbnailUrl}
        title={passport.title ?? t("untitled")}
        fallback={seal}
      />
    );
  }

  return (
    <div className="grain relative aspect-[16/9] overflow-hidden border-b border-line bg-bg-sunken">
      {sealed ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span
            aria-hidden
            className="pointer-events-none absolute h-[120%] w-[45%] rounded-full bg-accent-soft blur-[60px]"
          />
          <SealedSketch bits={sealedBits(passport?.blockhash256)} size="plate" className="relative h-[78%]" />
        </span>
      ) : passport?.thumbnailUrl === undefined ? (
        seal
      ) : (
        // The pinned copy of the registered image, read back through the
        // optimizer so a second look at the same record costs no gateway read.
        <Picture
          sources={pictureSources(passport.thumbnailUrl)}
          sizes="(min-width: 1024px) 46vw, 100vw"
          className="object-cover"
          fallback={seal}
        />
      )}
      <div className="scrim pointer-events-none absolute inset-0" />

      {/* Straight on the photo the green kicker could not be read over a busy
          picture. It sits on a plate of the page's own ground, solid because the
          light theme's green fell to 4.2:1 through a see-through plate over a
          dark sky, and on the plate it reads in both themes over any picture. */}
      <p
        data-still-kicker
        className="absolute start-3 top-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-4 gap-y-1 rounded-[8px] bg-bg px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-verified"
      >
        <span className="flex items-center gap-3">
          <span className="motif h-[9px] w-[9px]" />
          {exact ? t("exact") : t("matched")}
        </span>
        {sealed ? <span className="text-accent">{t("sealed.label")}</span> : null}
      </p>

      {passport === null ? null : (
        <div className="absolute inset-x-0 bottom-0 p-5">
          <p className="max-w-[28ch] font-display text-[clamp(1.2rem,2.4vw,1.9rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
            {passport.title ?? t("untitled")}
          </p>
          {/* Three pieces in a gapped row, so the slash sits evenly between the
              kind and the date and a line break never strands it. */}
          <p data-still-meta className="mt-2 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-text-faint">
            <span>{kinds(String(passport.kind))}</span>
            <span aria-hidden>/</span>
            <span>{format.dateTime(new Date(Number(passport.registeredAt) * 1000), { dateStyle: "medium" })}</span>
          </p>
        </div>
      )}
    </div>
  );
}

/** What the service measured on the file it was handed. Proof the run really happened. */
function Measured({ answer }: { answer: Answer }) {
  const t = useTranslations("verify");
  const { queried } = answer;

  return (
    <div className="mt-10 border-t border-line pt-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">{t("measured")}</p>
      <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-5">
        {queried.phash === undefined ? (
          <Readout label={t("queriedSha")} value={shortHex(queried.sha256, 10, 8)} hex />
        ) : (
          <>
            <Readout label={t("queriedSize")} value={`${queried.width} x ${queried.height} ${queried.format}`} />
            <Readout label={t("queriedPhash")} value={queried.phash} hex />
            <Readout label={t("queriedSha")} value={shortHex(queried.sha256, 10, 8)} hex />
            <Readout label={t("queriedBlockhash")} value={shortHex(queried.blockhash, 10, 8)} hex />
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * The next check, under the verdict, on a phone only: a wide screen has the
 * card beside the picture and its own Choose another there. Set in the same
 * quiet outline as the Choose another over the picture, so it never outshouts
 * the answer it sits under.
 */
function ChooseAnother({ onPress }: { onPress?: () => void }) {
  const t = useTranslations("verify");

  if (onPress === undefined) {
    return null;
  }
  return (
    <button
      type="button"
      data-choose-near
      onClick={onPress}
      className="tap mt-5 rounded-[8px] border border-line-strong bg-bg/70 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent lg:hidden"
    >
      {t("replace")}
    </button>
  );
}

function Refused({ problem, onCheckAgain }: { problem: Problem; onCheckAgain?: () => void }) {
  const t = useTranslations("verify");
  const common = useTranslations("common");

  return (
    <Plate tone="failed">
      <div className="p-7 sm:p-9">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-failed">{t("problemLabel")}</p>
        <p
          data-failure-line
          className="mt-5 flex max-w-[28ch] items-start gap-3 font-display text-[clamp(1.5rem,2.8vw,2.2rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-failed"
        >
          <WarningMark className="mt-[0.14em] h-[0.8em] w-[0.8em]" />
          <span>{t(problem.key)}</span>
        </p>

        {onCheckAgain === undefined ? null : (
          <button
            type="button"
            data-check-again
            onClick={onCheckAgain}
            className="mt-8 rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            {t("checkAgain")}
          </button>
        )}

        {/* The service's or the browser's own words, kept for anyone who reports
            the fault, and closed so they never read as the answer. They are
            untranslated, cut to their first line with every address taken
            out, the way the studio's Details are. */}
        {problem.reason === undefined ? null : (
          <details data-failure-details className="group mt-7 border-t border-line pt-4">
            <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint transition-colors duration-200 hover:text-text [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="me-2 inline-block transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none">
                &rsaquo;
              </span>
              {common("details")}
            </summary>
            <p className="mt-3 max-w-[46ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
              {oneLine(problem.reason)}
            </p>
          </details>
        )}
      </div>
    </Plate>
  );
}

/**
 * One measured fact. A hex value may break anywhere, in groups, so it never
 * pushes the card wider than its column; everything else is words, and words
 * wrap at their spaces. Before the split "0 of 64 bits apart" was set as a
 * hash and broke as "a / part" on a phone.
 */
function Readout({ label, value, hex = false }: { label: string; value: string; hex?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="mt-1.5 text-sm text-text">
        {hex ? <Mono value={value} /> : <span data-readout-words className="font-mono break-words">{value}</span>}
      </dd>
    </div>
  );
}
