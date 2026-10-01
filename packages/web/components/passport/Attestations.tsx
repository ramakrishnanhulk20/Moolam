import { getFormatter, getTranslations } from "next-intl/server";
import { BitGrid } from "@/components/BitGrid";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { HEX_MARK, withHex } from "@/components/agents/hex";
import { isPrivateRecheck } from "@/lib/chain/receivers";
import { bitsApart, bitsOf, phashWord } from "@/lib/chain/fingerprint";
import type { Attestation } from "@/lib/chain/registry";
import { heldReportDelivery, type ReportDelivery } from "@/lib/chain/reports";
import type { SealedCopyLookup } from "@/lib/verifier/client";
import { transactionFor, type IndexedAttestation } from "./indexed";
import { attestationSource } from "./labels";
import { RecheckRequest } from "./RecheckRequest";
import { WarningMark } from "@/components/WarningMark";

/** What getTranslations hands back, so a row can be given one rather than await its own. */
type Translate = Awaited<ReturnType<typeof getTranslations>>;

/**
 * The trust story, and the loudest block on the page.
 *
 * Anyone can claim their own image is theirs. What makes this a passport is
 * that a second party fetched the picture, hashed it again and wrote the answer
 * back on chain. The two fingerprints are drawn as the 64 bits they are, so
 * "0 of 64 bits apart" is something a reader can see rather than a number they
 * have to trust, and the bits are counted here off the chain's own two values
 * rather than copied from the receiver's word.
 */
