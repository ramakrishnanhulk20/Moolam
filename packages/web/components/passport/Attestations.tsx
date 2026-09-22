import { getFormatter, getTranslations } from "next-intl/server";
import { BitGrid } from "@/components/BitGrid";
import { MONAD_EXPLORER, addresses, shortHex } from "@/lib/chain/client";
import { bitsApart, bitsOf, phashWord } from "@/lib/chain/fingerprint";
import type { Attestation } from "@/lib/chain/registry";
import { heldReportDelivery, type ReportDelivery } from "@/lib/chain/reports";
import { transactionFor, type IndexedAttestation } from "./indexed";
import { attestationSource } from "./labels";
import { RecheckRequest } from "./RecheckRequest";

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
}) {
  const t = await getTranslations("passport.attestations");
  const sealedWords = await getTranslations("passport.sealed");
  const common = await getTranslations("common");
  const format = await getFormatter({ locale });

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
            <p className="mt-5 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("body")}</p>
          </div>

          <div className="rise" style={{ animationDelay: "90ms" }}>
            {/* A sealed passport gets no button: there is no published picture
                for a workflow to fetch, and the block above has already said so
                in those words. */}
            {attestations.length === 0 ? (
              <div className="max-w-[52ch] border-s-2 border-line ps-5">
                {sealed ? (
                  <>
                    <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
                      <span className="motif h-[9px] w-[9px]" />
                      {sealedWords("label")}
                    </p>
                    <p className="mt-4 text-sm leading-relaxed text-text-muted">{sealedWords("recheck")}</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm leading-relaxed text-text-muted">{t("empty")}</p>
                    <p className="mt-4 text-sm leading-relaxed text-text-faint">{t("whatIsRecheck")}</p>
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
                    txHash={txHash}
                    delivery={delivery}
                    when={format.dateTime(new Date(Number(attestation.at) * 1000), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  />
                ))}
              </ul>
            )}

            {sealed ? null : <RecheckRequest className="mt-8 border-t border-line pt-7" />}
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
  when,
  t,
  common,
}: {
  attestation: Attestation;
  phash: bigint;
  txHash?: `0x${string}`;
  /** Which forwarder the report came through, read off its transaction. */
  delivery: ReportDelivery;
  when: string;
  t: Translate;
  common: Translate;
}) {
  const source = attestationSource(attestation.receiver);

  const recomputed = phashWord(attestation.recomputed);
  const registeredBits = bitsOf(phash);
  const recomputedBits = bitsOf(recomputed);
  // Counted here off the two fingerprints the chain holds. The receiver's own
  // figure is shown beside it, so a disagreement would be visible rather than
  // hidden behind whichever one the page chose to print.
  const counted = bitsApart(phash, recomputed);

  return (
    <li className="bg-bg p-6 sm:p-8">
      <p className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] ${attestation.matched ? "text-verified" : "text-failed"}`}>
        <span aria-hidden className={`h-2 w-2 ${attestation.matched ? "bg-verified" : "bg-failed"}`} />
        {attestation.matched ? t("matched") : t("notMatched")}
      </p>

      <p className="mt-5 max-w-[24ch] font-display text-[clamp(1.3rem,2.6vw,2rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
        {source === "chainlink" ? t("byChainlink") : t("byReceiver")}
      </p>

      {/* Two equal columns rather than a flex row: the captions are different
          lengths, and a pair of fingerprints drawn at different sizes reads as
          two unrelated things. They stack on a phone. */}
      <div className="mt-8 grid max-w-[30rem] items-start gap-x-10 gap-y-8 sm:grid-cols-2">
        <BitGrid bits={registeredBits} label={t("registeredGrid")} tone="original" />
        <BitGrid bits={recomputedBits} against={registeredBits} label={t("recomputedGrid")} tone="recomputed" />
      </div>

      <p className="mt-8 max-w-[44ch] font-display text-[clamp(1.1rem,2.4vw,1.7rem)] font-semibold leading-[1.15] tracking-[-0.03em]">
        {t.rich("verdict", {
          bits: counted,
          apart: (chunks) => <span className={counted === 0 ? "text-verified" : "text-failed"}>{chunks}</span>,
        })}
      </p>

      {/* The chain's own answer on how this report arrived. An address the app
          does not recognise says nothing at all, because a wrong label here
          would be worse than no label. */}
      {delivery === "unknown" ? null : (
        <p className="mt-5 max-w-[52ch] border-s-2 border-line ps-4 text-xs leading-relaxed text-text-faint">
          {delivery === "simulation" ? t("delivery.simulation") : t("delivery.network")}
        </p>
      )}

      <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-3">
        <Field label={t("distanceLabel")} value={t("distance", { distance: attestation.distance })} />
        <Field label={t("at")} value={when} />
        <Field label={t("receiver")} value={shortHex(attestation.receiver)} href={`${MONAD_EXPLORER}/address/${attestation.receiver}`} />
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
            {t("openTx", { hash: shortHex(txHash) })}
          </a>
        )}
        {source === "chainlink" ? (
          <a
            href={`${MONAD_EXPLORER}/address/${addresses.receiver}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:text-accent"
          >
            {common("explorer")}
          </a>
        ) : null}
      </div>

      <p className="mt-5 max-w-[56ch] border-t border-line pt-5 text-xs leading-relaxed text-text-faint">
        {t("gridNote")}
      </p>
    </li>
  );
}

function Field({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="tap-row mt-1.5 break-all font-mono text-sm">
        {href === undefined ? (
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
