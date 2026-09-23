"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { MONAD_EXPLORER, gatewayUrl, shortHex } from "@/lib/chain/client";
import { plainStatement } from "@/lib/chain/consent";
import { feeInMon } from "@/lib/chain/fee";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import type { SealedHandback } from "@/lib/sealed/handback";
import { useSealedSave } from "@/lib/sealed/save";
import type { Studio } from "@/lib/studio/useStudio";

interface Mark {
  key: string;
  label: string;
  /** Left out on a stamp whose whole fact is its label, such as a private copy with no public address. */
  value?: string;
  detail?: string;
  href?: string;
  tone?: "accent" | "verified";
  /** The one figure on this mark worth reading from across the room. */
  big?: { caption: string; value: string; unit: string };
  /** Extra lines under the detail, each one something this run measured. */
  lines?: string[];
  /** The one thing a reader can do about this stamp, on the few that have anything. */
  action?: { label: string; onClick: () => void };
}

/**
 * The stub. Every fact the studio has actually established, stamped in the
 * order it happened, so a creator can see what was done in their name and a
 * judge can read the whole run without opening a console.
 */
export function Receipt({ studio }: { studio: Studio }) {
  const t = useTranslations("studio");
  const mine = useTranslations("mine");
  const words = useTranslations("passport.consent");
  const format = useFormatter();
  const reduced = useIsReducedMotion();
  const file = studio.register.sealed.file;
  // Reached through the studio rather than taken off it, the way the statement's
  // own button is: a screen that has not mounted the hook yet has no actions.
  const save = useSealedSave(file, () => studio.actions.saveSealed());
  const marks = collect(studio, t, words, format, file, save);

  return (
    /* The stub is part of the one box now, so its tear is a horizontal line
       across the top of it with a notch punched at each end, rather than the
       vertical rule it used to hang off beside a second column. */
    <aside data-studio-receipt className="relative mt-10 border-t border-dashed border-line-strong pt-10">
      <span
        aria-hidden
        className="pointer-events-none absolute -top-3 -start-3 h-6 w-6 rounded-full border border-line bg-bg"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -top-3 -end-3 h-6 w-6 rounded-full border border-line bg-bg"
      />

      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-text-faint">{t("receipt.heading")}</p>
      <p className="mt-3 max-w-[34ch] text-sm leading-relaxed text-text-muted">{t("receipt.body")}</p>

      {marks.length === 0 ? (
        <p className="mt-8 max-w-[32ch] text-sm leading-relaxed text-text-faint">{t("receipt.empty")}</p>
      ) : (
        <ol className="mt-8 space-y-3">
          <AnimatePresence initial={false}>
            {marks.map((mark, index) => (
              <motion.li
                key={mark.key}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, rotate: index % 2 === 0 ? -1.4 : 1.2, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
                transition={reduced ? { duration: 0.001 } : { type: "spring", stiffness: 260, damping: 22 }}
                className="border border-line bg-bg-raised p-4"
              >
                <p
                  className={`font-mono text-[10px] uppercase tracking-[0.2em] ${
                    mark.tone === "verified" ? "text-verified" : "text-accent"
                  }`}
                >
                  {mark.label}
                </p>
                {mark.big === undefined ? null : (
                  <>
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {mark.big.caption}
                    </p>
                    <p className="mt-1 font-display text-[clamp(2.4rem,7vw,3.6rem)] font-semibold uppercase leading-[0.86] tracking-[-0.05em] tabular-nums">
                      {mark.big.value}
                      <span className="ms-2 align-top font-mono text-[clamp(0.75rem,1.6vw,1rem)] tracking-[0.06em] text-accent">
                        {mark.big.unit}
                      </span>
                    </p>
                  </>
                )}
                {mark.value === undefined ? null : mark.href === undefined ? (
                  <p className="mt-2 break-all font-mono text-xs text-text">{mark.value}</p>
                ) : (
                  <a
                    href={mark.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block break-all font-mono text-xs text-text underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
                  >
                    {mark.value}
                  </a>
                )}
                {mark.detail === undefined ? null : (
                  <p className="mt-1.5 text-xs leading-relaxed text-text-faint">{mark.detail}</p>
                )}
                {mark.lines === undefined
                  ? null
                  : mark.lines.map((line) => (
                      <p key={line} className="mt-1.5 text-xs leading-relaxed text-text-faint">
                        {line}
                      </p>
                    ))}
                {mark.action === undefined ? null : (
                  <button
                    type="button"
                    onClick={mark.action.onClick}
                    className="mt-3.5 rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
                  >
                    {mark.action.label}
                  </button>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}

      {/* Where this picture went, once it is really on Monad. The panel beside
          this stub offers the passport that was just made; this is the rest of
          them, which until now were only at the foot of the studio. A sealed
          registration gets it too: the picture is not published, the record
          still is. */}
      {studio.register.registeredAt === null ? null : (
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="mt-6 border-t border-line pt-5"
        >
          <Link
            href="/mine"
            className="tap group inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:text-accent"
          >
            {mine("receiptLink")}
            <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
              &rarr;
            </span>
          </Link>
        </motion.div>
      )}
    </aside>
  );
}

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Words = Translate & { has: (key: string) => boolean };
type Format = ReturnType<typeof useFormatter>;

function collect(
  studio: Studio,
  t: Translate,
  words: Words,
  format: Format,
  /** The one copy of a sealed picture, while this browser still holds it, and the control that writes it. */
  file: SealedHandback | null,
  save: () => void,
): Mark[] {
  const marks: Mark[] = [];

  if (studio.authenticated) {
    marks.push({
      key: "account",
      label: t("receipt.account"),
      value: studio.account.value ?? t(`identity.kind${studio.account.kind[0].toUpperCase()}${studio.account.kind.slice(1)}`),
      detail: t("receipt.accountDetail"),
    });
  }

  if (studio.wallet !== undefined) {
    marks.push({
      key: "wallet",
      label: t("receipt.wallet"),
      value: studio.wallet,
      href: `${MONAD_EXPLORER}/address/${studio.wallet}`,
      detail: t("receipt.walletDetail"),
    });
  }

  if (studio.binding.status === "bound" && studio.binding.passkey !== null) {
    marks.push({
      key: "passkey",
      label: t("receipt.passkey"),
      value: shortHex(studio.binding.passkey.qx, 10, 8),
      href: studio.bind.txHash === null ? undefined : `${MONAD_EXPLORER}/tx/${studio.bind.txHash}`,
      detail: t("receipt.passkeyDetail"),
      tone: "verified",
    });
  }

  const prepared = studio.register.prepared;
  if (prepared !== null) {
    const manifest = prepared.manifest.embedded ? t("receipt.manifestYes") : t("receipt.manifestNo");

    if (prepared.sealed === true) {
      // No pixels were measured here to quote: the fingerprint was taken from
      // the file this browser is holding, which is the whole point.
      marks.push({
        key: "fingerprint",
        label: t("receipt.fingerprint"),
        value: prepared.passport.exactHash,
        detail: t("sealed.receipt.fingerprintDetail", { manifest }),
      });
      // Where the public record went, and the one control that matters on this
      // screen: the file itself, again, for as long as the page is open.
      marks.push({
        key: "sealed",
        label: t("sealed.receipt.label"),
        value: prepared.metadata.cid,
        href: gatewayUrl(prepared.metadata.uri),
        detail: t("sealed.receipt.detail"),
        lines: file === null ? undefined : [t("sealed.handback.only")],
        action: file === null ? undefined : { label: t("sealed.handback.save"), onClick: save },
        tone: "verified",
      });
      // Only the service's own answer stamps this. The switch says what was
      // asked for; this says what was kept, and the copy's address is never on
      // screen because it is never public.
      if (prepared.privateRecheck === true) {
        marks.push({
          key: "privateCopy",
          label: t("sealed.receipt.privateLabel"),
          detail: t("sealed.receipt.privateDetail"),
        });
      }
    } else {
      marks.push({
        key: "fingerprint",
        label: t("receipt.fingerprint"),
        value: prepared.passport.exactHash,
        detail: t("receipt.fingerprintDetail", {
          width: prepared.image.width,
          height: prepared.image.height,
          manifest,
        }),
      });
      marks.push({
        key: "pinned",
        label: t("receipt.pinned"),
        value: prepared.image.cid,
        href: gatewayUrl(prepared.image.uri),
        detail: t("receipt.pinnedDetail"),
      });
    }
  }

  if (studio.register.digest !== null) {
    marks.push({
      key: "signed",
      label: t("receipt.signed"),
      value: studio.register.digest,
      detail: t("receipt.signedDetail"),
      tone: "verified",
    });
  }

  const charge = studio.register.charge;
  const fee = charge === null ? null : feeInMon(charge.gasUsed, charge.gasPrice);

  if (studio.register.txHash !== null) {
    marks.push({
      key: "sent",
      label: t("receipt.sent"),
      value: shortHex(studio.register.txHash, 10, 8),
      href: `${MONAD_EXPLORER}/tx/${studio.register.txHash}`,
      detail: studio.register.unsponsored ? t("receipt.sentOwn") : t("receipt.sentSponsored"),
      // What the creator did not pay, from the transaction's own receipt. It is
      // the sponsored send's whole point and it was said nowhere on the screen.
      lines:
        fee === null || studio.register.unsponsored ? undefined : [t("receipt.wouldHaveCost", { fee: monAmount(fee) })],
    });
  }

  if (studio.register.registeredAt !== null) {
    marks.push({
      key: "written",
      label: t("receipt.written"),
      // The block is only named once it is known. A sponsored send that came
      // back without a hash has none until the index catches up.
      value:
        studio.register.block === null
          ? t("receipt.blockPending")
          : t("receipt.blockValue", { block: studio.register.block.toString() }),
      big:
        studio.register.timing === null
          ? undefined
          : {
              caption: t("receipt.confirmedIn"),
              value: format.number(studio.register.timing.waitedMs),
              unit: t("receipt.msUnit"),
            },
      detail: format.dateTime(new Date(studio.register.registeredAt), { dateStyle: "medium", timeStyle: "short" }),
      lines: chainLines(studio, t, fee),
      tone: "verified",
    });
  }

  const said = statementMark(studio, t, words, format);
  if (said !== null) {
    marks.push(said);
  }

  return marks;
}

/**
 * What the creator said about AI use, and what Monad did with it.
 *
 * The statement is its own write and its own stamp, after the registration's,
 * because that is the order the two things happened in. A statement that never
 * landed says so plainly and offers the one thing worth doing: the passport is
 * registered either way, and the words can still be written from its own page.
 * Silence gets a line too, because a creator should never have to wonder
 * whether saying nothing quietly allowed something.
 */
function statementMark(studio: Studio, t: Translate, words: Words, format: Format): Mark | null {
  const statement = studio.register.statement;
  const registered = studio.register.registeredAt !== null;
  const label = t("consent.receipt.label");
  const again = { label: t("consent.receipt.again"), onClick: () => void studio.actions.stateAgain() };

  if (statement.state === "sending") {
    return {
      key: "statement",
      label,
      value: t("consent.receipt.sending"),
      detail: t("consent.receipt.sendingDetail"),
    };
  }

  if (statement.state === "unconfirmed") {
    return {
      key: "statement",
      label,
      value: t("consent.receipt.pending"),
      detail: t("consent.receipt.pendingDetail"),
      action: { ...again, label: t("consent.receipt.recheck") },
    };
  }

  if (statement.state === "failed") {
    return {
      key: "statement",
      label,
      value: t("consent.receipt.failed"),
      detail: failureLine(statement.failure, words, format),
      lines: [t("consent.receipt.later")],
      action: again,
    };
  }

  if (statement.state === "stated" && statement.sent !== null) {
    const conditions = statement.sent.constraintInfo;
    return {
      key: "statement",
      label,
      value: words(`summary.${plainStatement(statement.sent.consent)}`),
      href: statement.hash === null ? undefined : `${MONAD_EXPLORER}/tx/${statement.hash}`,
      detail:
        statement.waitedMs === null
          ? undefined
          : t("consent.receipt.statedIn", { ms: format.number(statement.waitedMs) }),
      lines: [
        statement.sponsored ? t("consent.receipt.sponsored") : t("consent.receipt.own"),
        ...(conditions.length === 0 ? [] : [t("consent.receipt.conditions", { text: conditions })]),
      ],
      tone: "verified",
    };
  }

  return registered
    ? {
        key: "statement",
        label,
        value: t("consent.receipt.none"),
        detail: t("consent.receipt.noneDetail"),
      }
    : null;
}

/** The register's own reason a statement did not go through, in the reader's language. */
function failureLine(
  failure: Studio["register"]["statement"]["failure"],
  words: Words,
  format: Format,
): string | undefined {
  if (failure === null) {
    return undefined;
  }
  const key = words.has(`failure.${failure.key}`) ? failure.key : "unknown";
  return words(`failure.${key}`, {
    at: failure.at === undefined ? "" : format.dateTime(new Date(failure.at * 1_000), { timeStyle: "short" }),
  });
}

/**
 * What Monad did with this send, in the order a reader cares about it: how long
 * they waited, when the block carrying it was sealed, and what the chain billed
 * for it. Every one of them is measured or read, so a line is missing rather
 * than guessed.
 */
function chainLines(studio: Studio, t: Translate, fee: string | null): string[] | undefined {
  const lines: string[] = [];
  const timing = studio.register.timing;
  const charge = studio.register.charge;

  if (timing !== null) {
    lines.push(t("receipt.confirmedDetail"));
    if (timing.sealedAfterMs !== null) {
      lines.push(
        timing.sealedAfterMs < 1_000
          ? t("receipt.sealedUnderSecond")
          : t("receipt.sealedAfter", { seconds: Math.round(timing.sealedAfterMs / 1_000) }),
      );
    }
  }

  if (charge !== null && fee !== null) {
    const gas = Number(charge.gasUsed);
    lines.push(
      studio.register.unsponsored
        ? t("receipt.billedOwn", { gas, fee: monAmount(fee) })
        : t("receipt.billedSponsored", { gas, fee: monAmount(fee) }),
    );
    lines.push(t("receipt.billedExact", { fee }));
  }

  return lines.length === 0 ? undefined : lines;
}

/**
 * MON at four decimals, which is where the eye stops on a gas figure. A charge
 * too small to show at four decimals is printed whole instead, because a fee
 * that reads as zero is worse than a long one.
 */
function monAmount(exact: string): string {
  const rounded = Number(exact).toFixed(4);
  return Number(rounded) === 0 && Number(exact) > 0 ? exact : rounded;
}