export async function Attestations({
  attestations,
  indexed,
  phash,
  locale,
  sealed = false,
  privateCopy,
}: {
  attestations: Attestation[];
  indexed: IndexedAttestation[];
  /** The fingerprint the registry stored when this picture was registered. */
  phash: bigint;
  locale: string;
  /**
   * True when this passport's picture was never published. A re-check works by
   * fetching the picture from its own address, so there is nothing here for a
   * workflow to do, and saying it has not happened yet would read as a fault
   * rather than as the record its creator asked for.
   */
  sealed?: boolean;
  /**
   * Set only for a sealed passport whose creator asked for the private
   * re-check: whether Moolam still keeps the small copy that re-check runs on.
   * Unknown is its own answer and is never drawn as kept or as gone.
   */
  privateCopy?: SealedCopyLookup["state"];
}) {
  const t = await getTranslations("passport.attestations");
  const sealedWords = await getTranslations("passport.sealed");
  const common = await getTranslations("common");
  const marks = await getTranslations("mark");
  const format = await getFormatter({ locale });

  // A sealed picture can be re-checked only from the private copy, so the
  // control is offered on one while that copy is kept and never otherwise.
  const offerRecheck = !sealed || privateCopy === "kept";
  const copyLine = sealed && privateCopy !== undefined ? sealedWords(`privateCopy.${privateCopy}`) : null;
  const newest = attestations.reduce<bigint | null>(
    (latest, attestation) => (latest === null || attestation.at > latest ? attestation.at : latest),
    null,
  );
  const recheckedOn = newest === null ? null : format.dateTime(new Date(Number(newest) * 1000), { dateStyle: "medium" });

  // Which forwarder carried each report is a chain read, so it is done here,
  // once per row, rather than inside a row that the list has already resolved.
  const rows = await Promise.all(
    attestations.map(async (attestation) => {
      const txHash = transactionFor(indexed, attestation);
      return {
        attestation,
        txHash,
        delivery: txHash === undefined ? ("unknown" as ReportDelivery) : await heldReportDelivery(txHash),
      };
    }),
  );

  return (
    // The verify card's "See the second opinion" link lands here. The margin is
    // the fixed header's own height, so the heading clears the bar instead of
    // sitting behind it.
    <section
      id="second-opinion"
      style={{ scrollMarginTop: "calc(var(--header-h) + 1rem)" }}
      className="border-y border-line bg-bg-raised"
    >
      <div className="mx-auto w-full max-w-[1400px] px-5 py-14 sm:px-8 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
          <div className="rise">
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("kicker")}</p>
            <h2 className="mt-5 max-w-[15ch] font-display text-[clamp(1.8rem,4vw,3.2rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
              {t("heading")}
            </h2>
            {/* A sealed picture has no public file for anyone to fetch, so its
                intro says what the private check really does. */}
            <p className="mt-5 max-w-[54ch] text-base leading-relaxed text-text-muted">
              {sealed ? t("sealedBody") : t("body")}
            </p>
          </div>

          <div className="rise" style={{ animationDelay: "90ms" }}>
            {/* A plain sealed passport gets no button: there is no published
                picture for a workflow to fetch, and the block says so in those
                words. One that asked for the private re-check says where its
                copy stands instead. */}
            {attestations.length === 0 ? (
              <div className="max-w-[52ch] border-s-2 border-line ps-5">
                {sealed ? (
                  <>
                    <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
                      <span className="motif h-[9px] w-[9px]" />
                      {sealedWords("label")}
                    </p>
                    <p data-private-copy={privateCopy} className="mt-4 text-base leading-relaxed text-text-muted">
                      {copyLine ?? sealedWords("recheck")}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-base leading-relaxed text-text-muted">{t("empty")}</p>
                    <p className="mt-4 text-base leading-relaxed text-text-faint">{t("whatIsRecheck")}</p>
                  </>
                )}
              </div>
            ) : (
              <ul className="space-y-px bg-line">
                {rows.map(({ attestation, txHash, delivery }, index) => (
                  <Row
                    key={`${attestation.receiver}-${attestation.at}-${index}`}
                    attestation={attestation}
                    phash={phash}
                    t={t}
                    common={common}
                    marks={marks}
                    txHash={txHash}
                    delivery={delivery}
                    privateCopy={privateCopy}
                    when={format.dateTime(new Date(Number(attestation.at) * 1000), "moment")}
                    clock={format.dateTime(new Date(Number(attestation.at) * 1000), "time")}
                  />
                ))}
              </ul>
            )}

            {offerRecheck ? (
              <RecheckRequest
                className="mt-8 border-t border-line pt-7"
                sealed={sealed}
                recheckedOn={recheckedOn}
                tuck
              />
            ) : attestations.length > 0 && copyLine !== null ? (
              // Under earlier verdicts the control's place says why there is
              // no control now, so a deleted copy reads as a choice, not a fault.
              <p data-private-copy={privateCopy} className="mt-8 max-w-[54ch] border-t border-line pt-7 text-base leading-relaxed text-text-muted">
                {copyLine}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * One re-check. The two translators are handed down rather than asked for
 * again: a row that awaits its own would make every row a suspending component
 * inside a list its parent has already resolved.
 */
function Row({
  attestation,
  phash,
  txHash,
  delivery,
  privateCopy,
  when,
  clock,
  t,
  common,
  marks,
}: {
  attestation: Attestation;
  phash: bigint;
  txHash?: `0x${string}`;
  /** Which forwarder the report came through, read off its transaction. */
  delivery: ReportDelivery;
  /** Whether Moolam still keeps the private copy a private verdict was read from. */
  privateCopy?: SealedCopyLookup["state"];
  when: string;
  /** The time of day and its zone, as they appear inside `when`. */
  clock: string;
  t: Translate;
  common: Translate;
  marks: Translate;
}) {
  const source = attestationSource(attestation.receiver);
  // Written only by the confidential workflow that reads Moolam's private copy
  // of a sealed picture, so it is named for that and for where it really ran.
  const isPrivate = isPrivateRecheck(attestation.receiver);
  // A writer this app cannot name keeps its row and its numbers, in words that
  // claim nothing about who ran it or how.
  const unknown = source === "other";

  const recomputed = phashWord(attestation.recomputed);
  const registeredBits = bitsOf(phash);
  const recomputedBits = bitsOf(recomputed);
  // Counted here off the two fingerprints the chain holds. The receiver's own
  // figure is shown beside it, so a disagreement would be visible rather than
  // hidden behind whichever one the page chose to print.
  const counted = bitsApart(phash, recomputed);

  return (
    <li className="bg-bg p-6 sm:p-8">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <p className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] ${attestation.matched ? "text-verified" : "text-failed"}`}>
          {attestation.matched ? <span aria-hidden className="motif h-2 w-2 bg-verified" /> : <WarningMark />}
          {attestation.matched ? t("matched") : t("notMatched")}
        </p>
        {isPrivate ? (
          <p data-private-badge className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span aria-hidden className="motif h-[9px] w-[9px]" />
            {t("private.badge")}
          </p>
        ) : null}
        {/* A run in Chainlink's simulator is a test run: it keeps its row and
            its numbers here and never turns on the trust mark (L30). */}
        {source === "chainlink" && delivery === "simulation" ? (
          <p
            data-test-run
            className="rounded-[6px] border border-line-strong px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted"
          >
            {marks("simulator.word")}
          </p>
        ) : null}
      </div>

      {/* What happened leads and the limit follows it, once. "Keeps" is said
          only while the copy is known to be kept: a verdict outlives the copy
          it was read from. A report the network forwarder delivered did not run
          in the simulator, so it is not told that it did. */}
      {isPrivate ? (
        <>
          <p
            data-private-lead
            className="mt-5 max-w-[40ch] font-display text-[clamp(1.1rem,2.1vw,1.55rem)] font-semibold leading-[1.15] tracking-[-0.02em]"
          >
            {privateCopy === "kept" ? t("private.lead") : t("private.leadEarlier")}
          </p>
          {delivery === "network" ? null : (
            <p data-private-limit className="mt-3 max-w-[52ch] text-base leading-relaxed text-text-muted">
              {t("private.limit")}
            </p>
          )}
        </>
      ) : (
        <p className="mt-5 max-w-[24ch] font-display text-[clamp(1.3rem,2.6vw,2rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
          {unknown ? t("unknown.lead") : t("byChainlink")}
        </p>
      )}

      {/* Two equal columns rather than a flex row: the captions are different
          lengths, and a pair of fingerprints drawn at different sizes reads as
          two unrelated things. They stay side by side on a phone too, so the
          pair is read as one comparison rather than a screen and a half of
          cells. The feet line up, so captions that wrap differently never
          set one grid lower than the other. */}
      <div data-grid-pair className="mt-8 grid max-w-[30rem] grid-cols-2 items-end gap-x-5 sm:gap-x-10">
        <BitGrid bits={registeredBits} label={t("registeredGrid")} tone="original" />
        <BitGrid bits={recomputedBits} against={registeredBits} label={unknown ? t("unknown.recomputedGrid") : t("recomputedGrid")} tone="recomputed" />
      </div>

      <p className="mt-8 max-w-[44ch] font-display text-[clamp(1.1rem,2.4vw,1.7rem)] font-semibold leading-[1.15] tracking-[-0.03em]">
        {t.rich(isPrivate ? "private.verdict" : unknown ? "unknown.verdict" : "verdict", {
          bits: counted,
          apart: (chunks) => <span className={counted === 0 ? "text-verified" : "text-failed"}>{chunks}</span>,
        })}
      </p>

      {/* The chain's own answer on how this report arrived. An address the app
          does not recognise says nothing at all, because a wrong label here
          would be worse than no label. A private re-check in the simulator
          already said so in its limit line, in plainer words, so it is not
          told twice. Anyone can send a report through the simulation
          forwarder, so for a writer the app cannot name, which forwarder
          carried it says nothing about Chainlink and is left out. */}
      {unknown || delivery === "unknown" || (isPrivate && delivery === "simulation") ? null : (
        <p className="mt-5 max-w-[52ch] border-s-2 border-line ps-4 text-base leading-relaxed text-text-faint">
          {delivery === "simulation" ? marks("simulator.line") : t("delivery.network")}
        </p>
      )}

      <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-3">
        <Field label={unknown ? t("unknown.distanceLabel") : t("distanceLabel")} value={t("distance", { distance: attestation.distance })} />
        <Field label={t("at")} value={when} clock={clock} />
        <Field label={unknown ? t("unknown.field") : t("receiver")} value={shortHex(attestation.receiver)} href={`${MONAD_EXPLORER}/address/${attestation.receiver}`} />
      </dl>

      {/* When this row wraps, which it does on a phone, the two links need
          enough air between them that their 44 px targets do not overlap and
          take each other's taps. */}
      <div className="tap-row mt-6 flex flex-wrap items-center gap-x-6 gap-y-5">
        {txHash === undefined ? (
          <p className="font-mono text-[11px] text-text-faint">{t("noTransaction")}</p>
        ) : (
          <a
            href={`${MONAD_EXPLORER}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {withHex(t("openTx", { hash: HEX_MARK }), shortHex(txHash))}
          </a>
        )}
        {source === "chainlink" ? (
          <a
            href={`${MONAD_EXPLORER}/address/${attestation.receiver}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:text-accent"
          >
            {common("explorer")}
          </a>
        ) : null}
      </div>

      <p className="mt-5 max-w-[56ch] border-t border-line pt-5 text-xs leading-relaxed text-text-faint">
        {isPrivate ? t("private.gridNote") : unknown ? t("unknown.gridNote") : t("gridNote")}
      </p>
    </li>
  );
}

/**
 * A date split around its time of day, so the time and its zone can be kept on
 * one line while the date wraps before them. Null when the clock is not found
 * inside the date, which leaves the whole date to wrap at its spaces.
 */
export function splitClock(value: string, clock: string): { before: string; clock: string; after: string } | null {
  const at = clock === "" ? -1 : value.lastIndexOf(clock);
  return at === -1 ? null : { before: value.slice(0, at), clock, after: value.slice(at + clock.length) };
}

/**
 * One fact under a re-check. An address may break anywhere so it never pushes
 * the row wider than its column. A date is words: it wraps at its spaces, and
 * never inside "3:49 PM UTC", which broke as "U / TC" when it was set like an
 * address.
 */
function Field({ label, value, href, clock }: { label: string; value: string; href?: string; clock?: string }) {
  const split = clock === undefined ? null : splitClock(value, clock);

  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`tap-row mt-1.5 font-mono text-sm ${clock === undefined ? "break-all" : "break-words"}`}>
        {split !== null ? (
          <>
            {split.before}
            <span data-clock className="whitespace-nowrap">
              {split.clock}
            </span>
            {split.after}
          </>
        ) : href === undefined ? (
          value
        ) : (
          <a href={href} target="_blank" rel="noreferrer" className="transition-colors duration-200 hover:text-accent">
            {value}
          </a>
        )}
      </dd>
    </div>
  );
}
